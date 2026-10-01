import { deliveryRepairAssignment } from './local-delivery-repair';
import {
  assertLocalDeliveryTransition,
  isLocalDeliveryStateV1,
  type LocalDeliveryStateV1,
} from './local-delivery-round';
import {
  assertLocalGitState,
  assertLocalGitTransition,
  isLocalGitBinding,
  type LocalGitBinding,
} from './local-git-bindings';
import {
  assertWorkspaceRefsTransition,
  isWorkspaceRefsV1,
  isWorkspaceVersionV1,
  type WorkspaceRefV1,
} from './local-workspace';
import type { AppState } from './state';

export interface LocalExecutionReceiptRef {
  receiptId: string;
  actionId: string;
  inputHash: string;
  registryRevision: number;
}
export interface LocalWorkerBinding {
  workerId: string;
  subtaskId?: string;
  workspaceId: string;
  receiptId: string;
}
/** Canonical data references; execution still requires the trusted registry. */
export interface LocalExecutionV1 {
  schemaVersion: 'local-execution-v1';
  rootIds: string[];
  workspaces: WorkspaceRefV1[];
  bindings: LocalWorkerBinding[];
  receipts: LocalExecutionReceiptRef[];
  git?: LocalGitBinding;
  delivery?: LocalDeliveryStateV1;
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const fields = (value: unknown, names: string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype) &&
    Reflect.ownKeys(value).length === names.length &&
    names.every((name) => {
      const d = Object.getOwnPropertyDescriptor(value, name);
      return d?.enumerable === true && Object.hasOwn(d, 'value');
    })
  );
};
const list = (v: unknown): v is unknown[] =>
  Array.isArray(v) &&
  Object.getPrototypeOf(v) === Array.prototype &&
  v.length <= 4096 &&
  Reflect.ownKeys(v).length === v.length + 1 &&
  Array.from({ length: v.length }, (_, index) =>
    Object.getOwnPropertyDescriptor(v, String(index)),
  ).every((d) => d?.enumerable && Object.hasOwn(d, 'value'));

export function isLocalExecutionV1(value: unknown): value is LocalExecutionV1 {
  const hasGit = value !== null && typeof value === 'object' && Object.hasOwn(value, 'git');
  const hasDelivery =
    value !== null && typeof value === 'object' && Object.hasOwn(value, 'delivery');
  if (
    !fields(value, [
      'schemaVersion',
      'rootIds',
      'workspaces',
      'bindings',
      'receipts',
      ...(hasGit ? ['git'] : []),
      ...(hasDelivery ? ['delivery'] : []),
    ]) ||
    (hasGit && !isLocalGitBinding(value.git)) ||
    (hasDelivery && !isLocalDeliveryStateV1(value.delivery)) ||
    value.schemaVersion !== 'local-execution-v1' ||
    !list(value.rootIds) ||
    !value.rootIds.every(id) ||
    new Set(value.rootIds).size !== value.rootIds.length ||
    !isWorkspaceRefsV1(value.workspaces) ||
    !list(value.bindings) ||
    !list(value.receipts)
  )
    return false;
  const workers = new Set<string>();
  for (const binding of value.bindings) {
    const hasSubtask =
      binding !== null && typeof binding === 'object' && Object.hasOwn(binding, 'subtaskId');
    if (
      !fields(binding, [
        'workerId',
        ...(hasSubtask ? ['subtaskId'] : []),
        'workspaceId',
        'receiptId',
      ]) ||
      !Object.values(binding).every(id) ||
      workers.has(binding.workerId as string)
    )
      return false;
    workers.add(binding.workerId as string);
  }
  const receipts = new Set<string>();
  const actions = new Set<string>();
  for (const receipt of value.receipts) {
    if (
      !fields(receipt, ['receiptId', 'actionId', 'inputHash', 'registryRevision']) ||
      !id(receipt.receiptId) ||
      !id(receipt.actionId) ||
      typeof receipt.inputHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.inputHash) ||
      typeof receipt.registryRevision !== 'number' ||
      !Number.isSafeInteger(receipt.registryRevision) ||
      receipt.registryRevision < 0 ||
      receipts.has(receipt.receiptId) ||
      actions.has(receipt.actionId)
    )
      return false;
    receipts.add(receipt.receiptId);
    actions.add(receipt.actionId);
  }
  const local = value as unknown as LocalExecutionV1;
  if (
    local.delivery !== undefined &&
    (!local.rootIds.includes(local.delivery.rootId) ||
      local.delivery.rounds.some(
        (round) =>
          !local.workspaces.some(
            (workspace) =>
              workspace.rootId === local.delivery?.rootId && workspace.grantId === round.grantId,
          ),
      ))
  )
    return false;
  return true;
}

export function assertLocalExecutionState(state: AppState): void {
  const local = state.localExecution;
  if (local === undefined) {
    if (state.testResults?.workspaceVersion !== undefined)
      throw new Error('workspace_version_without_local_execution');
    return;
  }
  if (!isLocalExecutionV1(local)) throw new Error('invalid_local_execution');
  if (
    local.git === undefined &&
    (state.integration !== undefined ||
      state.parallelExecution !== undefined ||
      state.workers.some((w) => w.worktree !== undefined) ||
      state.subtasks.some((s) => s.worktree !== undefined))
  )
    throw new Error('mixed_workspace_authority');
  const roots = new Set(local.rootIds);
  const workspaces = new Map(local.workspaces.map((w) => [w.workspaceId, w]));
  const receipts = new Set(local.receipts.map((r) => r.receiptId));
  if (
    local.workspaces.some(
      (w) => w.projectId !== state.projectId || w.taskId !== state.taskId || !roots.has(w.rootId),
    )
  )
    throw new Error('workspace_scope_mismatch');
  for (const binding of local.bindings) {
    const workers = state.workers.filter((w) => w.workerId === binding.workerId);
    const subtasks = state.subtasks.filter((s) => s.id === binding.subtaskId);
    const workspace = workspaces.get(binding.workspaceId);
    const repair =
      binding.subtaskId === undefined &&
      workers[0]?.role === 'CODER' &&
      deliveryRepairAssignment(state, binding.workerId) !== undefined;

    if (
      workspace?.purpose === 'delivery' ||
      workers.length !== 1 ||
      workers[0]?.subtaskId !== binding.subtaskId ||
      (binding.subtaskId !== undefined && subtasks.length !== 1) ||
      (binding.subtaskId === undefined &&
        (workspace?.purpose === 'coding' || workers[0]?.role === 'CODER') &&
        !repair) ||
      !workspace ||
      !receipts.has(binding.receiptId)
    )
      throw new Error('invalid_local_worker_binding');
  }
  if (local.git !== undefined) assertLocalGitState(state, local);
  if (state.testResults !== undefined) {
    const version = state.testResults.workspaceVersion;
    if (
      !isWorkspaceVersionV1(version) ||
      !local.workspaces.some(
        (w) => w.mode === (version.kind === 'files' ? 'direct' : 'linked-worktree'),
      )
    )
      throw new Error('invalid_local_test_version');
  }
}

export function assertLocalExecutionTransition(
  previous: LocalExecutionV1 | undefined,
  next: unknown,
): asserts next is LocalExecutionV1 {
  if (!isLocalExecutionV1(next)) throw new Error('invalid_local_execution');
  if (previous === undefined) return;
  if (!isLocalExecutionV1(previous)) throw new Error('invalid_local_execution');
  assertWorkspaceRefsTransition(previous.workspaces, next.workspaces);
  assertLocalGitTransition(previous.git, next.git);
  assertLocalDeliveryTransition(previous.delivery, next.delivery);
  if (previous.rootIds.some((id) => !next.rootIds.includes(id)))
    throw new Error('local_root_identity_changed');
  for (const [oldItems, newItems, key] of [
    [previous.bindings, next.bindings, 'workerId'],
    [previous.receipts, next.receipts, 'receiptId'],
  ] as const) {
    for (const old of oldItems) {
      const entry = newItems.find(
        (item) =>
          (item as unknown as Record<string, unknown>)[key] ===
          (old as unknown as Record<string, unknown>)[key],
      );
      if (
        !entry ||
        Object.keys(entry).length !== Object.keys(old).length ||
        Object.entries(old).some(
          ([field, value]) => (entry as unknown as Record<string, unknown>)[field] !== value,
        )
      )
        throw new Error('local_execution_identity_changed');
    }
  }
}
