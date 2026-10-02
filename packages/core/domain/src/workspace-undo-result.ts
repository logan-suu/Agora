/** Canonical undo history and present-qualification invalidation only. Native
 * effect/proposal proofs and current authority belong to the trusted host. */
import { isLocalValidationReceipt } from './local-validation';
import { isWorkspaceVersionV1, type WorkspaceVersionV1 } from './local-workspace';
import { canonicalJson, isWaveValidationReceipt } from './parallel-execution';
import type { AppState } from './state';
import { parseWorkspaceControl } from './workspace-control';
export interface WorkspaceUndoResult {
  kind: 'workspace_undo_result';
  version: 1;
  projectId: string;
  taskId: string;
  resultId: string;
  source: {
    projectId: string;
    taskId: string;
    msgId: string;
    workspaceId: string;
    fileApplyReceiptId: string;
    inputHash: string;
  };
  workspaceIds: string[];
  originalReceiptHash: string;
  privateProofHash: string;
  stage: 'applied' | 'conflict' | 'partial' | 'recoveryRequired';
  currentVersion: WorkspaceVersionV1 | null;
  invalidatedValidationIds: string[];
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v: unknown, keys: string): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys;
const ids = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 4096 && v.every(id) && new Set(v).size === v.length;
export function isWorkspaceUndoResult(v: unknown): v is WorkspaceUndoResult {
  return (
    exact(
      v,
      'currentVersion,invalidatedValidationIds,kind,originalReceiptHash,privateProofHash,projectId,resultId,source,stage,taskId,version,workspaceIds',
    ) &&
    v.kind === 'workspace_undo_result' &&
    v.version === 1 &&
    [v.projectId, v.taskId].every(id) &&
    typeof v.resultId === 'string' &&
    /^workspace-undo:[a-f0-9]{64}$/.test(v.resultId) &&
    exact(v.source, 'fileApplyReceiptId,inputHash,msgId,projectId,taskId,workspaceId') &&
    [v.source.projectId, v.source.taskId, v.source.msgId, v.source.workspaceId].every(id) &&
    typeof v.source.fileApplyReceiptId === 'string' &&
    /^(apply|batch|tree):[a-f0-9]{64}$/.test(v.source.fileApplyReceiptId) &&
    hash(v.source.inputHash) &&
    hash(v.originalReceiptHash) &&
    hash(v.privateProofHash) &&
    ids(v.workspaceIds) &&
    v.workspaceIds.length > 0 &&
    ids(v.invalidatedValidationIds) &&
    ['applied', 'conflict', 'partial', 'recoveryRequired'].includes(v.stage as string) &&
    (v.currentVersion === null ? v.stage !== 'applied' : isWorkspaceVersionV1(v.currentVersion))
  );
}
function fail(): never {
  throw Error('workspace_undo_result_invalid');
}
export function workspaceUndoResults(state: AppState): WorkspaceUndoResult[] {
  const results: WorkspaceUndoResult[] = [],
    seen = new Set<string>();
  for (const [index, message] of state.messages.entries()) {
    if (message.payload.kind !== 'workspace_undo_result') continue;
    const fact = message.payload;
    if (
      !state.localExecution ||
      !isWorkspaceUndoResult(fact) ||
      message.fromRole !== 'COORDINATOR' ||
      message.channelId !== 'main' ||
      message.type !== 'announce' ||
      message.msgId !== fact.resultId ||
      fact.projectId !== state.projectId ||
      fact.taskId !== state.taskId ||
      seen.has(fact.resultId) ||
      !Number.isSafeInteger(message.ts) ||
      message.ts < 0 ||
      fact.workspaceIds.some(
        (id) => !state.localExecution?.workspaces.some((w) => w.workspaceId === id),
      )
    )
      fail();
    if (fact.source.projectId === state.projectId && fact.source.taskId === state.taskId) {
      const refs = state.messages.filter((m) => m.msgId === fact.source.msgId),
        source = refs[0],
        intent = source ? parseWorkspaceControl(source.display) : undefined;
      if (
        refs.length !== 1 ||
        !source ||
        state.messages.indexOf(source) >= index ||
        source.fromRole !== 'leader' ||
        source.channelId !== 'main' ||
        source.payload.kind !== 'leader_intent' ||
        !exact(source.payload.action, 'status') ||
        source.payload.action.status !== 'applied' ||
        canonicalJson(source.payload.intent) !== canonicalJson(intent) ||
        intent?.verb !== 'undo' ||
        intent.actionId !== fact.source.msgId ||
        intent.projectId !== state.projectId ||
        intent.taskId !== state.taskId ||
        intent.fileApplyReceiptId !== fact.source.fileApplyReceiptId ||
        intent.inputHash !== fact.source.inputHash
      )
        fail();
    }
    for (const receiptId of fact.invalidatedValidationIds) {
      const refs = state.messages.filter((m) => m.msgId === receiptId),
        ref = refs[0];
      if (
        refs.length !== 1 ||
        !ref ||
        state.messages.indexOf(ref) >= index ||
        ref.fromRole !== 'COORDINATOR' ||
        ref.channelId !== 'main' ||
        ref.type !== 'announce'
      )
        fail();
      const r = ref.payload;
      if (
        r.kind === 'workspace_validation'
          ? !isLocalValidationReceipt(r) ||
            receiptId !== `workspace-validation:${r.dispatchId}` ||
            r.projectId !== state.projectId ||
            r.taskId !== state.taskId
          : r.kind === 'wave_validation'
            ? !isWaveValidationReceipt(r) || receiptId !== r.receiptId
            : true
      )
        fail();
    }
    seen.add(fact.resultId);
    results.push(structuredClone(fact));
  }
  return results;
}
