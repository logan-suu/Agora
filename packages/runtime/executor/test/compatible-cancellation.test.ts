// A local HTTP server simulates a stalled provider; Harness, fetch, timers and cancellation are real.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setImmediate as nextTick } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { PHASE0_ROSTER } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';

it('closes a stalled HTTP stream after cloned requests are collected, before retrying', async () => {
  const original = globalThis.fetch;
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  setFlagsFromString('--no-expose-gc');
  let requests = 0;
  let closed = false;
  let forcedClose = false;
  let retriedBeforeClose = false;
  let notify: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* Drain the real request body. */
    }
    requests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    if (requests === 1) {
      response.on('close', () => {
        closed = true;
      });
      notify();
      return;
    }
    retriedBeforeClose ||= !closed;
    response.end(
      `data: ${JSON.stringify({ id: 'retry', object: 'chat.completion.chunk', created: 1, model: 'local-probe', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing local server');
  const spec = PHASE0_ROSTER.find((role) => role.role === 'COORDINATOR');
  if (!spec) throw new Error('missing Coordinator');
  const executor = new HarnessExecutor(
    { ...spec, model: 'local-probe' },
    {
      compatible: {
        id: 'local-cancellation',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        model: 'local-probe',
        contextWindow: 32768,
        maxTokens: 32,
        resolveApiKey: async () => undefined,
      },
    },
  );
  const deadline = setTimeout(() => {
    forcedClose = true;
    server.closeAllConnections();
  }, 35000);
  try {
    const step = executor.step({
      sessionId: 'local-cancellation',
      view: { role: 'COORDINATOR', slices: {} },
    });
    await started;
    // Let fetch release intermediate Request objects before collecting their signal followers.
    for (let index = 0; index < 3; index += 1) {
      await nextTick();
      collect();
    }
    expect((await step).kind).toBe('done');
    expect(forcedClose).toBe(false);
    expect(closed).toBe(true);
    expect(retriedBeforeClose).toBe(false);
    expect(requests).toBe(2);
  } finally {
    clearTimeout(deadline);
    server.closeAllConnections();
    await executor.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = original;
  }
}, 45000);
