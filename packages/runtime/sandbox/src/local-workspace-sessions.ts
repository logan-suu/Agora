/** Trusted worker capability lifetime. No global scheduler, role routing or
 * Harness loop is implemented here: the runtime supplies a live lease closure. */
import type { WorkspaceCall, WorkspaceVersionV1 } from '@agora/core-domain';
import {
  currentApprovedReviewId,
  currentLocalCompletionEvidence,
  deriveCompletionResolution,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import { qualifyLocalExecution } from './local-execution-probe';
import { type LocalFixedInput, LocalFixedInputs } from './local-fixed-inputs';
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
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  /** Composition-owned selection of the already confirmed grant. */
  grantForAssignment(admission: WorkspaceWorkerAdmission): Promise<string>;
  /** Review must explicitly select its verified candidate; never recapture it. */
  versionForAssignment?(
    admission: WorkspaceWorkerAdmission,
  ): Promise<WorkspaceVersionV1 | undefined>;
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
  private async proveClaimClosed(claim: LocalClaimRecord): Promise<string> {
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
  verifyCurrentVersion(scope: Scope & { workspaceId: string }, version: WorkspaceVersionV1) {
    return this.authority.verifyCurrentVersion(scope, version);
  }
  async archiveCompletion(scope: Scope): Promise<WorkspaceFileArtifact> {
    const state = await this.options.control.assertClosed(scope);
    const binding = currentLocalCompletionEvidence(state);
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
    const qualified = await this.verifyCurrentVersion(
      { ...scope, workspaceId: workspace.workspaceId },
      binding.workspaceVersion,
    );
    const versionScope = { ...scope, rootId: workspace.rootId, policyHash: qualified.policyHash };
    const identity = {
      schemaVersion: 'workspace-file-artifact-v1' as const,
      ...scope,
      sourceWorkspaceId: workspace.workspaceId,
      validationReceiptId: binding.validationReceiptId,
      approvalActionId: approval.actionId,
      workspaceVersion: binding.workspaceVersion,
    };
    const key = localRecordHash({ kind: 'task-file-artifact', ...scope });
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
        localRecordHash(currentLocalCompletionEvidence(current)) === localRecordHash(binding) &&
        localRecordHash(deriveCompletionResolution(current, currentApprovedReviewId(current))) ===
          localRecordHash(approval)
      );
    };
    const previous = await this.options.objects.getReference(key);
    let artifact: WorkspaceFileArtifact;
    if (previous) {
      artifact = (await this.options.objects.get(previous)) as WorkspaceFileArtifact;
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
    await this.verifyCurrentVersion(
      { ...scope, workspaceId: workspace.workspaceId },
      binding.workspaceVersion,
    );
    if (!(await check())) throw Error('local_completion_evidence_changed');
    return artifact;
  }
  async releaseCompleted(scope: Scope): Promise<void> {
    await this.recoverCompletion(scope);
    const artifact = await this.archiveCompletion(scope);
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
        claims,
      },
    });
  }
  async recoverCompletion(scope: Scope): Promise<void> {
    const key = localRecordHash({ kind: 'task-file-artifact', ...scope });
    const artifactHash = await this.options.objects.getReference(key);
    if (!artifactHash) return;
    const artifact = (await this.options.objects.get(artifactHash)) as WorkspaceFileArtifact;
    if (
      artifact.schemaVersion !== 'workspace-file-artifact-v1' ||
      artifact.projectId !== scope.projectId ||
      artifact.taskId !== scope.taskId ||
      artifact.receiptId !== `artifact:${key}`
    )
      throw Error('local_artifact_conflict');
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
    if (coding && admission.subtaskId === undefined) throw Error('workspace_assignment_mismatch');
    const identity = key(admission);
    if (this.active.has(identity)) throw Error('workspace_worker_already_active');
    const active: Active = { admission, closing: false, closed: false };
    this.active.set(identity, active);
    try {
      const state = await control.assertClosed(admission);
      const worker = state.workers.find((w) => w.workerId === admission.workerId);
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
        const selected = await this.options.versionForAssignment?.(admission);
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
        workspace.mode !== 'direct' ||
        workspace.purpose !== (coding ? 'coding' : 'validation')
      )
        throw Error('workspace_assignment_mismatch');
      const current = await control.snapshot();
      const claims = current.claims.filter(
        (c) =>
          c.workspaceId === workspace.workspaceId &&
          c.workerId === admission.workerId &&
          c.projectId === admission.projectId &&
          c.taskId === admission.taskId &&
          c.status === 'active',
      );
      if (coding ? claims.length !== 1 || !claims[0] : claims.length !== 0)
        throw Error('authorization_closed');
      const call: WorkspaceCall = {
        projectId: admission.projectId,
        taskId: admission.taskId,
        workerId: admission.workerId,
        workspaceId: workspace.workspaceId,
        actionId: `session:${localRecordHash({ identity, sessionId: admission.sessionId })}`,
        grantRevision: grant.revision,
        writerEpoch: coding ? (claims[0]?.writerEpoch as number) : 0,
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
          claimRetained: coding,
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
      let closing: Promise<void> | undefined;
      return {
        sessionId: admission.sessionId,
        workspace: structuredClone(workspace),
        tools,
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
