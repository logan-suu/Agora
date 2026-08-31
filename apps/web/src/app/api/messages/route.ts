import { createPostMessage } from '../../../server/message-handlers';
import { messageRuntime } from '../../../server/message-runtime';

export const runtime = 'nodejs';

export const POST = createPostMessage(messageRuntime);
