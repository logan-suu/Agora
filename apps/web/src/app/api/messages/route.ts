import { createPostMessage } from '../../../server/message-handlers';
import { taskRuntime } from '../../../server/task-runtime';

export const runtime = 'nodejs';

export const POST = createPostMessage(taskRuntime.messages);
