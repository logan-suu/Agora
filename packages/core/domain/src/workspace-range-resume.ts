/** Historical registration only. This pure reader neither admits a worker nor
 * starts a session; native proof and current authorization belong to the host. */
import type { AppState } from './state';
import { workspaceVersionChanges } from './workspace-version-change';
export interface WorkspaceRangeResume {
  kind: 'workspace_range_resume';
  version: 1;
  projectId: string;
  taskId: string;
  resumeId: string;
  takeoverId: string;
  returnActionId: string;
  changeId: string;
  workerId: string;
  sourceSessionId: string;
  sourceSafePointRef: string;
  resumeSessionId: string;
  privateProofHash: string;
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export function isWorkspaceRangeResume(v: unknown): v is WorkspaceRangeResume {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !==
      'changeId,kind,privateProofHash,projectId,resumeId,resumeSessionId,returnActionId,sourceSafePointRef,sourceSessionId,takeoverId,taskId,version,workerId'
  )
    return false;
  const p = v as Record<string, unknown>;
  return (
    p.kind === 'workspace_range_resume' &&
    p.version === 1 &&
    [
      'projectId',
      'taskId',
      'takeoverId',
      'returnActionId',
      'workerId',
      'sourceSessionId',
      'resumeSessionId',
    ].every((k) => id(p[k])) &&
    p.sourceSessionId !== p.resumeSessionId &&
    typeof p.sourceSafePointRef === 'string' &&
    p.sourceSafePointRef.length > 0 &&
    p.sourceSafePointRef.length <= 4096 &&
    typeof p.resumeId === 'string' &&
    /^workspace-resume:[a-f0-9]{64}$/.test(p.resumeId) &&
    typeof p.changeId === 'string' &&
    /^workspace-change:[a-f0-9]{64}$/.test(p.changeId) &&
    typeof p.privateProofHash === 'string' &&
    /^[a-f0-9]{64}$/.test(p.privateProofHash)
  );
}
export function workspaceRangeResumes(state: AppState): WorkspaceRangeResume[] {
  const changes = workspaceVersionChanges(state),
    result: WorkspaceRangeResume[] = [],
    seen = new Set<string>();
  for (const [index, message] of state.messages.entries()) {
    if (message.payload.kind !== 'workspace_range_resume') continue;
    const p = message.payload;
    if (
      !isWorkspaceRangeResume(p) ||
      !state.localExecution ||
      message.msgId !== p.resumeId ||
      message.fromRole !== 'COORDINATOR' ||
      message.channelId !== 'main' ||
      message.type !== 'announce' ||
      !Number.isSafeInteger(message.ts) ||
      message.ts < 0 ||
      p.projectId !== state.projectId ||
      p.taskId !== state.taskId ||
      seen.has(p.resumeId) ||
      !state.workers.some((w) => w.workerId === p.workerId)
    )
      throw Error('workspace_range_resume_invalid');
    const change = changes.find((c) => c.changeId === p.changeId);
    if (
      !change ||
      change.takeoverId !== p.takeoverId ||
      change.returnActionId !== p.returnActionId ||
      !change.affectedWorkerIds.includes(p.workerId) ||
      state.messages.findIndex((m) => m.msgId === p.changeId) >= index ||
      result.some((r) => r.takeoverId === p.takeoverId && r.workerId === p.workerId)
    )
      throw Error('workspace_range_resume_invalid');
    seen.add(p.resumeId);
    result.push(structuredClone(p));
  }
  return result;
}
