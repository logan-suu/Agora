/** Canonical data facts only. Private native proofs and present execution authority
 * are verified by the trusted host; this module never reads files or grants access. */
import { isLocalValidationReceipt } from './local-validation';
import { isWorkspaceVersionV1, type WorkspaceVersionV1 } from './local-workspace';
import { canonicalJson, isWaveValidationReceipt } from './parallel-execution';
import type { AppState } from './state';
import { parseWorkspaceControl } from './workspace-control';
import { workspaceUndoResults } from './workspace-undo-result';
export interface WorkspaceVersionChange {
  kind: 'workspace_version_change';
  version: 1;
  projectId: string;
  taskId: string;
  changeId: string;
  takeoverId: string;
  returnActionId: string;
  source: {
    projectId: string;
    taskId: string;
    msgId: string;
    workspaceId: string;
    rootId: string;
    grantId: string;
    grantRevision: number;
  };
  workspaceIds: string[];
  affectedWorkerIds: string[];
  heldVersion: WorkspaceVersionV1;
  returnedVersion: WorkspaceVersionV1;
  privateProofHash: string;
  invalidatedValidationIds: string[];
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const exact = (v: unknown, names: string): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names;
const ids = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 4096 && v.every(id) && new Set(v).size === v.length;
function fail(): never {
  throw Error('workspace_version_change_invalid');
}
export function isWorkspaceVersionChange(v: unknown): v is WorkspaceVersionChange {
  if (
    !exact(
      v,
      'affectedWorkerIds,changeId,heldVersion,invalidatedValidationIds,kind,privateProofHash,projectId,returnActionId,returnedVersion,source,takeoverId,taskId,version,workspaceIds',
    ) ||
    v.kind !== 'workspace_version_change' ||
    v.version !== 1 ||
    ![v.projectId, v.taskId, v.takeoverId, v.returnActionId].every(id) ||
    typeof v.changeId !== 'string' ||
    !/^workspace-change:[a-f0-9]{64}$/.test(v.changeId) ||
    typeof v.privateProofHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.privateProofHash) ||
    !exact(v.source, 'grantId,grantRevision,msgId,projectId,rootId,taskId,workspaceId') ||
    ![
      v.source.projectId,
      v.source.taskId,
      v.source.msgId,
      v.source.workspaceId,
      v.source.rootId,
      v.source.grantId,
    ].every(id) ||
    v.source.msgId !== v.returnActionId ||
    !Number.isSafeInteger(v.source.grantRevision) ||
    (v.source.grantRevision as number) < 0 ||
    !ids(v.workspaceIds) ||
    !v.workspaceIds.length ||
    !ids(v.affectedWorkerIds) ||
    !ids(v.invalidatedValidationIds) ||
    !isWorkspaceVersionV1(v.heldVersion) ||
    !isWorkspaceVersionV1(v.returnedVersion)
  )
    return false;
  return true;
}
export function workspaceVersionChanges(state: AppState): WorkspaceVersionChange[] {
  const changes: WorkspaceVersionChange[] = [],
    seen = new Set<string>();
  for (const [index, message] of state.messages.entries()) {
    if (message.payload?.kind !== 'workspace_version_change') continue;
    const fact = message.payload;
    if (
      !state.localExecution ||
      !isWorkspaceVersionChange(fact) ||
      message.fromRole !== 'COORDINATOR' ||
      message.channelId !== 'main' ||
      message.type !== 'announce' ||
      message.msgId !== fact.changeId ||
      fact.projectId !== state.projectId ||
      fact.taskId !== state.taskId ||
      seen.has(fact.changeId) ||
      !Number.isSafeInteger(message.ts) ||
      message.ts < 0 ||
      fact.workspaceIds.some(
        (id) => !state.localExecution?.workspaces.some((w) => w.workspaceId === id),
      ) ||
      fact.affectedWorkerIds.some((id) => !state.workers.some((w) => w.workerId === id))
    )
      fail();
    if (fact.source.projectId === state.projectId && fact.source.taskId === state.taskId) {
      const sources = state.messages.filter((m) => m.msgId === fact.source.msgId);
      const source = sources[0],
        intent = source ? parseWorkspaceControl(source.display) : undefined;
      if (
        sources.length !== 1 ||
        !source ||
        state.messages.indexOf(source) >= index ||
        source.fromRole !== 'leader' ||
        source.channelId !== 'main' ||
        source.payload.kind !== 'leader_intent' ||
        !exact(source.payload.action, 'status') ||
        source.payload.action.status !== 'applied' ||
        canonicalJson(source.payload.intent) !== canonicalJson(intent) ||
        intent?.verb !== 'return' ||
        intent.takeoverReceiptId !== fact.takeoverId ||
        intent.actionId !== fact.returnActionId ||
        intent.projectId !== state.projectId ||
        intent.taskId !== state.taskId
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
    seen.add(fact.changeId);
    changes.push(structuredClone(fact));
  }
  return changes;
}
/** Historical receipt readers stay available. Only use this for current
 * integration/review/completion/application qualification. */
export function assertWorkspaceValidationCurrent(state: AppState, receiptId: string): void {
  if (
    [...workspaceVersionChanges(state), ...workspaceUndoResults(state)].some((c) =>
      c.invalidatedValidationIds.includes(receiptId),
    )
  )
    throw Error('workspace_version_changed');
}
