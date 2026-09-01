import { createGetChannels } from '../../../server/message-handlers';
import { messageRuntime } from '../../../server/message-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = createGetChannels(messageRuntime);
