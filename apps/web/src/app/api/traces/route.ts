import { HarnessTraceReader } from '@agora/runtime-executor';

import { messageRuntime } from '../../../server/message-runtime';
import { createGetTrace } from '../../../server/trace-handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const traceReader = new HarnessTraceReader(messageRuntime.root);

export const GET = createGetTrace(messageRuntime.store, traceReader);
