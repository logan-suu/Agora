/** Registry-backed workspace admission. This service never accepts a model
 * assertion of authority; the composition supplies a live lease verifier. */
import {
  isWorkspaceCall,
  isWorkspaceVersionV1,
  type WorkspaceCall,
  type WorkspaceRefV1,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalRootBinding } from './local-file-transaction';
import {
  isLocalBindingOperation,
  type LocalClaimRecord,
  type LocalGrantRecord,
  type LocalRegistryRecords,
  type LocalRootRecord,
  localRecordHash,
} from './local-registry-records';
import type { LocalRootCoordinator } from './local-root-coordinator';
import type { LocalVersionStore } from './local-version-store';

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
export function localRootBinding(root: LocalRootRecord): LocalRootBinding {
  if (!root.staging) throw Error('workspace_root_not_initialized');
  return {
    root: root.path,
    chain: structuredClone(root.chain),
    stagingIdentity: root.staging.identity,
  };
}
export class LocalWorkspaceAuthority {
  constructor(
    private readonly control: LocalBindingCoordinator,
    private readonly roots: LocalRootCoordinator,
    private readonly versions: LocalVersionStore,
    private readonly assertLease: (call: WorkspaceCall) => void,
    private readonly verifyGrant: (scope: Scope, grantId: string) => Promise<void>,
    private readonly verifyClaimClosure?: (claim: LocalClaimRecord) => Promise<string>,
  ) {}
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
    const { root, grant } = this.records(
      snapshot,
      scope.projectId,
      workspace.rootId,
      workspace.grantId,
    );
    if (!grant.actions.includes('read')) throw Error('authorization_closed');
    await this.initialized(snapshot, scope, root, grant);
    await this.versions.verify(
      version,
      {
        projectId: scope.projectId,
        taskId: scope.taskId,
        rootId: root.rootId,
        policyHash: grant.policyHash,
      },
      localRootBinding(root),
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
    await this.versions.verify(request.version, versionScope, localRootBinding(root), async () => {
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
      !binding ||
      !worker ||
      (!closing && worker.status !== 'running') ||
      !state.localExecution?.workspaces.some(
        (w) => localRecordHash(w) === localRecordHash(workspace),
      )
    )
      throw Error('workspace_assignment_mismatch');
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
    const reader = workspace.purpose === 'validation';
    if (
      (reader
        ? call.writerEpoch !== 0 ||
          claim !== undefined ||
          !['ARCHITECT', 'TESTER', 'REVIEWER'].includes(worker.role) ||
          !(action === 'read' || (worker.role === 'TESTER' && action === 'run'))
        : !claim) ||
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
      !state.localExecution?.receipts.some(
        (r) => r.receiptId === origin.receiptId && r.inputHash === origin.inputHash,
      )
    )
      throw Error('workspace_binding_incomplete');
    await this.verifyGrant(call, grant.grantId);
    await this.initialized(snapshot, call, root, grant);
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
      root,
      grant,
      claim,
      binding: localRootBinding(root),
      sourceReceiptId: origin.receiptId,
    };
  }
}
