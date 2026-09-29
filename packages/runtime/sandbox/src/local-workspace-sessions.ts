/** Trusted worker capability lifetime. No global scheduler, role routing or
 * Harness loop is implemented here: the runtime supplies a live lease closure. */

import type { AppState, WorkspaceCall, WorkspaceVersionV1, WorktreeRef } from '@agora/core-domain';
import {
  currentApprovedReviewId,
  currentCompletionEvidence,
  currentLocalCompletionEvidence,
  deliveryReaderAssignment,
  deliveryRepairAssignment,
  deriveCompletionResolution,
  isReviewBinding,
  isWorkspaceVersionV1,
  isWorktreeRef,
  validationReceipt,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import { readCompletedWorktree } from './local-completed-worktree';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalDeliveryCandidates } from './local-delivery-candidates';
import type { LocalDeliveryRepairs } from './local-delivery-repairs';
import { qualifyLocalExecution } from './local-execution-probe';
import { localFileArtifactKey, parseLocalFileArtifact } from './local-file-artifact';
import { type LocalFixedInput, LocalFixedInputs } from './local-fixed-inputs';
import { commitLocalGitWorktree } from './local-git-commit';
import type { LocalGitWorkspaceOptions } from './local-git-workspaces';
import type { LocalRegistryOwner } from './local-registry-file';
import {
  isLocalBindingOperation,
  type LocalClaimRecord,
  localRecordHash,
} from './local-registry-records';
import type { LocalRootCoordinator } from './local-root-coordinator';
import type { LocalVersionStore } from './local-version-store';
import { LocalWorkspaceApply } from './local-workspace-apply';
import { LocalWorkspaceAuthority, localRootBinding } from './local-workspace-authority';
import type { LocalCommandTools } from './local-workspace-commands';
import { LocalWorkspaceCommands } from './local-workspace-commands';
import { LocalWorkspaceFiles } from './local-workspace-files';
import { serializeWorkspaceOperation } from './local-workspace-operation';
import { bindLocalWorkspaceTools } from './local-workspace-tools';
import type { WorkspaceCommandRequest } from './workspace-port';
import type {
  WorkspaceControlSession,
  WorkspaceFileArtifact,
  WorkspaceValidationEvidencePort,
  WorkspaceWorkerAdmission,
  WorkspaceWorkerPort,
  WorkspaceWorkerSession,
} from './workspace-worker-port';

type Scope = { projectId: string; taskId: string };
type Options = {
  owner: LocalRegistryOwner;
  control: LocalBindingCoordinator;
  roots: LocalRootCoordinator;
  objects: LocalControlObjects;
  versions: LocalVersionStore;
  filesHelper: string;
  tools?: LocalCommandTools;
  gitOptions?: LocalGitWorkspaceOptions;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  /** Composition-owned selection of the already confirmed grant. */
  grantForAssignment(admission: WorkspaceWorkerAdmission): Promise<string>;
  /** Review must explicitly select its verified candidate; never recapture it. */
  versionForAssignment?(
    admission: WorkspaceWorkerAdmission,
  ): Promise<WorkspaceVersionV1 | undefined>;
  /** Host-owned private proof for each linked REVIEWER read admission. */
  verifyReviewCandidate?(state: AppState, workerId: string): Promise<WorkspaceVersionV1>;
  deliveryCandidates?: Pick<LocalDeliveryCandidates, 'validationBinding'>;
  deliveryRepairs?: Pick<LocalDeliveryRepairs, 'workspaceBinding' | 'validationBinding'>;
  verifyRepairSource?(state: AppState, workerId: string): Promise<void>;
};
type Active = {
  admission: WorkspaceWorkerAdmission;
  closing: boolean;
  closed: boolean;
  call?: WorkspaceCall;
};
const key = (scope: Scope & { workerId: string }) =>
  localRecordHash({ projectId: scope.projectId, taskId: scope.taskId, workerId: scope.workerId });
export class LocalWorkspaceSessions
  implements WorkspaceWorkerPort, WorkspaceValidationEvidencePort
{
  private readonly active = new Map<string, Active>();
  private readiness: ReturnType<typeof qualifyLocalExecution> | undefined;
  async ensureReady() {
    if (!this.options.tools) throw Error('sandbox_unavailable');
    this.readiness ??= qualifyLocalExecution(
      this.options.owner,
      this.options.objects,
      this.options.tools,
    ).catch((cause: unknown) => {
      throw Error('sandbox_unavailable', { cause });
    });
    return this.readiness;
  }
  private constructor(
    private readonly options: Options,
    private readonly authority: LocalWorkspaceAuthority,
    private readonly files: LocalWorkspaceFiles,
    private readonly writer: LocalWorkspaceApply,
    private readonly commands: LocalWorkspaceCommands | undefined,
  ) {}
  static async create(options: Options) {
    // Private active map is shared only with this authority verifier.
    let service: LocalWorkspaceSessions | undefined;
    const authority = new LocalWorkspaceAuthority(
      options.control,
      options.roots,
      options.versions,
      (call) => {
        const current = service?.active.get(key(call));
        if (!current || current.closed) throw Error('workspace_worker_capability_closed');
        current.admission.assertLease();
        if (
          current.call &&
          (current.call.workspaceId !== call.workspaceId ||
            current.call.writerEpoch !== call.writerEpoch ||
            current.call.grantRevision !== call.grantRevision)
        )
          throw Error('workspace_worker_capability_mismatch');
      },
      options.verifyGrant,
      async (claim) => {
        if (!service) throw Error('workspace_claim_closure_unavailable');
        return service.proveClaimClosed(claim);
      },
      options.gitOptions,
      options.verifyReviewCandidate,
      options.objects,
      options.deliveryCandidates,
      options.deliveryRepairs,
      options.verifyRepairSource,
    );
    const files = new LocalWorkspaceFiles(authority, options.objects, options.filesHelper);
    const writer = await LocalWorkspaceApply.open(
      options.owner,
      authority,
      options.objects,
      files,
      options.filesHelper,
    );
    const commands = options.tools
      ? await LocalWorkspaceCommands.open(
          options.owner,
          authority,
          options.objects,
          options.versions,
          await LocalFixedInputs.open(options.owner, options.objects, options.versions),
          writer,
          options.tools,
          options.filesHelper,
        )
      : undefined;
    service = new LocalWorkspaceSessions(options, authority, files, writer, commands);
    return service;
  }
  verifyCommand(scope: Scope & { workspaceId: string }, receiptId: string) {
    if (!this.commands) throw Error('workspace_command_unavailable');
    return this.commands.verifyCommand(scope, receiptId);
  }
  /** Read-only proof for a retained same-task writer claim. This does not
   * release the claim or authorize a successor/session to execute. */
  async verifyClosedClaim(scope: Scope, claim: LocalClaimRecord): Promise<string> {
    if (
      claim.projectId !== scope.projectId ||
      claim.taskId !== scope.taskId ||
      claim.status !== 'active' ||
      claim.kind !== undefined
    )
      throw Error('workspace_claim_closure_unavailable');
    const snapshot = await this.options.control.snapshot();
    const matches = snapshot.claims.filter((entry) => entry.claimId === claim.claimId);
    if (matches.length !== 1 || localRecordHash(matches[0]) !== localRecordHash(claim))
      throw Error('workspace_claim_closure_invalid');
    const proof = await this.proveClaimClosed(claim);
    if (localRecordHash(await this.options.control.snapshot()) !== localRecordHash(snapshot))
      throw Error('workspace_claim_closure_invalid');
    return proof;
  }
  private async proveClaimClosed(claim: LocalClaimRecord): Promise<string> {
    if (claim.kind !== undefined) throw Error('workspace_claim_closure_unavailable');
    if (this.active.has(key(claim))) throw Error('workspace_busy');
    const state = await this.options.control.assertClosed(claim);
    const worker = state.workers.find((w) => w.workerId === claim.workerId);
    const binding = state.localExecution?.bindings.find(
      (b) => b.workerId === claim.workerId && b.workspaceId === claim.workspaceId,
    );
    if (!worker || !['done', 'failed'].includes(worker.status) || !worker.sessionId || !binding)
      throw Error('workspace_claim_closure_unavailable');
    const actionId = `session:${localRecordHash({ identity: key(claim), sessionId: worker.sessionId })}`;
    const matches: string[] = [];
    for (const ref of await this.options.objects.references()) {
      const value = (await this.options.objects.get(ref.valueHash)) as Record<string, unknown>;
      if (
        value.schemaVersion !== 'workspace-worker-boundary-v1' ||
        value.actionId !== actionId ||
        value.reason !== 'close'
      )
        continue;
      if (
        value.projectId !== claim.projectId ||
        value.taskId !== claim.taskId ||
        value.workerId !== claim.workerId ||
        value.workspaceId !== claim.workspaceId ||
        value.writerEpoch !== claim.writerEpoch ||
        value.sessionId !== worker.sessionId ||
        value.canonicalSourceRef !== binding.receiptId ||
        value.quiescent !== true ||
        value.assurance !== 'bounded' ||
        value.claimRetained !== true ||
        !Number.isSafeInteger(value.boundary) ||
        (value.boundary as number) < 0 ||
        ref.key !== localRecordHash({ kind: 'worker-boundary', actionId, boundary: value.boundary })
      )
        throw Error('workspace_claim_closure_invalid');
      matches.push(`closure:${ref.key}`);
    }
    if (matches.length !== 1) throw Error('workspace_claim_closure_unavailable');
    return matches[0] as string;
  }
  readCompletedWorktree(scope: Scope & { workerId: string }) {
    return readCompletedWorktree(scope, {
      ...this.options,
      verifyClosure: (claim) => this.proveClaimClosed(claim),
    });
  }
  verifyCurrentVersion(scope: Scope & { workspaceId: string }, version: WorkspaceVersionV1) {
    return this.authority.verifyCurrentVersion(scope, version);
  }
  private completionBinding(
    state: AppState,
    git: boolean,
  ): {
    validationReceiptId: string;
    sourceWorkspaceId: string;
    workspaceVersion: WorkspaceVersionV1;
    controlFingerprint: string;
    roundId?: string;
  } {
    if (!git) return currentLocalCompletionEvidence(state);
    const evidence = currentCompletionEvidence(state);
    const version = state.testResults?.workspaceVersion;
    if (
      !state.localExecution?.git ||
      !isReviewBinding(evidence) ||
      !isWorkspaceVersionV1(version) ||
      version.kind !== 'git' ||
      version.commit !== evidence.commit
    )
      throw Error('local_git_completion_evidence_changed');
    const receipt = validationReceipt(state, evidence.validationReceiptId);
    const assignment = state.localExecution.bindings.find((b) => b.workerId === receipt.workerId);
    const workspace = state.localExecution.workspaces.find(
      (w) => w.workspaceId === assignment?.workspaceId,
    );
    if (workspace?.mode !== 'linked-worktree' || workspace.purpose !== 'validation')
      throw Error('local_git_completion_evidence_changed');
    return {
      validationReceiptId: evidence.validationReceiptId,
      sourceWorkspaceId: workspace.workspaceId,
      workspaceVersion: structuredClone(version),
      controlFingerprint: evidence.controlFingerprint,
    };
  }
  async archiveCompletion(scope: Scope): Promise<WorkspaceFileArtifact> {
    return this.archiveFixedCompletion(scope);
  }
  /** Host-only companion; the verifier must read the private native command and
   * exact accepted Git proof. This is never exposed as a model or HTTP argument. */
  async archiveGitCompletion(
    scope: Scope,
    verify: (state: AppState) => Promise<WorkspaceVersionV1>,
  ): Promise<WorkspaceFileArtifact> {
    return this.archiveFixedCompletion(scope, verify);
  }
  private async archiveFixedCompletion(
    scope: Scope,
    verifyGit?: (state: AppState) => Promise<WorkspaceVersionV1>,
  ): Promise<WorkspaceFileArtifact> {
    const state = await this.options.control.assertClosed(scope);
    const binding = this.completionBinding(state, verifyGit !== undefined);
    const approval = deriveCompletionResolution(state, currentApprovedReviewId(state));
    if (
      state.phase !== 'done' ||
      approval?.option !== 'approve_completion' ||
      !approval.resumed ||
      [...this.active.values()].some(
        (a) => a.admission.projectId === scope.projectId && a.admission.taskId === scope.taskId,
      ) ||
      state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
    )
      throw Error('local_archive_requires_resumed_approval');
    const workspace = state.localExecution?.workspaces.find(
      (w) => w.workspaceId === binding.sourceWorkspaceId,
    );
    if (!workspace) throw Error('workspace_assignment_mismatch');
    const qualify = async () => {
      if (!verifyGit)
        return this.verifyCurrentVersion(
          { ...scope, workspaceId: workspace.workspaceId },
          binding.workspaceVersion,
        );
      const verified = await verifyGit(state);
      if (localRecordHash(verified) !== localRecordHash(binding.workspaceVersion))
        throw Error('local_git_completion_evidence_changed');
      await this.options.verifyGrant(scope, workspace.grantId);
      const snapshot = await this.options.control.snapshot();
      const grant = snapshot.grants.find(
        (g) => g.grantId === workspace.grantId && g.projectId === scope.projectId,
      );
      if (
        grant?.status !== 'active' ||
        grant.rootId !== workspace.rootId ||
        localRecordHash(await this.options.control.assertClosed(scope)) !== localRecordHash(state)
      )
        throw Error('local_git_completion_evidence_changed');
      return { policyHash: grant.policyHash };
    };
    const qualified = await qualify();
    const versionScope = { ...scope, rootId: workspace.rootId, policyHash: qualified.policyHash };
    const identity = {
      schemaVersion: 'workspace-file-artifact-v1' as const,
      ...scope,
      sourceWorkspaceId: workspace.workspaceId,
      validationReceiptId: binding.validationReceiptId,
      approvalActionId: approval.actionId,
      workspaceVersion: binding.workspaceVersion,
      ...(binding.roundId === undefined
        ? {}
        : { roundId: binding.roundId, reviewId: currentApprovedReviewId(state) }),
    };
    const key = localFileArtifactKey(identity);
    const inputs = await LocalFixedInputs.open(
      this.options.owner,
      this.options.objects,
      this.options.versions,
    );
    const check = async () => {
      await this.options.verifyGrant(scope, workspace.grantId);
      const current = await this.options.control.assertClosed(scope);
      return (
        current.phase === 'done' &&
        localRecordHash(this.completionBinding(current, verifyGit !== undefined)) ===
          localRecordHash(binding) &&
        localRecordHash(deriveCompletionResolution(current, currentApprovedReviewId(current))) ===
          localRecordHash(approval)
      );
    };
    const previous = await this.options.objects.getReference(key);
    let artifact: WorkspaceFileArtifact;
    if (previous) {
      artifact = parseLocalFileArtifact(await this.options.objects.get(previous), key);
      const { receiptId, path, fixedInputHash, ...stored } = artifact;
      if (receiptId !== `artifact:${key}` || localRecordHash(stored) !== localRecordHash(identity))
        throw Error('local_artifact_conflict');
      const fixed = (await this.options.objects.get(fixedInputHash)) as LocalFixedInput;
      if (fixed.path !== path) throw Error('local_artifact_conflict');
      await inputs.verify(fixed, versionScope, binding.workspaceVersion, check);
    } else {
      const fixed = await inputs.materialize(
        versionScope,
        binding.workspaceVersion,
        `archive:${key}`,
        check,
      );
      artifact = {
        ...identity,
        receiptId: `artifact:${key}`,
        path: fixed.path,
        fixedInputHash: await this.options.objects.put(fixed),
      };
      await this.options.objects.bindReference(key, await this.options.objects.put(artifact));
    }
    await qualify();
    if (!(await check())) throw Error('local_completion_evidence_changed');
    return artifact;
  }
  async releaseCompleted(scope: Scope): Promise<void> {
    await this.recoverCompletion(scope);
    await this.releaseArtifact(scope, await this.archiveCompletion(scope));
  }
  async releaseGitCompleted(
    scope: Scope,
    verify: (state: AppState) => Promise<WorkspaceVersionV1>,
  ): Promise<void> {
    await this.recoverCompletion(scope);
    await this.releaseArtifact(scope, await this.archiveGitCompletion(scope, verify));
  }
  private async releaseArtifact(scope: Scope, artifact: WorkspaceFileArtifact): Promise<void> {
    const actionId = `release:${localRecordHash({ scope, artifact: artifact.receiptId })}`;
    const snapshot = await this.options.control.snapshot();
    const previous = snapshot.operations.find((o) => o.actionId === actionId);
    if (previous) {
      if (
        !isLocalBindingOperation(previous) ||
        previous.projectId !== scope.projectId ||
        previous.taskId !== scope.taskId ||
        previous.sourceMessageId !== artifact.approvalActionId
      )
        throw Error('operation_conflict');
      await this.options.control.recover(actionId, previous.inputHash);
      return;
    }
    const state = await this.options.control.assertClosed(scope);
    if (!state.localExecution || state.phase !== 'done')
      throw Error('local_archive_requires_resumed_approval');
    const claims = structuredClone(snapshot.claims);
    for (const claim of claims) {
      if (
        claim.projectId !== scope.projectId ||
        claim.taskId !== scope.taskId ||
        claim.status === 'released'
      )
        continue;
      if (claim.status !== 'active') throw Error('workspace_claim_closure_unavailable');
      claim.closureReceiptId = await this.proveClaimClosed(claim);
      claim.status = 'released';
    }
    await this.options.control.commitBinding({
      ...scope,
      actionId,
      sourceMessageId: artifact.approvalActionId,
      expectedRevision: snapshot.revision,
      nextLocalExecution: state.localExecution,
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        workspaces: snapshot.workspaces,
        linkedRoots: snapshot.linkedRoots ?? [],
        claims,
      },
    });
  }
  async recoverCompletion(scope: Scope): Promise<void> {
    const legacyKey = localFileArtifactKey(scope);
    for (const ref of await this.options.objects.references()) {
      const value = (await this.options.objects.get(
        ref.valueHash,
      )) as Partial<WorkspaceFileArtifact>;
      if (
        ref.key !== legacyKey &&
        !(
          value?.schemaVersion === 'workspace-file-artifact-v1' &&
          value.projectId === scope.projectId &&
          value.taskId === scope.taskId
        )
      )
        continue;
      const artifact = parseLocalFileArtifact(value, ref.key);
      await this.recoverArtifactRelease(scope, artifact);
    }
  }
  private async recoverArtifactRelease(
    scope: Scope,
    artifact: WorkspaceFileArtifact,
  ): Promise<void> {
    const actionId = `release:${localRecordHash({ scope, artifact: artifact.receiptId })}`;
    const previous = (await this.options.control.snapshot()).operations.find(
      (o) => o.actionId === actionId,
    );
    if (!previous) return;
    if (
      !isLocalBindingOperation(previous) ||
      previous.projectId !== scope.projectId ||
      previous.taskId !== scope.taskId ||
      previous.sourceMessageId !== artifact.approvalActionId
    )
      throw Error('operation_conflict');
    // Finish only an already prepared immutable release. This does not qualify
    // the archive against a subsequently edited live source.
    await this.options.control.recover(actionId, previous.inputHash);
  }
  async openControl(input: WorkspaceWorkerAdmission): Promise<WorkspaceControlSession> {
    const admission = { ...input };
    if (
      !['PM', 'COORDINATOR'].includes(admission.role) ||
      admission.subtaskId !== undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(admission.sessionId)
    )
      throw Error('local_control_assignment_mismatch');
    const identity = key(admission);
    if (this.active.has(identity)) throw Error('workspace_worker_already_active');
    const active: Active = { admission, closing: false, closed: false };
    this.active.set(identity, active);
    try {
      const grantId = await this.options.grantForAssignment(admission);
      const verify = async (closing: boolean) => {
        admission.assertLease();
        const state = await this.options.control.assertClosed(admission);
        const worker = state.workers.find((w) => w.workerId === admission.workerId);
        if (
          !worker ||
          worker.role !== admission.role ||
          worker.subtaskId !== undefined ||
          (!closing && worker.status !== 'running') ||
          state.localExecution?.bindings.some((b) => b.workerId === admission.workerId)
        )
          throw Error('local_control_assignment_mismatch');
        await this.options.verifyGrant(admission, grantId);
        admission.assertLease();
      };
      await verify(false);
      let boundary = 0;
      const save = async (reason: string) => {
        await verify(reason === 'close');
        const value = {
          schemaVersion: 'workspace-control-boundary-v1',
          projectId: admission.projectId,
          taskId: admission.taskId,
          workerId: admission.workerId,
          role: admission.role,
          sessionId: admission.sessionId,
          grantId,
          boundary: boundary++,
          reason,
          quiescent: true,
          fileCapabilities: false,
        };
        const ref = localRecordHash({
          kind: 'control-boundary',
          identity,
          sessionId: admission.sessionId,
          boundary: value.boundary,
        });
        await this.options.objects.bindReference(ref, await this.options.objects.put(value));
      };
      let closing: Promise<void> | undefined;
      return {
        kind: 'control',
        sessionId: admission.sessionId,
        checkpoint: async (reason) => {
          if (active.closed || active.closing) throw Error('workspace_worker_capability_closed');
          await save(reason);
        },
        close: () => {
          if (closing) return closing;
          active.closing = true;
          closing = save('close').then(() => {
            active.closed = true;
            this.active.delete(identity);
          });
          return closing;
        },
      };
    } catch (error) {
      this.active.delete(identity);
      throw error;
    }
  }
  async open(input: WorkspaceWorkerAdmission): Promise<WorkspaceWorkerSession> {
    const admission = { ...input };
    const { control, objects, versions } = this.options;
    admission.assertLease();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(admission.sessionId))
      throw Error('invalid_workspace_session');
    const coding = admission.role === 'CODER';
    if (!coding && !['ARCHITECT', 'TESTER', 'REVIEWER'].includes(admission.role))
      throw Error('workspace_worker_role_unavailable');

    const identity = key(admission);
    if (this.active.has(identity)) throw Error('workspace_worker_already_active');
    const active: Active = { admission, closing: false, closed: false };
    this.active.set(identity, active);
    try {
      const state = await control.assertClosed(admission);
      const worker = state.workers.find((w) => w.workerId === admission.workerId);
      if (
        coding &&
        admission.subtaskId === undefined &&
        !deliveryRepairAssignment(state, admission.workerId)
      )
        throw Error('workspace_assignment_mismatch');
      if (
        !worker ||
        worker.role !== admission.role ||
        worker.subtaskId !== admission.subtaskId ||
        worker.status !== 'running'
      )
        throw Error('workspace_assignment_mismatch');
      const grantId = await this.options.grantForAssignment(admission);
      const snapshot = await control.snapshot();
      const grant = snapshot.grants.find(
        (g) =>
          g.grantId === grantId && g.projectId === admission.projectId && g.status === 'active',
      );
      const root = snapshot.roots.find(
        (r) => r.rootId === grant?.rootId && r.projectId === admission.projectId,
      );
      if (!grant || !root) throw Error('authorization_closed');
      await this.options.verifyGrant(admission, grantId);
      const existing = state.localExecution?.bindings.find(
        (b) => b.workerId === admission.workerId,
      );
      let workspace = state.localExecution?.workspaces.find(
        (w) => w.workspaceId === existing?.workspaceId,
      );
      if (!existing) {
        const delivery = deliveryReaderAssignment(state, admission.workerId);
        const deliveryReader = delivery !== undefined && delivery.role === admission.role;
        if (
          state.localExecution?.git &&
          ['CODER', 'TESTER', 'REVIEWER'].includes(admission.role) &&
          !deliveryReader
        )
          throw Error('workspace_assignment_mismatch');
        const selected = await this.options.versionForAssignment?.(admission);
        if (deliveryReader && selected === undefined)
          throw Error('delivery_candidate_version_required');
        if (admission.role === 'REVIEWER' && selected === undefined)
          throw Error('workspace_review_version_required');
        const version =
          selected ??
          (await versions.capture(
            {
              projectId: admission.projectId,
              taskId: admission.taskId,
              rootId: root.rootId,
              policyHash: grant.policyHash,
            },
            localRootBinding(root),
            async () => {
              admission.assertLease();
              await this.options.verifyGrant(admission, grantId);
              return true;
            },
          ));
        const registration = {
          projectId: admission.projectId,
          taskId: admission.taskId,
          workerId: admission.workerId,
          actionId: `register:${identity}`,
          rootId: root.rootId,
          grantId,
          workspaceId: `workspace:${identity}`,
          version,
          expectedRevision: (await control.snapshot()).revision,
        };
        workspace = coding
          ? await this.authority.register({
              ...registration,
              subtaskId: admission.subtaskId as string,
            })
          : await this.authority.registerReadOnly(registration);
      }
      if (
        !workspace ||
        workspace.grantId !== grantId ||
        workspace.rootId !== root.rootId ||
        (workspace.mode === 'linked-worktree' &&
          (!this.options.gitOptions ||
            !['CODER', 'TESTER', 'REVIEWER'].includes(admission.role))) ||
        workspace.purpose !== (coding ? 'coding' : 'validation')
      )
        throw Error('workspace_assignment_mismatch');
      if (workspace.mode === 'linked-worktree' && admission.role === 'REVIEWER') {
        const selected = await this.options.versionForAssignment?.(admission);
        if (
          !this.options.verifyReviewCandidate ||
          selected?.kind !== 'git' ||
          !isWorktreeRef(worker.worktree) ||
          selected.commit !== worker.worktree.headCommit
        )
          throw Error('local_git_review_proof_unavailable');
        const verified = await this.options.verifyReviewCandidate(state, admission.workerId);
        if (localRecordHash(verified) !== localRecordHash(selected))
          throw Error('local_git_review_binding_changed');
      }
      const current = await control.snapshot();
      const claims = current.claims.filter(
        (c) =>
          c.workspaceId === workspace.workspaceId &&
          c.workerId === admission.workerId &&
          c.projectId === admission.projectId &&
          c.taskId === admission.taskId &&
          c.status === 'active',
      );
      const writer =
        coding || (workspace.mode === 'linked-worktree' && admission.role === 'TESTER');
      if (writer ? claims.length !== 1 || !claims[0] : claims.length !== 0)
        throw Error('authorization_closed');
      const call: WorkspaceCall = {
        projectId: admission.projectId,
        taskId: admission.taskId,
        workerId: admission.workerId,
        workspaceId: workspace.workspaceId,
        actionId: `session:${localRecordHash({ identity, sessionId: admission.sessionId })}`,
        grantRevision: grant.revision,
        writerEpoch: writer ? (claims[0]?.writerEpoch as number) : 0,
      };
      active.call = call;
      await this.authority.assertCall(call, 'read');
      await this.writer.assertQuiescent(call);
      let boundary = 0;
      const save = async (reason: string) => {
        const admitted = await this.authority.assertQuiescence(call);
        await this.writer.assertLifecycleQuiescent(call);
        const value = {
          schemaVersion: 'workspace-worker-boundary-v1',
          ...call,
          sessionId: admission.sessionId,
          boundary: boundary++,
          reason,
          createdAt: Date.now(),
          canonicalSourceRef: admitted.sourceReceiptId,
          quiescent: true,
          assurance: 'bounded',
          claimRetained: writer,
        };
        const ref = localRecordHash({
          kind: 'worker-boundary',
          actionId: call.actionId,
          boundary: value.boundary,
        });
        await objects.bindReference(ref, await objects.put(value));
      };
      const tools = bindLocalWorkspaceTools({
        call: (actionId) => {
          if (active.closed || active.closing) throw Error('workspace_worker_capability_closed');
          admission.assertLease();
          return { ...call, actionId };
        },
        authority: this.authority,
        objects,
        versions,
        files: this.files,
        writer: this.writer,
        ...(this.commands ? { commands: this.commands } : {}),
      });
      let completing: Promise<WorktreeRef> | undefined;
      const completeWorktree =
        workspace.mode !== 'linked-worktree' || admission.role === 'REVIEWER'
          ? undefined
          : () => {
              if (active.closed || active.closing)
                return Promise.reject(Error('workspace_worker_capability_closed'));
              admission.assertLease();
              completing ??= serializeWorkspaceOperation(call, async () => {
                const admitted = await this.authority.assertCall(call, 'edit');
                await this.writer.assertLifecycleQuiescent(call);
                const snapshot = await control.snapshot(),
                  state = await control.assertClosed(call);
                const worker = state.workers.find((w) => w.workerId === call.workerId);
                const record = snapshot.linkedRoots?.find(
                  (r) => r.workspaceId === call.workspaceId,
                );
                const sourceRoot = snapshot.roots.find(
                  (r) => r.rootId === admitted.workspace.rootId && r.projectId === call.projectId,
                );
                const git = this.options.gitOptions && structuredClone(this.options.gitOptions);
                if (
                  !git ||
                  !record ||
                  !sourceRoot ||
                  !worker ||
                  !isWorktreeRef(worker.worktree) ||
                  admitted.workspace.mode !== 'linked-worktree'
                )
                  throw Error('workspace_assignment_mismatch');
                const currentRef = structuredClone(worker.worktree);
                const authorize = async () => {
                  admission.assertLease();
                  await this.options.verifyGrant(call, admitted.grant.grantId);
                  const current = await control.assertClosed(call);
                  if (
                    (await control.snapshot()).revision !== snapshot.revision ||
                    localRecordHash(current.localExecution) !==
                      localRecordHash(state.localExecution) ||
                    localRecordHash(
                      current.workers.find((w) => w.workerId === call.workerId) ?? null,
                    ) !== localRecordHash(worker)
                  )
                    throw Error('workspace_assignment_mismatch');
                  admission.assertLease();
                  return true;
                };
                const scope = {
                  projectId: call.projectId,
                  taskId: call.taskId,
                  rootId: admitted.workspace.rootId,
                  policyHash: admitted.grant.policyHash,
                };
                const version = await versions.capture(scope, admitted.binding, authorize);
                const manifest = await versions.read(version, scope);
                const files: { path: string; content: Buffer; executable: boolean }[] = [];
                for (const file of manifest.files)
                  files.push({
                    path: file.path,
                    content: await objects.getBytes(file.contentHash),
                    executable: file.version.executable,
                  });
                const input = {
                  schemaVersion: 'worker-git-completion-v1',
                  ...call,
                  sessionId: admission.sessionId,
                  version,
                  worktree: currentRef,
                  sourceReceiptId: admitted.sourceReceiptId,
                  git,
                };
                const key = localRecordHash({
                  kind: 'worker-git-completion',
                  ...call,
                  sessionId: admission.sessionId,
                });
                await objects.bindReference(key, await objects.put(input));
                await versions.verify(version, scope, admitted.binding, authorize);
                const receipt = await commitLocalGitWorktree({
                  ...git,
                  projectId: call.projectId,
                  taskId: call.taskId,
                  root: sourceRoot.path,
                  actionId: `worker-commit:${key}`,
                  workspaceId: call.workspaceId,
                  creationActionId: record.creation.actionId,
                  expectedHead: currentRef.headCommit ?? currentRef.baseCommit,
                  stagingIdentity: record.staging.identity,
                  files,
                  directories: manifest.directories.map((d) => d.path).filter(Boolean),
                  authorize,
                });
                await versions.verify(version, scope, admitted.binding, authorize);
                const worktree = { ...currentRef, headCommit: receipt.commit };
                await objects.bindReference(
                  localRecordHash({ key, stage: 'completed' }),
                  await objects.put({ inputHash: localRecordHash(input), receipt, worktree }),
                );
                await authorize();
                return worktree;
              });
              return completing.then((ref) => structuredClone(ref));
            };
      let closing: Promise<void> | undefined;
      return {
        sessionId: admission.sessionId,
        workspace: structuredClone(workspace),
        tools: {
          ...tools,
          apply: (...args) => {
            if (completing) return Promise.reject(Error('workspace_worker_writes_closed'));
            return tools.apply(...args);
          },
          run: (action, request) => {
            if (completing && request.toolId !== 'node')
              return Promise.reject(Error('workspace_worker_writes_closed'));
            return tools.run(action, request);
          },
        },
        ...(completeWorktree ? { completeWorktree } : {}),
        ...(workspace.mode === 'linked-worktree' &&
        workspace.purpose === 'validation' &&
        admission.role === 'TESTER'
          ? {
              inspectCommittedGit: async (actionId: string) => {
                if (active.closed || active.closing || !completing)
                  throw Error('workspace_validation_commit_required');
                admission.assertLease();
                await completing;
                const operation = { ...call, actionId };
                return serializeWorkspaceOperation(operation, () =>
                  this.authority.captureCommandGitVersion(operation, objects),
                );
              },
              runFixedGitValidation: async (actionId: string, request: WorkspaceCommandRequest) => {
                if (active.closed || active.closing || !this.commands || !completing)
                  throw Error('workspace_validation_commit_required');
                admission.assertLease();
                await completing;
                return this.commands.runFixedGitValidation({ ...call, actionId }, request);
              },
            }
          : {}),
        checkpoint: async (reason) => {
          if (active.closed || active.closing) throw Error('workspace_worker_capability_closed');
          await serializeWorkspaceOperation(call, async () => {
            await this.authority.assertCall(call, 'read');
            await save(reason);
          });
        },
        close: () => {
          if (closing) return closing;
          active.closing = true;
          closing = serializeWorkspaceOperation(call, async () => {
            await save('close');
            active.closed = true;
            this.active.delete(identity);
          });
          return closing;
        },
      };
    } catch (error) {
      // No tool capability escaped open(). Failed registration remains in the
      // durable control journal and cannot be bypassed by a fresh session.
      active.closed = true;
      this.active.delete(identity);
      throw error;
    }
  }
}
