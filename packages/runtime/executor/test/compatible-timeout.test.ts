// Mock only remote HTTP/SSE delays and timers; use the real Harness, SDK,
// serialization and abort propagation to verify the provider waiting policy.
import { PHASE0_ROSTER } from '@agora/core-domain';
import { expect, it, vi } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';

it.each([
  { name: 'slow headers', host: 'opencode.ai', headers: 180000, first: 0, gap: 0, pass: true },
  {
    name: 'slow first content',
    host: 'opencode.ai',
    headers: 0,
    first: 180000,
    gap: 0,
    pass: true,
  },
  {
    name: 'a progressing long stream',
    host: 'opencode.ai',
    headers: 0,
    first: 180000,
    gap: 180000,
    pass: true,
  },
  { name: 'stalled headers', host: 'opencode.ai', headers: 301000, first: 0, gap: 0, pass: false },
  { name: 'stalled content', host: 'opencode.ai', headers: 0, first: 301000, gap: 0, pass: false },
  {
    name: 'other provider idle limit',
    host: 'other.example',
    headers: 0,
    first: 31000,
    gap: 0,
    pass: false,
  },
])('uses bounded native waiting for $name', async (scenario) => {
  const original = globalThis.fetch;
  let requests = 0;
  let active = 0;
  let overlapping = false;
  let notify: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    notify = resolve;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().json();
    expect(body.max_completion_tokens).toBe(384000);
    requests += 1;
    overlapping ||= active > 0;
    active += 1;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      active -= 1;
      for (const timer of timers) clearTimeout(timer);
    };
    const response = new Promise<Response>((resolve, reject) => {
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const abort = () => {
        close();
        const error = new DOMException('Aborted', 'AbortError');
        if (stream) stream.error(error);
        else reject(error);
      };
      request.signal.addEventListener('abort', abort, { once: true });
      timers.push(
        setTimeout(() => {
          resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  stream = controller;
                  const emit = (content: string, done: boolean) => {
                    const chunk = {
                      id: 'waiting-policy',
                      object: 'chat.completion.chunk',
                      created: 1,
                      model: 'deepseek-v4-flash',
                      choices: [
                        {
                          index: 0,
                          delta: { role: 'assistant', content },
                          finish_reason: done ? 'stop' : null,
                        },
                      ],
                    };
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify(chunk)}\n\n${done ? 'data: [DONE]\n\n' : ''}`,
                      ),
                    );
                    if (done) {
                      request.signal.removeEventListener('abort', abort);
                      close();
                      controller.close();
                    }
                  };
                  timers.push(setTimeout(() => emit('O', false), scenario.first));
                  timers.push(setTimeout(() => emit('K', true), scenario.first + scenario.gap));
                },
                cancel() {
                  close();
                  request.signal.removeEventListener('abort', abort);
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            ),
          );
        }, scenario.headers),
      );
    });
    notify();
    return response;
  };
  const spec = PHASE0_ROSTER.find((entry) => entry.role === 'COORDINATOR');
  if (!spec) throw new Error('missing Coordinator');
  const executor = new HarnessExecutor(spec, {
    compatible: {
      id: 'waiting-policy',
      baseURL: `https://${scenario.host}/zen/go/v1`,
      model: 'deepseek-v4-flash',
      contextWindow: 1000000,
      maxTokens: 384000,
      resolveApiKey: async () => 'test-key',
    },
  });
  try {
    const outcome = executor
      .step({ sessionId: 'waiting-policy', view: { role: 'COORDINATOR', slices: {} } })
      .then(
        (output) => ({ output }),
        (error: unknown) => ({ error }),
      );
    await requested;
    await vi.advanceTimersByTimeAsync(1000000);
    if (scenario.pass)
      expect(await outcome).toMatchObject({ output: { kind: 'done', output: { text: 'OK' } } });
    else expect(await outcome).toMatchObject({ error: { code: 'TIMEOUT' } });
    expect(requests).toBe(scenario.pass ? 1 : 3);
    expect(overlapping).toBe(false);
    expect(active).toBe(0);
  } finally {
    await executor.dispose();
    globalThis.fetch = original;
    vi.useRealTimers();
  }
});
