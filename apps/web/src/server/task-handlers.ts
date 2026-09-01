import { jsonError, readJsonObject, requiredString } from './http';
import { TaskGoalConflictError, type TaskOrchestrationRuntime } from './task-orchestration-runtime';

export function createPostTask(runtime: TaskOrchestrationRuntime) {
  return async function postTask(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    const projectId = requiredString(body?.projectId);
    const taskId = requiredString(body?.taskId);
    const requestId = requiredString(body?.requestId);
    const goal = requiredString(body?.goal);
    if (!projectId || !taskId || !requestId || !goal) {
      return jsonError('projectId, taskId, requestId, and goal are required');
    }
    try {
      const result = await runtime.start({ projectId, taskId, requestId, goal });
      return Response.json(result, { status: result.startOutcome === 'started' ? 202 : 200 });
    } catch (error) {
      if (error instanceof TaskGoalConflictError) return jsonError(error.message, 409);
      throw error;
    }
  };
}

export function createGetTask(runtime: TaskOrchestrationRuntime) {
  return async function getTask(request: Request): Promise<Response> {
    const search = new URL(request.url).searchParams;
    const projectId = requiredString(search.get('projectId'));
    const taskId = requiredString(search.get('taskId'));
    if (!projectId || !taskId) return jsonError('projectId and taskId are required');
    const summary = await runtime.summary({ projectId, taskId });
    return summary === undefined ? jsonError('task not found', 404) : Response.json(summary);
  };
}
