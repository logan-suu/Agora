/** One owner/one backend process. Durable journals, not this queue, govern recovery. */
import type { WorkspaceCall } from '@agora/core-domain';

type Scope = Pick<WorkspaceCall, 'projectId' | 'taskId' | 'workspaceId'>;
const queues = new Map<string, Promise<void>>();
const activities = new Map<string, Scope & { active: number; queued: number }>();
/** Actual unsettled host operations, including callers waiting for this queue.
 * This view cannot prove native effects or replace journal reconciliation. */
export function localWorkspaceOperationActivity(scope: Pick<Scope, 'projectId' | 'taskId'>) {
  return [...activities.values()]
    .filter((a) => a.projectId === scope.projectId && a.taskId === scope.taskId)
    .map((a) => ({ workspaceId: a.workspaceId, active: a.active, queued: a.queued }))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId, 'en'));
}
export async function serializeWorkspaceOperation<T>(
  call: Scope,
  work: () => Promise<T>,
): Promise<T> {
  const fixed = { ...call };
  const key = JSON.stringify([fixed.projectId, fixed.taskId, fixed.workspaceId]);
  let activity = activities.get(key);
  if (!activity) {
    activity = { ...fixed, active: 0, queued: 0 };
    activities.set(key, activity);
  }
  const current = activity;
  current.queued++;
  const result = (queues.get(key) ?? Promise.resolve()).then(async () => {
    current.queued--;
    current.active++;
    try {
      return await work();
    } finally {
      current.active--;
      if (!current.active && !current.queued) activities.delete(key);
    }
  });
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  try {
    return await result;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}
