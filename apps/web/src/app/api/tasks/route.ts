import { createGetTask, createPostTask } from '../../../server/task-handlers';
import { getTaskRuntime } from '../../../server/task-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  return createGetTask(await getTaskRuntime())(request);
}
export async function POST(request: Request) {
  return createPostTask(await getTaskRuntime())(request);
}
