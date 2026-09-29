/** Canonical preparation of a private candidate. No HEAD, index, State, lease or
 * delivery mutation is authorized by this evidence. Partial publication stays closed. */
import type { WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { readLocalGitPublicationHistory } from './local-git-publish';
import { LocalGitVersionStore } from './local-git-version-store';
import type { LocalGitWorkspaceOptions } from './local-git-workspaces';
import {
  type ApplicationRequest,
  readCompletedApplication,
  readConfirmedApplicationPrefix,
} from './local-integration-application-records';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import type { LocalIntegrationSources } from './local-integration-sources';
import type { LocalIntegrationTreeBatch } from './local-integration-tree-batch';
import type { LocalMergeCandidate, LocalMergeCandidates } from './local-merge-candidates';
import { localRecordHash } from './local-registry-records';
import type {
  ValidationPreparationProofReader,
  ValidationPreparationReference,
} from './local-validation-preparation-control';
import type { LocalVersionScope, LocalVersionStore } from './local-version-store';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type Request = { call: LocalIntegrationCall; actionId: string };
type Sources = Awaited<ReturnType<LocalIntegrationSources['readNext']>>;
type Prepared = Request & {
  schemaVersion: 'local-integration-candidate-input-v1';
  gitOptions: LocalGitWorkspaceOptions;
  registryRevision: number;
  stateHash: string;
  sources: Sources;
  targetVersion: WorkspaceVersionV1;
};
export type LocalIntegrationCandidate = {
  schemaVersion: 'local-integration-candidate-v1';
  predecessor?: { inputHash: string; resultHash: string; confirmationHash: string };
  inputHash: string;
  sources: Sources;
  targetVersion: WorkspaceVersionV1;
  candidate: LocalMergeCandidate;
};
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const phase = (key: string, stage: string) =>
  localRecordHash({ kind: 'integration-candidate', key, stage });
export class LocalIntegrationCandidates {
  private readonly git: LocalGitWorkspaceOptions;
  private readonly gitVersions: LocalGitVersionStore;
  constructor(
    private readonly options: {
      authority: LocalIntegrationAuthority;
      sources: LocalIntegrationSources;
      candidates: LocalMergeCandidates;
      objects: LocalControlObjects;
      versions: LocalVersionStore;
      gitOptions: LocalGitWorkspaceOptions;
      historyBatches?: LocalIntegrationTreeBatch;
    },
  ) {
    this.git = structuredClone(options.gitOptions);
    this.gitVersions = new LocalGitVersionStore(options.objects, options.versions);
  }
  /** Reuse the original proof readers with a completion-bound read-only authority. */
  completionReader(call: LocalIntegrationCall) {
    const authority = this.options.authority.completionReader(call);
    return this.withReader(authority);
  }
  handoffReader(call: LocalIntegrationCall) {
    return this.withReader(this.options.authority.handoffReader(call));
  }
  preparationReader(
    call: LocalIntegrationCall,
    control: ValidationPreparationProofReader,
    reference: ValidationPreparationReference,
  ) {
    return this.withReader(this.options.authority.preparationReader(call, control, reference));
  }
  private withReader(authority: LocalIntegrationAuthority) {
    return new LocalIntegrationCandidates({
      ...this.options,
      authority,
      sources: this.options.sources.withAuthority(authority),
      ...(this.options.historyBatches
        ? { historyBatches: this.options.historyBatches.withAuthority(authority) }
        : {}),
    });
  }
  async prepareNext(input: Request): Promise<LocalIntegrationCandidate> {
    return this.request(input, false);
  }
  /** Verify the original candidate after file effects, while Git and canonical
   * control still name the original target. This never prepares missing work. */
  async readPrepared(input: Request): Promise<LocalIntegrationCandidate> {
    return this.request(input, true);
  }
  async readPublished(request: ApplicationRequest): Promise<LocalIntegrationCandidate> {
    const proof = await readCompletedApplication(this.options.objects, request);
    const input = { call: request.call, actionId: proof.prepared.candidateActionId };
    return serializeWorkspaceOperation(request.call, () =>
      this.prepare(input, true, structuredClone(request)),
    );
  }
  /** Authenticate every immutable predecessor; only the current authority admits
   * the physical HEAD. Historical evidence never supplies a caller-selected HEAD. */
  async readConfirmedPrefix(input: LocalIntegrationCall, inputPublished?: ApplicationRequest) {
    const call = structuredClone(input),
      published = inputPublished && structuredClone(inputPublished);
    const { objects, versions, authority, historyBatches } = this.options;
    const checkpoint = published
      ? await authority.readPublishedCheckpoint(published)
      : await authority.readCheckpoint(call);
    const anchor = published ? await readCompletedApplication(objects, published) : undefined;
    const state = anchor
      ? { ...checkpoint.state, integration: anchor.prepared.integration }
      : checkpoint.state;
    const prefix = await readConfirmedApplicationPrefix(objects, state, call);
    if (prefix.length && !historyBatches) throw Error('integration_history_unavailable');
    const { root, grant, record, workspace, authorize } = checkpoint;
    const scope = {
      projectId: call.projectId,
      taskId: call.taskId,
      rootId: root.rootId,
      policyHash: grant.policyHash,
    };
    for (const proof of prefix) {
      const { prepared } = proof;
      if (
        !equal(prepared.gitOptions, this.git) ||
        prepared.registryRevision !== checkpoint.snapshot.revision ||
        !equal(prepared.binding, checkpoint.binding) ||
        prepared.sourceReceiptId !== checkpoint.sourceReceiptId ||
        !equal(prepared.plan, {
          scope,
          baseline: prepared.candidate.targetVersion,
          current: prepared.candidate.targetVersion,
          artifact: prepared.candidate.candidate.version,
        })
      )
        throw Error('integration_application_evidence_changed');
      const candidate = await this.prepare(
        { call, actionId: prepared.candidateActionId },
        true,
        published,
        prepared.request,
      );
      if (
        !equal(candidate, prepared.candidate) ||
        !historyBatches ||
        !equal(
          await historyBatches.readHistorical(prepared.request, published),
          proof.effects.applied,
        )
      )
        throw Error('integration_application_evidence_changed');
      const sourceRecord = checkpoint.snapshot.linkedRoots?.find(
        (r) => r.workspaceId === candidate.sources.source.workspaceId,
      );
      if (!sourceRecord) throw Error('integration_source_mismatch');
      const manifest = await versions.read(candidate.candidate.version, scope);
      if (!proof.effects.applied.version) throw Error('integration_application_evidence_changed');
      const applied = await versions.read(proof.effects.applied.version, scope);
      const logical = (m: typeof manifest) => ({
        directories: m.directories.map((d) => d.path),
        files: m.files.map((f) => ({
          path: f.path,
          contentHash: f.contentHash,
          executable: f.version.executable,
        })),
      });
      if (!equal(logical(manifest), logical(applied)))
        throw Error('integration_application_evidence_changed');
      const publication = await readLocalGitPublicationHistory({
        ...this.git,
        ...scope,
        root: root.path,
        actionId: prepared.publishActionId,
        authorize,
        workspaceId: workspace.workspaceId,
        creationActionId: record.creation.actionId,
        sourceWorkspaceId: sourceRecord.workspaceId,
        sourceCreationActionId: sourceRecord.creation.actionId,
        candidate: candidate.candidate.candidate,
        applicationHash: proof.effectsHash,
        stagingIdentity: record.staging.identity,
        ...(await this.contents(candidate.candidate.version, scope)),
      });
      const git = await versions.readGitManifest(proof.result.version, scope);
      if (
        !equal(publication, proof.result.publication) ||
        !equal(git.filesVersion, proof.effects.applied.version) ||
        git.commit !== publication.commit ||
        git.tree !== publication.tree ||
        git.workspaceId !== workspace.workspaceId ||
        git.physicalHash !== localRecordHash(record) ||
        workspace.mode !== 'linked-worktree' ||
        git.branch !== workspace.branch ||
        git.commonDirId !== workspace.commonDirId
      )
        throw Error('integration_application_evidence_changed');
    }
    await authorize();
    if (!equal(await readConfirmedApplicationPrefix(objects, state, call), prefix))
      throw Error('integration_application_evidence_changed');
    return prefix;
  }
  private async request(input: Request, readOnly: boolean): Promise<LocalIntegrationCandidate> {
    localRecordHash(input);
    if (
      Object.keys(input).sort().join(',') !== 'actionId,call' ||
      typeof input.actionId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.actionId)
    )
      throw Error('invalid_integration_candidate');
    const request = structuredClone(input);
    return serializeWorkspaceOperation(request.call, () => this.prepare(request, readOnly));
  }
  private async contents(version: WorkspaceVersionV1, scope: LocalVersionScope) {
    const manifest = await this.options.versions.read(version, scope);
    const files = [];
    for (const file of manifest.files)
      files.push({
        path: file.path,
        content: await this.options.objects.getBytes(file.contentHash),
        executable: file.version.executable,
      });
    return { files, directories: manifest.directories.map((d) => d.path).filter(Boolean) };
  }
  private async prepare(
    request: Request,
    readOnly: boolean,
    published?: ApplicationRequest,
    historical?: ApplicationRequest,
  ): Promise<LocalIntegrationCandidate> {
    const { authority, sources, objects, candidates, versions } = this.options;
    const { call, actionId } = request;
    const key = localRecordHash({
      kind: 'integration-candidate',
      projectId: call.projectId,
      taskId: call.taskId,
      actionId,
    });
    const preparedKey = phase(key, 'prepared'),
      resultKey = phase(key, 'result');
    const completionKey = phase(key, 'completion'),
      invalidKey = phase(key, 'invalid');
    const priorHash = await objects.getReference(preparedKey);
    if (
      (await objects.getReference(invalidKey)) ||
      (readOnly &&
        (!priorHash ||
          !(await objects.getReference(resultKey)) ||
          !(await objects.getReference(completionKey))))
    )
      throw Error('integration_candidate_recovery_required');
    const admission = () =>
      published ? authority.readPublishedCheckpoint(published) : authority.readCheckpoint(call);
    const readSources = () =>
      historical
        ? sources.readHistorical(historical, published)
        : published
          ? sources.readPublished(published)
          : sources.readNext(call);
    const checkpoint = await admission();
    const proofRequest = historical ?? published;
    const proof = proofRequest ? await readCompletedApplication(objects, proofRequest) : undefined;
    const { authorize, root, record, workspace } = checkpoint;
    const scope = {
      projectId: call.projectId,
      taskId: call.taskId,
      rootId: root.rootId,
      policyHash: checkpoint.grant.policyHash,
    };
    const selected = await readSources();
    await authorize();
    const prefixState = proof
      ? { ...checkpoint.state, integration: proof.prepared.integration }
      : checkpoint.state;
    const prefix = await readConfirmedApplicationPrefix(objects, prefixState, call);
    const parent = prefix[0];
    const predecessor = parent
      ? {
          inputHash: parent.inputHash,
          resultHash: parent.resultHash,
          confirmationHash: parent.confirmationHash,
        }
      : undefined;
    if (
      selected.selection.position !== prefix.length ||
      (selected.selection.target.headCommit ?? selected.selection.target.baseCommit) !==
        (parent?.result.publication.commit ?? selected.baseline.baseCommit)
    )
      throw Error('integration_candidate_source_unavailable');
    if (parent && !historical) await this.readConfirmedPrefix(call, published);
    const target = {
      ...this.git,
      projectId: call.projectId,
      taskId: call.taskId,
      root: root.path,
      sourceRoot: root,
      workspace,
      record,
      expectedHead: selected.selection.target.headCommit ?? selected.selection.target.baseCommit,
      actionId: record.initialization.actionId,
      creationActionId: record.creation.actionId,
      bindingReceiptId: record.bindingReceiptId,
      authorize,
    };
    let targetVersion: WorkspaceVersionV1;
    if (priorHash) {
      const prior = (await objects.get(priorHash)) as Prepared;
      targetVersion = prior.targetVersion;
      if (!(await objects.getReference(completionKey)))
        throw Error('integration_candidate_recovery_required');
      if (!readOnly) await this.gitVersions.verify(targetVersion, scope, target);
    } else {
      if ((await objects.getReference(resultKey)) || (await objects.getReference(completionKey)))
        throw Error('integration_candidate_recovery_required');
      if ((await objects.references()).length > 4088) throw Error('control_reference_limit');
      targetVersion = parent?.result.version ?? (await this.gitVersions.capture(scope, target));
      if (parent) await this.gitVersions.verify(targetVersion, scope, target);
    }
    const prepared: Prepared = {
      schemaVersion: 'local-integration-candidate-input-v1',
      ...request,
      gitOptions: this.git,
      registryRevision: checkpoint.snapshot.revision,
      stateHash: proof?.prepared.stateHash ?? localRecordHash(checkpoint.state),
      sources: selected,
      targetVersion,
    };
    const targetFiles = await versions.read(targetVersion, scope);
    if (
      !equal(
        targetFiles.directories.map((d) => d.path),
        (parent
          ? await versions.read(parent.result.version, scope)
          : selected.baseline.manifest
        ).directories.map((d) => d.path),
      )
    )
      throw Error('integration_target_changed');
    if (parent && !equal(targetVersion, parent.result.version))
      throw Error('integration_target_changed');
    const inputHash = localRecordHash(prepared);
    if (priorHash && priorHash !== inputHash) throw Error('operation_conflict');
    await authorize();
    if (!priorHash) await objects.bindReference(preparedKey, await objects.put(prepared));
    const sourceRecord = checkpoint.snapshot.linkedRoots?.find(
      (r) => r.workspaceId === selected.source.workspaceId,
    );
    if (!sourceRecord) throw Error('integration_source_mismatch');
    const targetManifest = await versions.readGitManifest(targetVersion, scope);
    if (
      targetManifest.workspaceId !== workspace.workspaceId ||
      targetManifest.physicalHash !== localRecordHash(record) ||
      targetManifest.commit !== target.expectedHead ||
      workspace.mode !== 'linked-worktree' ||
      targetManifest.commonDirId !== workspace.commonDirId ||
      targetManifest.branch !== workspace.branch
    )
      throw Error('workspace_version_scope_mismatch');
    const merge = {
      ...this.git,
      projectId: call.projectId,
      taskId: call.taskId,
      root: root.path,
      actionId: `merge:${key}`,
      authorize,
      baseline: {
        commit: selected.baseline.baseCommit,
        ...(await this.contents(selected.baseline.version, scope)),
      },
      target: {
        workspaceId: workspace.workspaceId,
        creationActionId: record.creation.actionId,
        head: target.expectedHead,
        stagingIdentity: record.staging.identity,
        ...(await this.contents(targetManifest.filesVersion, scope)),
      },
      source: {
        workspaceId: selected.source.workspaceId,
        creationActionId: sourceRecord.creation.actionId,
        head: selected.source.worktree.headCommit ?? selected.source.worktree.baseCommit,
        stagingIdentity: sourceRecord.staging.identity,
        ...(await this.contents(selected.source.version, scope)),
      },
    };
    const verify = async () => {
      await authorize();
      if (!equal(await readSources(), selected)) throw Error('integration_selection_changed');
      if (readOnly) await admission();
      else await this.gitVersions.verify(targetVersion, scope, target);
      await authorize();
    };
    const savedResultHash = readOnly ? await objects.getReference(resultKey) : undefined;
    const savedResult = savedResultHash
      ? ((await objects.get(savedResultHash)) as LocalIntegrationCandidate)
      : undefined;
    if (
      readOnly &&
      (!savedResult ||
        savedResult.inputHash !== inputHash ||
        !equal(savedResult.sources, selected) ||
        !equal(savedResult.targetVersion, targetVersion))
    )
      throw Error('integration_candidate_recovery_required');
    const candidate = savedResult
      ? await candidates.readCompleted({
          receipt: savedResult.candidate,
          git: {
            ...this.git,
            ...scope,
            root: root.path,
            actionId: `read-candidate:${key}`,
            authorize,
          },
        })
      : await candidates.materialize({ scope, actionId: `candidate:${key}`, merge });
    if (
      candidate.actionId !== `candidate:${key}` ||
      !equal(candidate.scope, scope) ||
      candidate.candidate.actionId !== `merge:${key}` ||
      candidate.candidate.targetHead !== target.expectedHead ||
      candidate.candidate.sourceHead !== merge.source.head
    )
      throw Error('integration_candidate_recovery_required');
    const result: LocalIntegrationCandidate = {
      schemaVersion: 'local-integration-candidate-v1',
      ...(predecessor ? { predecessor } : {}),
      inputHash,
      sources: selected,
      targetVersion,
      candidate,
    };
    const resultHash = localRecordHash(result);
    const completed = {
      schemaVersion: 'local-integration-candidate-completed-v1',
      inputHash,
      resultHash,
    };
    if (priorHash) {
      const saved = await objects.getReference(resultKey),
        marker = await objects.getReference(completionKey);
      if (saved !== resultHash || !marker || !equal(await objects.get(marker), completed))
        throw Error('integration_candidate_recovery_required');
      await verify();
      return result;
    }
    let resultPublished = false;
    try {
      await verify();
      await objects.bindReference(resultKey, await objects.put(result));
      resultPublished = true;
      await verify();
      await objects.bindReference(completionKey, await objects.put(completed));
      await verify();
      return result;
    } catch (error) {
      if (resultPublished)
        await objects.bindReference(
          invalidKey,
          await objects.put({
            schemaVersion: 'local-integration-candidate-invalid-v1',
            inputHash,
            resultHash,
          }),
        );
      throw error;
    }
  }
}
