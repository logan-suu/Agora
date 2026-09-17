/** One owner/one backend process. Durable journals, not this queue, govern recovery. */
import type { WorkspaceCall } from '@agora/core-domain';

const queues = new Map<string, Promise<void>>();
export async function serializeWorkspaceOperation<T>(
  call: WorkspaceCall,
  work: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([call.projectId, call.taskId, call.workspaceId]);
  const result = (queues.get(key) ?? Promise.resolve()).then(work);
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
