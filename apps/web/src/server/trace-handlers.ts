import type { TraceReader } from '@agora/runtime-executor';
import type { TaskStateStore } from '@agora/runtime-state';

import { jsonError, requiredString } from './http';

const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_TRACE_EVENTS = 2000;

export function createGetTrace(store: TaskStateStore, reader: TraceReader) {
  return async function getTrace(request: Request): Promise<Response> {
    const search = new URL(request.url).searchParams;
    const projectId = requiredString(search.get('projectId'));
    const taskId = requiredString(search.get('taskId'));
    if (!projectId || !taskId) return jsonError('projectId and taskId are required');
    if (!SAFE_SCOPE_SEGMENT.test(projectId) || !SAFE_SCOPE_SEGMENT.test(taskId)) {
      return jsonError('projectId and taskId must be safe path segments');
    }

    const rawMaxEvents = search.get('maxEvents');
    let maxEvents: number | undefined;
    if (rawMaxEvents !== null) {
      maxEvents = Number(rawMaxEvents);
      if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_TRACE_EVENTS) {
        return jsonError(`maxEvents must be an integer between 1 and ${MAX_TRACE_EVENTS}`);
      }
    }

    const scope = { projectId, taskId };
    let state: Awaited<ReturnType<TaskStateStore['load']>>;
    try {
      state = await store.load(scope);
    } catch {
      return jsonError('task state is unavailable', 500);
    }
    if (state === undefined) return jsonError('task not found', 404);

    try {
      return Response.json(await reader.read(scope, maxEvents === undefined ? {} : { maxEvents }));
    } catch {
      return jsonError('trace is unavailable', 500);
    }
  };
}
