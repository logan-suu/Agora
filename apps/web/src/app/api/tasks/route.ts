import { createGetTask, createPostTask } from '../../../server/task-handlers';
import { taskRuntime } from '../../../server/task-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = createGetTask(taskRuntime);
export const POST = createPostTask(taskRuntime);
