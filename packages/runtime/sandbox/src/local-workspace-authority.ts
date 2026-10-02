/** Registry-backed workspace admission. This service never accepts a model
 * assertion of authority; the composition supplies a live lease verifier. */
import {
  type AppState,
  currentReviewDispatch,
  deliveryReaderAssignment,
  deliveryRepairAssignment,
  isReviewBinding,
  isWorkspaceCall,
  isWorkspaceVersionV1,
  isWorktreeRef,
  validationReceipt,
  type WorkspaceCall,
  type WorkspaceRefV1,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalDeliveryCandidates } from './local-delivery-candidates';
import type { LocalDeliveryRepairs } from './local-delivery-repairs';
import type { LocalRootBinding } from './local-file-transaction';
import { withLocalGitSession } from './local-git-session';
import { readLocalGitTreeFiles } from './local-git-tree-files';
import { LocalGitVersionStore } from './local-git-version-store';
import type { LocalGitWorkspaceOptions } from './local-git-workspaces';
import { readOwnedLocalGitWorktree, verifyOwnedLocalGitWorktree } from './local-git-worktree';
import { verifyLocalLinkedRoot } from './local-linked-root';
import { assertLocalRangeAdmission, localWorkerDependencies } from './local-range-admission';
import {
  isLocalBindingOperation,
  type LocalClaimRecord,
  type LocalGrantRecord,
  type LocalRegistryRecords,
  type LocalRootRecord,
  localRecordHash,
} from './local-registry-records';
import type { LocalRootCoordinator } from './local-root-coordinator';
import { assertLocalValidationChanges } from './local-validation-changes';
import type { LocalVersionStore } from './local-version-store';
import type { WorkspaceInspection } from './workspace-port';

type Scope = { projectId: string; taskId: string };
type Registration = Scope & {
  actionId: string;
  rootId: string;
  grantId: string;
  workspaceId: string;
  workerId: string;
  subtaskId: string;
  version: WorkspaceVersionV1;
  expectedRevision: number;
};
const id = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export function localRootBinding(
  root: Pick<LocalRootRecord, 'path' | 'chain' | 'staging'>,
): LocalRootBinding {
  if (!root.staging) throw Error('workspace_root_not_initialized');
  return {
    root: root.path,
    chain: structuredClone(root.chain),
    stagingIdentity: root.staging.identity,
  };
}
export class LocalWorkspaceAuthority {
  private readonly git: LocalGitWorkspaceOptions | undefined;
  constructor(
    private readonly control: LocalBindingCoordinator,
    private readonly roots: LocalRootCoordinator,
    private readonly versions: LocalVersionStore,
    private readonly assertLease: (call: WorkspaceCall) => void,
    private readonly verifyGrant: (scope: Scope, grantId: string) => Promise<void>,
    private readonly verifyClaimClosure?: (claim: LocalClaimRecord) => Promise<string>,
    git?: LocalGitWorkspaceOptions,
    private readonly verifyReviewCandidate?: (
      state: AppState,
      workerId: string,
    ) => Promise<WorkspaceVersionV1>,
    private readonly reviewObjects?: LocalControlObjects,
    private readonly deliveryCandidates?: Pick<LocalDeliveryCandidates, 'validationBinding'>,
    private readonly deliveryRepairs?: Pick<
      LocalDeliveryRepairs,
      'workspaceBinding' | 'validationBinding'
    >,
    private readonly verifyRepairSource?: (state: AppState, workerId: string) => Promise<void>,
  ) {
    this.git = git === undefined ? undefined : structuredClone(git);
  }
  private async readerBinding(
    state: AppState,
    workerId: string,
    version: WorkspaceVersionV1,
    root: LocalRootRecord,
    grant: LocalGrantRecord,
  ) {
    const selected = deliveryReaderAssignment(state, workerId);
    if (selected?.workerId !== workerId) return localRootBinding(root);
    if (selected.repairCandidate) {
      if (!this.deliveryRepairs || !this.verifyRepairSource)
        throw Error('delivery_repair_verifier_required');
      await this.verifyRepairSource(state, selected.repairCandidate.candidate.workerId);
      return this.deliveryRepairs.validationBinding(state, workerId, version, grant, async () => {
        await this.verifyGrant(state, grant.grantId);
        return localRecordHash(await this.control.assertClosed(state)) === localRecordHash(state);
      });
    }
    if (!this.deliveryCandidates) throw Error('delivery_candidate_proof_unavailable');
    return this.deliveryCandidates.validationBinding(state, workerId, version, grant);
  }
  private async initialized(
    snapshot: LocalRegistryRecords,
    scope: Scope,
    root: LocalRootRecord,
    grant: LocalGrantRecord,
  ) {
    const operation = snapshot.operations.find(
      (o) => !isLocalBindingOperation(o) && o.rootId === root.rootId && o.grantId === grant.grantId,
    );
    if (!operation || isLocalBindingOperation(operation) || operation.stage !== 'committed')
      throw Error('workspace_root_not_initialized');
    await this.roots.initialize({
      projectId: scope.projectId,
      taskId: scope.taskId,
      actionId: operation.actionId,
      rootId: root.rootId,
      grantId: grant.grantId,
      expectedRevision: operation.preparedRevision - 1,
    });
  }
  private records(
    snapshot: LocalRegistryRecords,
    projectId: string,
    rootId: string,
    grantId: string,
  ) {
    const root = snapshot.roots.find((r) => r.rootId === rootId && r.projectId === projectId);
    const grant = snapshot.grants.find(
      (g) => g.grantId === grantId && g.projectId === projectId && g.rootId === rootId,
    );
    if (!root || !grant || grant.status !== 'active') throw Error('authorization_closed');
    return { root, grant };
  }
  async register(input: Registration): Promise<WorkspaceRefV1> {
    localRecordHash(input);
    if (
      Object.keys(input).sort().join(',') !==
        'actionId,expectedRevision,grantId,projectId,rootId,subtaskId,taskId,version,workerId,workspaceId' ||
      ![
        input.projectId,
        input.taskId,
        input.actionId,
        input.rootId,
        input.grantId,
        input.workspaceId,
        input.workerId,
        input.subtaskId,
      ].every(id) ||
      input.version.kind !== 'files' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw Error('invalid_workspace_registration');
    const request = structuredClone(input);
    const snapshot = await this.control.snapshot();
    const { root, grant } = this.records(
      snapshot,
      request.projectId,
      request.rootId,
      request.grantId,
    );
    const versionScope = {
      projectId: request.projectId,
      taskId: request.taskId,
      rootId: root.rootId,
      policyHash: grant.policyHash,
    };
    await this.versions.read(request.version, versionScope);
    const workspace: WorkspaceRefV1 = {
      schemaVersion: 'workspace-v1',
      projectId: request.projectId,
      taskId: request.taskId,
      workspaceId: request.workspaceId,
      rootId: root.rootId,
      grantId: grant.grantId,
      purpose: 'coding',
      mode: 'direct',
      baselineManifestId: request.version.manifestId,
    };
    const existing = snapshot.operations.find((o) => o.actionId === request.actionId);
    if (existing) {
      if (
        !isLocalBindingOperation(existing) ||
        existing.projectId !== request.projectId ||
        existing.taskId !== request.taskId ||
        existing.preparedRevision - 1 !== request.expectedRevision ||
        !existing.nextLocalExecution.workspaces.some(
          (w) => localRecordHash(w) === localRecordHash(workspace),
        ) ||
        !existing.nextLocalExecution.bindings.some(
          (b) =>
            b.workerId === request.workerId &&
            b.subtaskId === request.subtaskId &&
            b.workspaceId === request.workspaceId &&
            b.receiptId === existing.receiptId,
        )
      )
        throw Error('operation_conflict');
      await this.control.recover(existing.actionId, existing.inputHash);
      await this.verifyGrant(request, grant.grantId);
      return workspace;
    }
    if (snapshot.revision !== request.expectedRevision) throw Error('registry_revision_conflict');
    const state = await this.control.assertClosed(request);
    const worker = state.workers.find((w) => w.workerId === request.workerId);
    const subtask = state.subtasks.find((s) => s.id === request.subtaskId);
    if (
      worker?.role !== 'CODER' ||
      worker.subtaskId !== request.subtaskId ||
      !['pending', 'running'].includes(worker.status) ||
      !subtask ||
      !['todo', 'in_progress'].includes(subtask.status) ||
      !subtask.dependsOn.every((id) =>
        state.subtasks.some((s) => s.id === id && s.status === 'done'),
      ) ||
      state.localExecution?.bindings.some((b) => b.workerId === request.workerId) ||
      snapshot.workspaces.some((w) => w.workspaceId === request.workspaceId)
    )
      throw Error('workspace_assignment_mismatch');
    if (!grant.actions.includes('read') || !grant.actions.includes('edit'))
      throw Error('authorization_closed');
    await this.verifyGrant(request, grant.grantId);
    await this.initialized(snapshot, request, root, grant);
    const check = async () => {
      await this.control.assertClosed(request);
      const current = await this.control.snapshot();
      return current.revision === snapshot.revision;
    };
    await this.versions.verify(request.version, versionScope, localRootBinding(root), check);
    const claims = structuredClone(snapshot.claims);
    for (const claim of claims) {
      if (claim.status === 'released') continue;
      const previousWorkspace = snapshot.workspaces.find(
        (w) => w.workspaceId === claim.workspaceId,
      );
      if (previousWorkspace?.rootId !== request.rootId) continue;
      if (
        claim.status !== 'active' ||
        claim.projectId !== request.projectId ||
        claim.taskId !== request.taskId ||
        claim.workerId === request.workerId ||
        !this.verifyClaimClosure
      )
        throw Error('workspace_busy');
      claim.closureReceiptId = await this.verifyClaimClosure(claim);
      claim.status = 'released';
    }
    const writerEpoch = Math.max(0, ...snapshot.claims.map((c) => c.writerEpoch)) + 1;
    if (!Number.isSafeInteger(writerEpoch)) throw Error('workspace_epoch_exhausted');
    const next = structuredClone(state.localExecution);
    if (!next) throw Error('workspace_binding_missing');
    next.workspaces.push(workspace);
    next.bindings.push({
      workerId: request.workerId,
      subtaskId: request.subtaskId,
      workspaceId: request.workspaceId,
      receiptId: `binding:${request.actionId}`,
    });
    await this.control.commitBinding({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      sourceMessageId: grant.leaderMessageId,
      expectedRevision: request.expectedRevision,
      nextLocalExecution: next,
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        workspaces: [...snapshot.workspaces, workspace],
        claims: [
          ...claims,
          {
            claimId: `claim:${localRecordHash(request)}`,
            projectId: request.projectId,
            taskId: request.taskId,
            workspaceId: request.workspaceId,
            workerId: request.workerId,
            writerEpoch,
            createdActionId: request.actionId,
            status: 'active',
            closureReceiptId: null,
          },
        ],
      },
    });
    return workspace;
  }
  async assertCall(input: WorkspaceCall, action: LocalGrantRecord['actions'][number]) {
    return this.assert(input, action, false);
  }
  private async commandGitContext(input: WorkspaceCall) {
    if (!this.git) throw Error('git_workspace_verifier_required');
    const call = structuredClone(input);
    const admitted = await this.assertCall(call, 'read');
    const state = await this.control.assertClosed(call);
    const snapshot = await this.control.snapshot();
    const sourceRoot = snapshot.roots.find(
      (root) => root.rootId === admitted.workspace.rootId && root.projectId === call.projectId,
    );
    const record = snapshot.linkedRoots?.find(
      (entry) => entry.workspaceId === admitted.workspace.workspaceId,
    );
    const worker = state.workers.find((entry) => entry.workerId === call.workerId);
    const ref = worker?.worktree;
    const expectedHead = isWorktreeRef(ref) ? (ref.headCommit ?? ref.baseCommit) : undefined;
    if (
      admitted.workspace.mode !== 'linked-worktree' ||
      !sourceRoot ||
      !record ||
      !expectedHead ||
      !this.git
    )
      throw Error('workspace_version_scope_mismatch');
    const originalState = localRecordHash(state);
    const originalRegistry = localRecordHash(snapshot);
    const authorize = async () => {
      this.assertLease(call);
      await this.verifyGrant(call, admitted.grant.grantId);
      if (
        localRecordHash(await this.control.assertClosed(call)) !== originalState ||
        localRecordHash(await this.control.snapshot()) !== originalRegistry
      )
        throw Error('workspace_version_scope_mismatch');
      this.assertLease(call);
      return true;
    };
    await authorize();
    return {
      expectedHead,
      scope: {
        projectId: call.projectId,
        taskId: call.taskId,
        rootId: sourceRoot.rootId,
        policyHash: admitted.grant.policyHash,
      },
      current: {
        ...this.git,
        projectId: call.projectId,
        taskId: call.taskId,
        root: sourceRoot.path,
        sourceRoot,
        workspace: admitted.workspace,
        record,
        expectedHead,
        actionId: record.initialization.actionId,
        creationActionId: record.creation.actionId,
        bindingReceiptId: record.bindingReceiptId,
        authorize,
      },
      finish: async () => {
        await authorize();
        const final = await this.assertCall(call, 'read');
        if (
          localRecordHash(final.workspace) !== localRecordHash(admitted.workspace) ||
          localRecordHash(final.binding) !== localRecordHash(admitted.binding) ||
          localRecordHash(final.grant) !== localRecordHash(admitted.grant)
        )
          throw Error('workspace_version_scope_mismatch');
        await authorize();
      },
    };
  }
  private async assertCommandValidationChanges(
    context: Awaited<ReturnType<LocalWorkspaceAuthority['commandGitContext']>>,
    version: WorkspaceVersionV1,
  ) {
    const { current, scope } = context;
    if (current.workspace.mode !== 'linked-worktree')
      throw Error('workspace_version_scope_mismatch');
    if (current.workspace.purpose !== 'validation') return;
    const manifest = await this.versions.read(version, scope);
    await withLocalGitSession(current, async (session) => {
      const creation = readOwnedLocalGitWorktree(session, {
        ...current,
        workspaceId: current.workspace.workspaceId,
        gitHash: current.git.sha256,
      });
      if (creation.baseCommit !== current.workspace.baseCommit)
        throw Error('workspace_version_scope_mismatch');
      await verifyOwnedLocalGitWorktree(session, creation, current.expectedHead);
      const tree = await session.run([
        'rev-parse',
        '--verify',
        `${current.workspace.baseCommit}^{tree}`,
      ]);
      const base = await readLocalGitTreeFiles(session, tree);
      assertLocalValidationChanges(base.files, manifest.files);
      await verifyOwnedLocalGitWorktree(session, creation, current.expectedHead);
    });
  }
  /** Capture the committed TESTER version for a host-only fixed command. */
  async captureCommandGitVersion(
    input: WorkspaceCall,
    objects: LocalControlObjects,
  ): Promise<WorkspaceInspection> {
    const context = await this.commandGitContext(input);
    if (context.current.workspace.purpose !== 'validation')
      throw Error('workspace_validation_required');
    const version = await new LocalGitVersionStore(objects, this.versions).capture(
      context.scope,
      context.current,
    );
    const manifest = await this.versions.read(version, context.scope);
    await this.assertCommandValidationChanges(context, version);
    await context.finish();
    return {
      version,
      files: manifest.files.map(({ path, version: fileVersion }) => ({
        path,
        version: fileVersion,
      })),
      excludedPaths: manifest.excludedPaths,
    };
  }
  /** Qualify a fixed Git input against the current owned linked worktree and
   * canonical worker. This read-only proof never grants command authority. */
  async verifyCommandGitVersion(
    input: WorkspaceCall,
    version: WorkspaceVersionV1,
    objects: LocalControlObjects,
  ): Promise<void> {
    if (!isWorkspaceVersionV1(version) || version.kind !== 'git')
      throw Error('git_workspace_verifier_required');
    const context = await this.commandGitContext(input);
    if (version.commit !== context.expectedHead) throw Error('workspace_version_scope_mismatch');
    await new LocalGitVersionStore(objects, this.versions).verify(
      version,
      context.scope,
      context.current,
    );
    await this.assertCommandValidationChanges(context, version);
    await context.finish();
  }
  /** Read-only control-plane qualification of an already captured version.
   * It cannot create a worker call, claim, process or write capability. */
  async verifyCurrentVersion(scope: Scope & { workspaceId: string }, version: WorkspaceVersionV1) {
    const state = await this.control.assertClosed(scope);
    const snapshot = await this.control.snapshot();
    const workspace = snapshot.workspaces.find(
      (w) =>
        w.workspaceId === scope.workspaceId &&
        w.projectId === scope.projectId &&
        w.taskId === scope.taskId,
    );
    if (
      workspace?.mode !== 'direct' ||
      !isWorkspaceVersionV1(version) ||
      version.kind !== 'files' ||
      !state.localExecution?.workspaces.some(
        (w) => localRecordHash(w) === localRecordHash(workspace),
      )
    )
      throw Error('workspace_assignment_mismatch');
    assertLocalRangeAdmission(snapshot, workspace, state.localExecution?.workspaces ?? []);
    const { root, grant } = this.records(
      snapshot,
      scope.projectId,
      workspace.rootId,
      workspace.grantId,
    );
    if (!grant.actions.includes('read')) throw Error('authorization_closed');
    await this.initialized(snapshot, scope, root, grant);
    const reader = state.localExecution?.bindings.find(
      (binding) =>
        binding.workspaceId === workspace.workspaceId &&
        deliveryReaderAssignment(state, binding.workerId) !== undefined,
    );
    let fixedBinding = reader
      ? await this.readerBinding(state, reader.workerId, version, root, grant)
      : localRootBinding(root);
    const repair = state.localExecution.bindings.find(
      (binding) =>
        binding.workspaceId === workspace.workspaceId &&
        deliveryRepairAssignment(state, binding.workerId) !== undefined,
    );
    if (repair) {
      if (!this.deliveryRepairs || !this.verifyRepairSource)
        throw Error('delivery_repair_verifier_required');
      await this.verifyRepairSource(state, repair.workerId);
      fixedBinding = await this.deliveryRepairs.workspaceBinding(
        state,
        repair.workerId,
        grant,
        async () => {
          await this.verifyGrant(scope, grant.grantId);
          return (
            (await this.control.snapshot()).revision === snapshot.revision &&
            localRecordHash(await this.control.assertClosed(scope)) === localRecordHash(state)
          );
        },
      );
    }
    await this.versions.verify(
      version,
      {
        projectId: scope.projectId,
        taskId: scope.taskId,
        rootId: root.rootId,
        policyHash: grant.policyHash,
      },
      fixedBinding,
      async () => {
        await this.verifyGrant(scope, grant.grantId);
        const current = await this.control.assertClosed(scope);
        return (
          (await this.control.snapshot()).revision === snapshot.revision &&
          localRecordHash(current.localExecution) === localRecordHash(state.localExecution)
        );
      },
    );
    const manifest = await this.versions.read(version, {
      projectId: scope.projectId,
      taskId: scope.taskId,
      rootId: root.rootId,
      policyHash: grant.policyHash,
    });
    return {
      policyHash: grant.policyHash,
      toolchainHash: grant.toolchainHash,
      inspection: {
        version: structuredClone(version),
        files: manifest.files.map(({ path, version }) => ({ path, version })),
        excludedPaths: manifest.excludedPaths,
      },
    };
  }
  /** Register a fixed reader independently of the source writer's claim. */
  async registerReadOnly(input: Omit<Registration, 'subtaskId'>): Promise<WorkspaceRefV1> {
    localRecordHash(input);
    if (
      Object.keys(input).sort().join(',') !==
        'actionId,expectedRevision,grantId,projectId,rootId,taskId,version,workerId,workspaceId' ||
      ![
        input.projectId,
        input.taskId,
        input.actionId,
        input.rootId,
        input.grantId,
        input.workspaceId,
        input.workerId,
      ].every(id) ||
      !isWorkspaceVersionV1(input.version) ||
      input.version.kind !== 'files' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw Error('invalid_workspace_registration');
    const request = structuredClone(input);
    const snapshot = await this.control.snapshot();
    const { root, grant } = this.records(
      snapshot,
      request.projectId,
      request.rootId,
      request.grantId,
    );
    const versionScope = {
      projectId: request.projectId,
      taskId: request.taskId,
      rootId: root.rootId,
      policyHash: grant.policyHash,
    };
    await this.versions.read(request.version, versionScope);
    const workspace: WorkspaceRefV1 = {
      schemaVersion: 'workspace-v1',
      projectId: request.projectId,
      taskId: request.taskId,
      workspaceId: request.workspaceId,
      rootId: root.rootId,
      grantId: grant.grantId,
      purpose: 'validation',
      mode: 'direct',
      baselineManifestId: request.version.manifestId,
    };
    const existing = snapshot.operations.find((o) => o.actionId === request.actionId);
    if (existing) {
      if (
        !isLocalBindingOperation(existing) ||
        existing.projectId !== request.projectId ||
        existing.taskId !== request.taskId ||
        existing.preparedRevision - 1 !== request.expectedRevision ||
        !existing.nextLocalExecution.workspaces.some(
          (w) => localRecordHash(w) === localRecordHash(workspace),
        ) ||
        !existing.nextLocalExecution.bindings.some(
          (b) =>
            b.workerId === request.workerId &&
            b.workspaceId === request.workspaceId &&
            b.receiptId === existing.receiptId,
        )
      )
        throw Error('operation_conflict');
      await this.control.recover(existing.actionId, existing.inputHash);
      await this.verifyGrant(request, grant.grantId);
      return workspace;
    }
    if (snapshot.revision !== request.expectedRevision) throw Error('registry_revision_conflict');
    const state = await this.control.assertClosed(request);
    const worker = state.workers.find((w) => w.workerId === request.workerId);
    if (
      !worker ||
      !['ARCHITECT', 'TESTER', 'REVIEWER'].includes(worker.role) ||
      !['pending', 'running'].includes(worker.status) ||
      state.localExecution?.bindings.some((b) => b.workerId === request.workerId) ||
      snapshot.workspaces.some((w) => w.workspaceId === request.workspaceId)
    )
      throw Error('workspace_assignment_mismatch');
    if (!grant.actions.includes('read')) throw Error('authorization_closed');
    await this.verifyGrant(request, grant.grantId);
    await this.initialized(snapshot, request, root, grant);
    const readerBinding = await this.readerBinding(
      state,
      request.workerId,
      request.version,
      root,
      grant,
    );
    await this.versions.verify(request.version, versionScope, readerBinding, async () => {
      await this.verifyGrant(request, grant.grantId);
      const current = await this.control.assertClosed(request);
      return (
        (await this.control.snapshot()).revision === snapshot.revision &&
        localRecordHash(current.workers.find((w) => w.workerId === request.workerId) ?? null) ===
          localRecordHash(worker)
      );
    });
    const next = structuredClone(state.localExecution);
    if (!next) throw Error('workspace_binding_missing');
    next.workspaces.push(workspace);
    next.bindings.push({
      workerId: request.workerId,
      workspaceId: request.workspaceId,
      receiptId: `binding:${request.actionId}`,
      ...(worker.subtaskId === undefined ? {} : { subtaskId: worker.subtaskId }),
    });
    await this.control.commitBinding({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      sourceMessageId: grant.leaderMessageId,
      expectedRevision: request.expectedRevision,
      nextLocalExecution: next,
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        workspaces: [...snapshot.workspaces, workspace],
        claims: snapshot.claims,
      },
    });
    return workspace;
  }
  /** Trusted lifecycle only: no tool operation is admitted by this method. */
  async assertQuiescence(input: WorkspaceCall) {
    return this.assert(input, 'read', true);
  }
  private async assert(
    input: WorkspaceCall,
    action: LocalGrantRecord['actions'][number],
    closing: boolean,
  ) {
    if (!isWorkspaceCall(input)) throw Error('invalid_workspace_call');
    const call = structuredClone(input);
    this.assertLease(call);
    const state = await this.control.assertClosed(call),
      snapshot = await this.control.snapshot();
    const workspace = snapshot.workspaces.find(
      (w) =>
        w.workspaceId === call.workspaceId &&
        w.projectId === call.projectId &&
        w.taskId === call.taskId,
    );
    const binding = state.localExecution?.bindings.find(
      (b) => b.workerId === call.workerId && b.workspaceId === call.workspaceId,
    );
    const worker = state.workers.find(
      (w) => w.workerId === call.workerId && w.subtaskId === binding?.subtaskId,
    );
    if (
      !workspace ||
      (workspace.mode === 'linked-worktree' && !this.git) ||
      !binding ||
      !worker ||
      (!closing && worker.status !== 'running') ||
      !state.localExecution?.workspaces.some(
        (w) => localRecordHash(w) === localRecordHash(workspace),
      )
    )
      throw Error('workspace_assignment_mismatch');
    if (!closing)
      assertLocalRangeAdmission(snapshot, workspace, localWorkerDependencies(state, call.workerId));
    const { root, grant } = this.records(
      snapshot,
      call.projectId,
      workspace.rootId,
      workspace.grantId,
    );
    const claim = snapshot.claims.find(
      (c) =>
        c.projectId === call.projectId &&
        c.taskId === call.taskId &&
        c.workspaceId === call.workspaceId &&
        c.workerId === call.workerId &&
        c.writerEpoch === call.writerEpoch &&
        c.status === 'active',
    );
    const linkedReviewer =
      workspace.mode === 'linked-worktree' &&
      workspace.purpose === 'validation' &&
      worker.role === 'REVIEWER';
    const reader =
      (workspace.mode === 'direct' && workspace.purpose === 'validation') || linkedReviewer;
    if (
      (reader
        ? call.writerEpoch !== 0 ||
          claim !== undefined ||
          !['ARCHITECT', 'TESTER', 'REVIEWER'].includes(worker.role) ||
          !(action === 'read' || (worker.role === 'TESTER' && action === 'run'))
        : !claim ||
          (workspace.purpose === 'coding'
            ? worker.role !== 'CODER'
            : workspace.mode !== 'linked-worktree' ||
              workspace.purpose !== 'validation' ||
              worker.role !== 'TESTER')) ||
      grant.revision !== call.grantRevision ||
      !grant.actions.includes(action)
    )
      throw Error('authorization_closed');
    const origin = snapshot.operations.find((o) =>
      reader ? o.receiptId === binding.receiptId : o.actionId === claim?.createdActionId,
    );
    if (
      !origin ||
      !isLocalBindingOperation(origin) ||
      origin.stage !== 'committed' ||
      origin.projectId !== call.projectId ||
      origin.taskId !== call.taskId ||
      origin.receiptId !== binding.receiptId ||
      !state.localExecution?.receipts.some(
        (r) => r.receiptId === origin.receiptId && r.inputHash === origin.inputHash,
      )
    )
      throw Error('workspace_binding_incomplete');
    let reviewerSourceReceiptId: string | undefined;
    if (linkedReviewer) {
      const dispatch = currentReviewDispatch(state);
      const reviewBinding = dispatch?.payload.reviewBinding;
      const dispatchedWorkers = dispatch?.payload.workerIds;
      const receipt = isReviewBinding(reviewBinding)
        ? validationReceipt(state, reviewBinding.validationReceiptId)
        : undefined;
      const sourceWorker = state.workers.find((entry) => entry.workerId === receipt?.workerId);
      const sourceBinding = state.localExecution?.bindings.find(
        (entry) => entry.workerId === receipt?.workerId,
      );
      const sourceOperation = snapshot.operations.find(
        (entry) => entry.receiptId === sourceBinding?.receiptId,
      );
      const reviewerOperation = snapshot.operations.find(
        (entry) => entry.receiptId === binding.receiptId,
      );
      if (
        !dispatch ||
        !receipt ||
        !isReviewBinding(reviewBinding) ||
        !Array.isArray(dispatchedWorkers) ||
        dispatchedWorkers.length !== 1 ||
        dispatchedWorkers[0] !== call.workerId ||
        call.workerId !== `worker:${dispatch.msgId}:0` ||
        state.phase !== 'review' ||
        state.nextRole !== 'REVIEWER' ||
        sourceWorker?.status !== 'done' ||
        localRecordHash(sourceWorker.worktree) !== localRecordHash(receipt.worktree) ||
        sourceBinding?.workspaceId !== call.workspaceId ||
        sourceBinding.receiptId === binding.receiptId ||
        !sourceOperation ||
        !isLocalBindingOperation(sourceOperation) ||
        sourceOperation.stage !== 'committed' ||
        !state.localExecution?.receipts.some(
          (entry) =>
            entry.receiptId === sourceOperation.receiptId &&
            entry.inputHash === sourceOperation.inputHash,
        ) ||
        reviewerOperation?.actionId !== `review-binding:${dispatch.msgId}` ||
        !isWorktreeRef(worker.worktree) ||
        localRecordHash(worker.worktree) !== localRecordHash(receipt.worktree) ||
        reviewBinding.commit !== receipt.worktree.headCommit ||
        snapshot.claims.some(
          (entry) =>
            entry.projectId === call.projectId &&
            entry.taskId === call.taskId &&
            entry.workerId === call.workerId &&
            entry.status === 'active',
        )
      )
        throw Error('workspace_assignment_mismatch');
      reviewerSourceReceiptId = sourceBinding.receiptId;
    }
    await this.verifyGrant(call, grant.grantId);
    await this.initialized(snapshot, call, root, grant);
    let physicalRoot = root;
    if (workspace.mode === 'linked-worktree') {
      const record = snapshot.linkedRoots?.find((r) => r.workspaceId === workspace.workspaceId);
      const mapping = state.localExecution.git?.worktrees.find(
        (m) => m.workspaceId === workspace.workspaceId,
      );
      const ref = worker.worktree;
      if (
        !this.git ||
        !record ||
        !mapping ||
        !isWorktreeRef(ref) ||
        record.bindingReceiptId !== (reviewerSourceReceiptId ?? binding.receiptId) ||
        mapping.receiptId !== (reviewerSourceReceiptId ?? binding.receiptId) ||
        ref.path !== record.path ||
        mapping.path !== record.path ||
        ref.branch !== workspace.branch ||
        ref.baseCommit !== workspace.baseCommit
      )
        throw Error('workspace_assignment_mismatch');
      let reviewVersion: WorkspaceVersionV1 | undefined;
      if (linkedReviewer) {
        if (!this.verifyReviewCandidate) throw Error('local_git_review_proof_unavailable');
        reviewVersion = await this.verifyReviewCandidate(state, call.workerId);
        if (reviewVersion.kind !== 'git' || reviewVersion.commit !== ref.headCommit)
          throw Error('local_git_review_binding_changed');
      }
      const linkedInput = {
        ...this.git,
        projectId: call.projectId,
        taskId: call.taskId,
        root: root.path,
        sourceRoot: root,
        workspace,
        record,
        expectedHead: ref.headCommit ?? ref.baseCommit,
        actionId: record.initialization.actionId,
        creationActionId: record.creation.actionId,
        bindingReceiptId: record.bindingReceiptId,
        authorize: async () => {
          this.assertLease(call);
          await this.verifyGrant(call, grant.grantId);
          const current = await this.control.assertClosed(call);
          if (
            (await this.control.snapshot()).revision !== snapshot.revision ||
            localRecordHash(current.localExecution) !== localRecordHash(state.localExecution) ||
            localRecordHash(current.workers.find((w) => w.workerId === call.workerId) ?? null) !==
              localRecordHash(worker)
          )
            throw Error('workspace_assignment_mismatch');
          this.assertLease(call);
          return true;
        },
      };
      await verifyLocalLinkedRoot(linkedInput);
      if (linkedReviewer) {
        if (!this.reviewObjects || !reviewVersion)
          throw Error('local_git_review_proof_unavailable');
        await new LocalGitVersionStore(this.reviewObjects, this.versions).verify(
          reviewVersion,
          {
            projectId: call.projectId,
            taskId: call.taskId,
            rootId: root.rootId,
            policyHash: grant.policyHash,
          },
          linkedInput,
        );
        const verified = await this.verifyReviewCandidate?.(state, call.workerId);
        if (!verified || localRecordHash(verified) !== localRecordHash(reviewVersion))
          throw Error('local_git_review_binding_changed');
        await linkedInput.authorize();
      }
      physicalRoot = {
        ...root,
        path: record.path,
        volumeId: record.volumeId,
        dev: record.dev,
        inode: record.inode,
        chain: structuredClone(record.chain),
        staging: structuredClone(record.staging),
        inspectionHash: record.inspectionHash,
      };
    }
    let fixedBinding =
      workspace.mode === 'direct' && workspace.purpose === 'validation'
        ? await this.readerBinding(
            state,
            call.workerId,
            {
              kind: 'files',
              manifestId: workspace.baselineManifestId,
              manifestHash: workspace.baselineManifestId.slice(9),
            },
            root,
            grant,
          )
        : localRootBinding(physicalRoot);
    const repair = deliveryRepairAssignment(state, call.workerId);
    if (origin.deliveryTransition?.kind === 'delivery-repair-start-v1' || repair) {
      if (
        !repair ||
        origin.deliveryTransition?.kind !== 'delivery-repair-start-v1' ||
        origin.deliveryTransition.workspaceId !== workspace.workspaceId ||
        origin.actionId !== repair.message.msgId ||
        !this.deliveryRepairs ||
        !this.verifyRepairSource
      )
        throw Error('delivery_repair_proof_unavailable');
      await this.verifyRepairSource(state, call.workerId);
      fixedBinding = await this.deliveryRepairs.workspaceBinding(
        state,
        call.workerId,
        grant,
        async () => {
          this.assertLease(call);
          await this.verifyGrant(call, grant.grantId);
          return true;
        },
      );
    }
    this.assertLease(call);
    const latestState = await this.control.assertClosed(call);
    if (
      localRecordHash(latestState.localExecution ?? null) !==
        localRecordHash(state.localExecution ?? null) ||
      localRecordHash(latestState.workers.find((w) => w.workerId === call.workerId) ?? null) !==
        localRecordHash(worker)
    )
      throw Error('workspace_assignment_mismatch');
    if ((await this.control.snapshot()).revision !== snapshot.revision)
      throw Error('registry_revision_conflict');
    this.assertLease(call);
    return {
      workspace,
      root: physicalRoot,
      grant,
      claim,
      binding: fixedBinding,
      sourceReceiptId: origin.receiptId,
    };
  }
}
