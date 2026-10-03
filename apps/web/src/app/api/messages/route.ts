import { createPostMessage } from '../../../server/message-handlers';
import { getTaskRuntime } from '../../../server/task-runtime';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return createPostMessage((await getTaskRuntime()).messages)(request);
}
