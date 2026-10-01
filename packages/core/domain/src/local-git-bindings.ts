import type { LocalExecutionV1 } from './local-execution';
import { isWorkspaceRelativePath, type WorkspaceRefV1 } from './local-workspace';
import { type AppState, isWorktreeRef } from './state';

/** Immutable location references, never live filesystem or Git authority. */
export interface LocalGitBinding {
  version: 1;
  initialWorkspaceId: string;
  worktrees: { workspaceId: string; path: string; receiptId: string }[];
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
function fields(v: unknown, keys: string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return (
    (proto === Object.prototype || proto === null) &&
    Reflect.ownKeys(v).length === keys.length &&
    keys.every((key) => {
      const d = Object.getOwnPropertyDescriptor(v, key);
      return d?.enumerable && Object.hasOwn(d, 'value');
    })
  );
}
export function isLocalGitBinding(v: unknown): v is LocalGitBinding {
  if (
    !fields(v, ['version', 'initialWorkspaceId', 'worktrees']) ||
    v.version !== 1 ||
    !id(v.initialWorkspaceId) ||
    !Array.isArray(v.worktrees) ||
    Object.getPrototypeOf(v.worktrees) !== Array.prototype ||
    v.worktrees.length < 1 ||
    v.worktrees.length > 4096 ||
    Reflect.ownKeys(v.worktrees).length !== v.worktrees.length + 1
  )
    return false;
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (let i = 0; i < v.worktrees.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(v.worktrees, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const entry: unknown = descriptor.value;
    if (
      !fields(entry, ['workspaceId', 'path', 'receiptId']) ||
      !id(entry.workspaceId) ||
      !id(entry.receiptId) ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('/') ||
      entry.path.length > 4096 ||
      !isWorkspaceRelativePath(entry.path.slice(1)) ||
      ids.has(entry.workspaceId) ||
      paths.has(entry.path)
    )
      return false;
    ids.add(entry.workspaceId);
    paths.add(entry.path);
  }
  return ids.has(v.initialWorkspaceId);
}
export function assertLocalGitTransition(
  previous: LocalGitBinding | undefined,
  next: LocalGitBinding | undefined,
): void {
  if (!previous) return;
  if (!next || next.initialWorkspaceId !== previous.initialWorkspaceId)
    throw Error('local_git_identity_changed');
  for (const entry of previous.worktrees) {
    const found = next.worktrees.find((w) => w.workspaceId === entry.workspaceId);
    if (!found || found.path !== entry.path || found.receiptId !== entry.receiptId)
      throw Error('local_git_identity_changed');
  }
}

export function assertLocalGitState(state: AppState, local: LocalExecutionV1): void {
  const git = local.git;
  if (!git || !isLocalGitBinding(git)) throw Error('invalid_local_git_binding');
  const workspaces = new Map(local.workspaces.map((w) => [w.workspaceId, w]));
  const mappings = new Map(git.worktrees.map((w) => [w.workspaceId, w]));
  const receipts = new Set(local.receipts.map((r) => r.receiptId));
  const branches = new Set<string>();
  for (const mapping of git.worktrees) {
    const w = workspaces.get(mapping.workspaceId);
    if (w?.mode !== 'linked-worktree' || !receipts.has(mapping.receiptId))
      throw Error('invalid_local_git_binding');
    const branch = JSON.stringify([w.commonDirId, w.branch]);
    if (branches.has(branch)) throw Error('invalid_local_git_binding');
    branches.add(branch);
  }
  const initial = workspaces.get(git.initialWorkspaceId);
  if (initial?.mode !== 'linked-worktree' || initial.purpose !== 'integration')
    throw Error('invalid_local_git_binding');
  for (const workspace of local.workspaces) {
    if (workspace.mode !== 'linked-worktree') continue;
    if (
      !mappings.has(workspace.workspaceId) ||
      workspace.rootId !== initial.rootId ||
      workspace.commonDirId !== initial.commonDirId ||
      workspace.grantId !== initial.grantId
    )
      throw Error('invalid_local_git_binding');
  }
  if (
    state.parallelExecution &&
    (state.parallelExecution.initialBase.branch !== initial.branch ||
      state.parallelExecution.initialBase.commit !== initial.baseCommit)
  )
    throw Error('local_git_initial_base_mismatch');
  const mismatch = (): never => {
    throw Error('local_git_reference_mismatch');
  };
  const reference = (value: unknown, purpose: WorkspaceRefV1['purpose'], workspaceId?: string) => {
    if (!isWorktreeRef(value)) return mismatch();
    const mapping = workspaceId
      ? mappings.get(workspaceId)
      : git.worktrees.find((m) => m.path === value.path);
    const workspace = mapping && workspaces.get(mapping.workspaceId);
    if (
      !mapping ||
      workspace?.mode !== 'linked-worktree' ||
      workspace.purpose !== purpose ||
      workspace.commonDirId !== initial.commonDirId ||
      workspace.rootId !== initial.rootId ||
      workspace.grantId !== initial.grantId ||
      value.path !== mapping.path ||
      value.branch !== workspace.branch ||
      value.baseCommit !== workspace.baseCommit
    )
      return mismatch();
    return workspace;
  };
  const workerReference = (workerId: unknown, value: unknown, subtaskId?: string) => {
    const worker = state.workers.find((w) => w.workerId === workerId);
    const binding = local.bindings.find((b) => b.workerId === workerId);
    if (
      !worker ||
      !binding ||
      (subtaskId !== undefined && (worker.role !== 'CODER' || binding.subtaskId !== subtaskId))
    )
      return mismatch();
    const purpose = worker.role === 'CODER' ? 'coding' : 'validation';
    if (!['CODER', 'TESTER', 'REVIEWER'].includes(worker.role)) return mismatch();
    return reference(value, purpose, binding.workspaceId);
  };
  for (const worker of state.workers)
    if (worker.worktree !== undefined) workerReference(worker.workerId, worker.worktree);
  for (const subtask of state.subtasks) {
    if (subtask.worktree === undefined) continue;
    const matching = local.bindings.filter(
      (b) =>
        b.subtaskId === subtask.id &&
        mappings.get(b.workspaceId)?.path ===
          (typeof subtask.worktree === 'object' ? subtask.worktree.path : undefined),
    );
    if (matching.length !== 1) mismatch();
    workerReference(matching[0]?.workerId, subtask.worktree, subtask.id);
  }
  if (state.integration) {
    reference(state.integration.integrationWorktree, 'integration');
    for (const branch of state.integration.pendingBranches)
      workerReference(branch.workerId, branch.worktree, branch.subtaskId);
  }
  const validation = state.parallelExecution?.activeWave?.validation;
  if (validation?.worktree !== undefined) {
    const w = workerReference(validation.workerId, validation.worktree);
    if (w.purpose !== 'validation') mismatch();
  }
  for (const message of state.messages) {
    if (message.payload.kind !== 'wave_validation') continue;
    const w = workerReference(message.payload.workerId, message.payload.worktree);
    if (w.purpose !== 'validation') mismatch();
  }
}
