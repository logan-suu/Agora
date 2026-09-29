/** Trusted publication and completed-publication acknowledgement. The caller owns
 * the serial task queue. Partial file/Git recovery and delivery remain closed. */
import {
  type AppState,
  type Mutation,
  selectIntegrationBranch,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import {
  type LocalGitPublicationReceipt,
  publishLocalGitCandidate,
  readLocalGitPublication,
} from './local-git-publish';
import { LocalGitVersionStore } from './local-git-version-store';
import type { LocalGitWorkspaceOptions } from './local-git-workspaces';
import {
  type ApplicationPrepared,
  applicationAction,
  applicationPhase,
  applicationSlot,
  checkApplicationState,
  readCompletedApplication,
} from './local-integration-application-records';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import type { LocalIntegrationCandidates } from './local-integration-candidates';
import type { LocalIntegrationTreeBatch } from './local-integration-tree-batch';
import { localRecordHash } from './local-registry-records';
import type { LocalFileManifest, LocalVersionStore } from './local-version-store';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type Request = { call: LocalIntegrationCall; actionId: string };
export type LocalIntegrationPublicationReceipt = {
  schemaVersion: 'local-integration-application-result-v1';
  inputHash: string;
  effectsHash: string;
  publication: LocalGitPublicationReceipt;
  version: WorkspaceVersionV1;
};
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const phase = applicationPhase;
const logical = (m: LocalFileManifest) => ({
  directories: m.directories.map((d) => d.path).filter(Boolean),
  files: m.files.map(({ path, version }) => ({
    path,
    sha256: version.sha256,
    size: version.size,
    executable: version.executable,
  })),
});

export class LocalIntegrationPublication {
  private readonly git: LocalGitWorkspaceOptions;
  private readonly gitVersions: LocalGitVersionStore;
  constructor(
    private readonly options: {
      control: LocalBindingCoordinator;
      authority: LocalIntegrationAuthority;
      candidates: LocalIntegrationCandidates;
      batches: LocalIntegrationTreeBatch;
      objects: LocalControlObjects;
      versions: LocalVersionStore;
      gitOptions: LocalGitWorkspaceOptions;
      state?: {
        compareAndCommit(
          scope: { projectId: string; taskId: string },
          expected: AppState,
          mutations: readonly Mutation[],
        ): Promise<{ state: AppState; changed: boolean }>;
      };
    },
  ) {
    this.git = structuredClone(options.gitOptions);
    this.gitVersions = new LocalGitVersionStore(options.objects, options.versions);
  }
  async applyNext(input: Request): Promise<LocalIntegrationPublicationReceipt> {
    localRecordHash(input);
    if (
      Object.keys(input).sort().join(',') !== 'actionId,call' ||
      typeof input.actionId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.actionId)
    )
      throw Error('invalid_integration_application');
    const request = structuredClone(input);
    // The child services serialize their physical workspace. A distinct outer
    // queue prevents recursive acquisition and serializes all application stages.
    return serializeWorkspaceOperation(
      { ...request.call, workspaceId: `application:${request.call.integrationId}` },
      () => this.execute(request),
    );
  }
  /** Explicitly confirm a fully completed publication. Never repeat file/Git effects. */
  async acknowledgePublished(input: Request): Promise<LocalIntegrationPublicationReceipt> {
    localRecordHash(input);
    const request = structuredClone(input);
    return serializeWorkspaceOperation(
      { ...request.call, workspaceId: `application:${request.call.integrationId}` },
      () => this.acknowledge(request),
    );
  }
  private async acknowledge(request: Request): Promise<LocalIntegrationPublicationReceipt> {
    const { objects, authority, candidates, batches, versions, state } = this.options;
    if (!state) throw Error('integration_state_confirmation_unavailable');
    const proof = await readCompletedApplication(objects, request);
    const { key, prepared, result, resultHash, inputHash } = proof;
    const verify = async () => {
      const checkpoint = await authority.readPublishedCheckpoint(request);
      if (
        !equal(await readCompletedApplication(objects, request), proof) ||
        !equal(await candidates.readPublished(request), prepared.candidate) ||
        !equal(await batches.readPublished(request), proof.effects.applied)
      )
        throw Error('integration_application_evidence_changed');
      const { root, record, workspace, authorize } = checkpoint;
      const scope = {
        projectId: request.call.projectId,
        taskId: request.call.taskId,
        rootId: root.rootId,
        policyHash: checkpoint.grant.policyHash,
      };
      if (!equal(prepared.plan.scope, scope))
        throw Error('integration_application_evidence_changed');
      const sourceRecord = checkpoint.snapshot.linkedRoots?.find(
        (r) => r.workspaceId === prepared.candidate.sources.source.workspaceId,
      );
      if (!sourceRecord) throw Error('integration_source_mismatch');
      const manifest = await versions.read(prepared.candidate.candidate.version, scope);
      if (
        !proof.effects.applied.version ||
        !equal(
          logical(await versions.read(proof.effects.applied.version, scope)),
          logical(manifest),
        )
      )
        throw Error('integration_application_evidence_changed');
      const files = [];
      for (const file of manifest.files)
        files.push({
          path: file.path,
          content: await objects.getBytes(file.contentHash),
          executable: file.version.executable,
        });
      const publication = await readLocalGitPublication({
        ...this.git,
        ...scope,
        root: root.path,
        actionId: prepared.publishActionId,
        authorize,
        workspaceId: workspace.workspaceId,
        creationActionId: record.creation.actionId,
        sourceWorkspaceId: sourceRecord.workspaceId,
        sourceCreationActionId: sourceRecord.creation.actionId,
        candidate: prepared.candidate.candidate.candidate,
        applicationHash: proof.effectsHash,
        stagingIdentity: record.staging.identity,
        files,
        directories: logical(manifest).directories,
      });
      if (!equal(publication, result.publication))
        throw Error('integration_application_evidence_changed');
      const gitManifest = await versions.readGitManifest(result.version, scope);
      if (
        !equal(gitManifest.filesVersion, proof.effects.applied.version) ||
        gitManifest.tree !== publication.tree
      )
        throw Error('integration_application_evidence_changed');
      await this.gitVersions.verify(result.version, scope, {
        ...this.git,
        ...scope,
        root: root.path,
        sourceRoot: root,
        workspace,
        record,
        expectedHead: publication.commit,
        actionId: record.initialization.actionId,
        creationActionId: record.creation.actionId,
        bindingReceiptId: record.bindingReceiptId,
        authorize,
      });
      await authorize();
      if (!equal(await readCompletedApplication(objects, request), proof))
        throw Error('integration_application_evidence_changed');
      return { checkpoint, states: await checkApplicationState(objects, checkpoint.state, proof) };
    };
    const verified = await verify();
    const { states } = verified;
    const planHash = localRecordHash(states.plan);
    const confirmation = {
      schemaVersion: 'local-integration-state-confirmed-v1',
      planHash,
      resultHash,
      stateHash: localRecordHash(states.after),
    };
    const saved = await objects.getReference(phase(key, 'state-confirmed'));
    if (saved) {
      if (states.mutations.length || !equal(await objects.get(saved), confirmation))
        throw Error('integration_application_recovery_required');
      return result;
    }
    if ((await objects.references()).length > 4093) throw Error('control_reference_limit');
    await verified.checkpoint.authorize();
    await objects.bindReference(phase(key, 'state-plan'), await objects.put(states.plan));
    await verified.checkpoint.authorize();
    let committed: { state: AppState; changed: boolean } | undefined;
    if (states.mutations.length) {
      // A thrown persistence result is uncertain. Keep the plan and re-read on an
      // explicit retry; do not invalidate a possibly durable canonical commit.
      committed = await state.compareAndCommit(request.call, states.before, states.mutations);
    }
    try {
      if (committed && (!committed.changed || !equal(committed.state, states.after)))
        throw Error('integration_state_confirmation_mismatch');
      const confirmed = await verify();
      if (confirmed.states.mutations.length) throw Error('integration_state_confirmation_mismatch');
      await objects.bindReference(phase(key, 'state-confirmed'), await objects.put(confirmation));
      await verify();
      return result;
    } catch (error) {
      await objects.bindReference(
        phase(key, 'state-invalid'),
        await objects.put({
          schemaVersion: 'local-integration-state-invalid-v1',
          inputHash,
          resultHash,
          planHash,
        }),
      );
      throw error;
    }
  }
  private async execute(request: Request): Promise<LocalIntegrationPublicationReceipt> {
    const { call } = request;
    const { control, authority, candidates, batches, objects, versions } = this.options;
    if (await objects.getReference(applicationAction(request)))
      throw Error('integration_application_recovery_required');
    const state = await control.assertClosed(call);
    const selection = selectIntegrationBranch(state, call.integrationId);
    const key = applicationSlot(call, selection);
    // Check the durable slot before live HEAD admission. Changing actionId must
    // not restart an application whose files or Git may already have changed.
    for (const stage of ['prepared', 'effects', 'result', 'completion', 'invalid'])
      if (await objects.getReference(phase(key, stage)))
        throw Error('integration_application_recovery_required');
    const checkpoint = await authority.readCheckpoint(call);
    if (!equal(checkpoint.state, state)) throw Error('integration_selection_changed');
    const { authorize, record, root, workspace } = checkpoint;
    const scope = {
      projectId: call.projectId,
      taskId: call.taskId,
      rootId: root.rootId,
      policyHash: checkpoint.grant.policyHash,
    };
    const candidateActionId = `candidate:${key}`,
      treeActionId = `apply:${key}`,
      publishActionId = `publish:${key}`;
    const candidate = await candidates.prepareNext({ call, actionId: candidateActionId });
    if (!equal(candidate.sources.selection, selection))
      throw Error('integration_selection_changed');
    const sourceRecord = checkpoint.snapshot.linkedRoots?.find(
      (r) => r.workspaceId === candidate.sources.source.workspaceId,
    );
    if (!sourceRecord) throw Error('integration_source_mismatch');
    const plan = {
      scope,
      baseline: candidate.targetVersion,
      current: candidate.targetVersion,
      artifact: candidate.candidate.version,
    };
    if (!state.integration) throw Error('integration_selection_changed');
    const prepared: ApplicationPrepared = {
      integration: structuredClone(state.integration),
      schemaVersion: 'local-integration-application-prepared-v1',
      request,
      selection,
      candidate,
      plan,
      candidateActionId,
      treeActionId,
      publishActionId,
      gitOptions: this.git,
      registryRevision: checkpoint.snapshot.revision,
      stateHash: localRecordHash(state),
      binding: checkpoint.binding,
      sourceReceiptId: checkpoint.sourceReceiptId,
    };
    const inputHash = localRecordHash(prepared);
    await authorize();
    if ((await objects.references()).length > 4087) throw Error('control_reference_limit');
    await objects.bindReference(phase(key, 'prepared'), await objects.put(prepared));
    await objects.bindReference(
      applicationAction(request),
      await objects.put({
        schemaVersion: 'local-integration-application-action-v1',
        key,
        inputHash,
      }),
    );
    const applied = await batches.apply(call, treeActionId, plan);
    if (applied.stage !== 'applied' || !applied.version)
      throw Error('integration_application_recovery_required');
    if (
      !equal(await candidates.readPrepared({ call, actionId: candidateActionId }), candidate) ||
      !equal(await batches.readApplied(call, treeActionId, plan), applied)
    )
      throw Error('integration_application_evidence_changed');
    const manifest = await versions.read(candidate.candidate.version, scope);
    if (!equal(logical(await versions.read(applied.version, scope)), logical(manifest)))
      throw Error('integration_application_evidence_changed');
    const effects = {
      schemaVersion: 'local-integration-application-effects-v1',
      inputHash,
      applied,
    };
    const effectsHash = await objects.put(effects);
    await objects.bindReference(phase(key, 'effects'), effectsHash);
    await authorize();
    const files = [];
    for (const file of manifest.files)
      files.push({
        path: file.path,
        content: await objects.getBytes(file.contentHash),
        executable: file.version.executable,
      });
    const publicationInput = {
      ...this.git,
      ...scope,
      root: root.path,
      actionId: publishActionId,
      authorize,
      workspaceId: workspace.workspaceId,
      creationActionId: record.creation.actionId,
      sourceWorkspaceId: sourceRecord.workspaceId,
      sourceCreationActionId: sourceRecord.creation.actionId,
      candidate: candidate.candidate.candidate,
      applicationHash: effectsHash,
      stagingIdentity: record.staging.identity,
      files,
      directories: logical(manifest).directories,
    };
    const publication = await publishLocalGitCandidate(publicationInput);
    const current = {
      ...this.git,
      ...scope,
      root: root.path,
      sourceRoot: root,
      workspace,
      record,
      expectedHead: publication.commit,
      actionId: record.initialization.actionId,
      creationActionId: record.creation.actionId,
      bindingReceiptId: record.bindingReceiptId,
      authorize,
    };
    const version = await this.gitVersions.capture(scope, current);
    const finalManifest = await versions.readGitManifest(version, scope);
    if (
      !equal(finalManifest.filesVersion, applied.version) ||
      finalManifest.tree !== publication.tree
    )
      throw Error('integration_application_evidence_changed');
    const result: LocalIntegrationPublicationReceipt = {
      schemaVersion: 'local-integration-application-result-v1',
      inputHash,
      effectsHash,
      publication,
      version,
    };
    const resultHash = localRecordHash(result);
    const verify = async () => {
      await authorize();
      if (
        (await objects.getReference(phase(key, 'prepared'))) !== inputHash ||
        (await objects.getReference(phase(key, 'effects'))) !== effectsHash ||
        (await objects.getReference(phase(key, 'invalid'))) ||
        !equal(await readLocalGitPublication(publicationInput), publication)
      )
        throw Error('integration_application_evidence_changed');
      await versions.verify(
        applied.version as WorkspaceVersionV1,
        scope,
        checkpoint.binding,
        authorize,
      );
      await this.gitVersions.verify(version, scope, current);
      await authorize();
    };
    let published = false;
    try {
      await verify();
      await objects.bindReference(phase(key, 'result'), await objects.put(result));
      published = true;
      await verify();
      await objects.bindReference(
        phase(key, 'completion'),
        await objects.put({
          schemaVersion: 'local-integration-application-completed-v1',
          inputHash,
          resultHash,
        }),
      );
      await verify();
      return result;
    } catch (error) {
      if (published)
        await objects.bindReference(
          phase(key, 'invalid'),
          await objects.put({
            schemaVersion: 'local-integration-application-invalid-v1',
            inputHash,
            resultHash,
          }),
        );
      throw error;
    }
  }
}
