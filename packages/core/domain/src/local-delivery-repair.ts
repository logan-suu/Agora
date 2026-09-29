/** Immutable repair references. These schemas never authorize filesystem access
 * or replace host verification of the private candidate and closed writer. */
import { isWorkspaceVersionV1, type WorkspaceVersionV1 } from './local-workspace';

export interface DeliveryRepairSource {
  roundId: string;
  validationReceiptId: string;
  sourceWorkspaceId: string;
  workspaceVersion: WorkspaceVersionV1;
  controlFingerprint: string;
  reason: 'tests_failed' | 'review_changes_requested' | 'leader_completion_changes_requested';
  triggerId: string;
  reviewId: string | null;
}
export interface DeliveryRepairDispatch {
  kind: 'delivery_repair_dispatch';
  nextRole: 'CODER';
  source: DeliveryRepairSource;
  workerIds: [string];
}
export interface DeliveryRepairCandidate {
  kind: 'workspace_delivery_repair_candidate';
  version: 1;
  projectId: string;
  taskId: string;
  roundId: string;
  dispatchId: string;
  workerId: string;
  workspaceId: string;
  workspaceVersion: WorkspaceVersionV1;
  controlFingerprint: string;
  closureReceiptId: string;
  proofHash: string;
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(v).length === keys.length &&
    keys.every((key) => {
      const field = Object.getOwnPropertyDescriptor(v, key);
      return field?.enumerable === true && Object.hasOwn(field, 'value');
    })
  );
}
export function isDeliveryRepairSource(v: unknown): v is DeliveryRepairSource {
  return (
    exact(v, [
      'roundId',
      'validationReceiptId',
      'sourceWorkspaceId',
      'workspaceVersion',
      'controlFingerprint',
      'reason',
      'triggerId',
      'reviewId',
    ]) &&
    id(v.roundId) &&
    id(v.validationReceiptId) &&
    id(v.sourceWorkspaceId) &&
    id(v.triggerId) &&
    hash(v.controlFingerprint) &&
    isWorkspaceVersionV1(v.workspaceVersion) &&
    v.workspaceVersion.kind === 'files' &&
    (v.reason === 'tests_failed'
      ? v.reviewId === null && v.triggerId === v.validationReceiptId
      : (v.reason === 'review_changes_requested' ||
          v.reason === 'leader_completion_changes_requested') &&
        id(v.reviewId) &&
        (v.reason !== 'review_changes_requested' || v.triggerId === v.reviewId))
  );
}
export function isDeliveryRepairDispatch(v: unknown): v is DeliveryRepairDispatch {
  if (
    !exact(v, ['kind', 'nextRole', 'source', 'workerIds']) ||
    v.kind !== 'delivery_repair_dispatch' ||
    v.nextRole !== 'CODER' ||
    !isDeliveryRepairSource(v.source) ||
    !Array.isArray(v.workerIds) ||
    Object.getPrototypeOf(v.workerIds) !== Array.prototype ||
    v.workerIds.length !== 1 ||
    Reflect.ownKeys(v.workerIds).length !== 2
  )
    return false;
  const worker = Object.getOwnPropertyDescriptor(v.workerIds, '0');
  return worker?.enumerable === true && Object.hasOwn(worker, 'value') && id(worker.value);
}
export function isDeliveryRepairCandidate(v: unknown): v is DeliveryRepairCandidate {
  return (
    exact(v, [
      'kind',
      'version',
      'projectId',
      'taskId',
      'roundId',
      'dispatchId',
      'workerId',
      'workspaceId',
      'workspaceVersion',
      'controlFingerprint',
      'closureReceiptId',
      'proofHash',
    ]) &&
    v.kind === 'workspace_delivery_repair_candidate' &&
    v.version === 1 &&
    [
      'projectId',
      'taskId',
      'roundId',
      'dispatchId',
      'workerId',
      'workspaceId',
      'closureReceiptId',
    ].every((key) => id(v[key])) &&
    v.workerId === `worker:${v.dispatchId}:0` &&
    hash(v.controlFingerprint) &&
    hash(v.proofHash) &&
    isWorkspaceVersionV1(v.workspaceVersion) &&
    v.workspaceVersion.kind === 'files'
  );
}

/** Canonical identity only; private copy, grant and lease are separate proofs. */
export function deliveryRepairAssignment(state: import('./state').AppState, workerId: string) {
  const matches = state.messages.filter(
    (m) =>
      m.payload.kind === 'delivery_repair_dispatch' &&
      (`worker:${m.msgId}:0` === workerId ||
        (Array.isArray(m.payload.workerIds) && m.payload.workerIds.includes(workerId))),
  );
  if (!matches.length) return undefined;
  const message = matches[0];
  const payload = message?.payload;
  if (
    matches.length !== 1 ||
    !message ||
    !isDeliveryRepairDispatch(payload) ||
    message.fromRole !== 'COORDINATOR' ||
    message.channelId !== 'main' ||
    message.type !== 'announce' ||
    workerId !== `worker:${message.msgId}:0` ||
    payload.workerIds[0] !== workerId
  )
    throw Error('delivery_repair_assignment_changed');
  const local = state.localExecution;
  const workers = state.workers.filter((w) => w.workerId === workerId);
  const bindings = local?.bindings.filter((b) => b.workerId === workerId) ?? [];
  const binding = bindings[0];
  const workspace = local?.workspaces.find((w) => w.workspaceId === binding?.workspaceId);
  const worker = workers[0];
  const round = local?.delivery?.rounds.find((r) => r.roundId === payload.source.roundId);
  if (
    workers.length !== 1 ||
    bindings.length !== 1 ||
    !worker ||
    !binding ||
    !round ||
    worker.role !== 'CODER' ||
    worker.subtaskId !== undefined ||
    binding.subtaskId !== undefined ||
    binding.receiptId !== `binding:${message.msgId}` ||
    !local?.receipts.some(
      (r) => r.receiptId === binding.receiptId && r.actionId === message.msgId,
    ) ||
    workspace?.purpose !== 'coding' ||
    workspace.mode !== 'direct' ||
    workspace.projectId !== state.projectId ||
    workspace.taskId !== state.taskId ||
    workspace.rootId !== local.delivery?.rootId ||
    workspace.grantId !== round.grantId ||
    workspace.baselineManifestId !== payload.source.workspaceVersion.manifestId ||
    payload.source.controlFingerprint !== round.controlFingerprint
  )
    throw Error('delivery_repair_assignment_changed');
  if (
    ['pending', 'running', 'paused'].includes(worker.status) &&
    (state.phase !== 'coding' ||
      state.nextRole !== 'CODER' ||
      local.delivery?.currentRoundId !== round.roundId)
  )
    throw Error('delivery_repair_assignment_changed');
  return structuredClone({ message, source: payload.source, worker, binding, workspace, round });
}
