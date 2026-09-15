// Only external HTTP/SSE is scripted; both official adapter entry points serialize real messages.
import { type GenerateOptions, type Message, MessageId } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { afterEach, expect, it, vi } from 'vitest';
import { withGoReasoning } from './go-reasoning-transport';
import { resolveLiveTestModel } from './live-model';

afterEach(() => vi.unstubAllGlobals());

const messages: Message[] = ['', 'original reasoning'].map((text, index) => ({
  id: MessageId(`assistant-${index}`),
  role: 'assistant',
  content: [
    { type: 'text', text: 'answer' },
    { type: 'reasoning', text },
  ],
  source: { kind: 'model', provider: 'opencode-go', model: 'deepseek-v4-flash' },
}));
const options: GenerateOptions = {
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  messages,
};

function reply() {
  return new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}
async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
    /* Consume the native stream. */
  }
}

it.each(['stream', 'prepareCall'] as const)(
  'preserves empty and nonempty reasoning through native %s without changing messages or ordinary requests',
  async (entry) => {
    const requests: {
      messages: { reasoning_content?: string }[];
      model: string;
      thinking: unknown;
    }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(await new Request(input, init).json());
      return reply();
    });
    const before = structuredClone(messages);
    const live = await resolveLiveTestModel({ env: { OPENCODE_API_KEY: 'go-fixture' } });
    const adapter = live.options.adapter;
    if (!adapter) throw new Error('missing adapter');
    const stream =
      entry === 'stream' ? adapter : await adapter.prepareCall(options.provider, options.model);
    await drain(stream.stream(options));
    expect(requests[0]?.messages.map((m) => m.reasoning_content)).toEqual([
      '',
      'original reasoning',
    ]);
    expect(messages).toEqual(before);

    // A different adapter, even on the same endpoint, must retain its unmodified native request.
    const ordinary = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ baseURL: 'https://opencode.ai/zen/go/v1' }),
      resolveApiKey: async () => 'ordinary-fixture',
      resolveUserId: () =>
        'ordinary-user' as ReturnType<
          ConstructorParameters<typeof DeepSeekAdapter>[0]['resolveUserId']
        >,
    });
    await drain(ordinary.stream(options));
    expect(requests[1]?.messages[0]).not.toHaveProperty('reasoning_content');
    expect(requests[1]?.messages[1]?.reasoning_content).toBe('original reasoning');
    const expected = structuredClone(requests[1]);
    if (!expected) throw new Error('missing native request');
    expected.messages[0] = { ...expected.messages[0], reasoning_content: '' };
    expect(requests[0]).toEqual(expected);
  },
);

it('isolates concurrent requests and keeps the actual fetch cancellation signal connected', async () => {
  const controller = new AbortController();
  const seen: { scoped: boolean; signal: AbortSignal | null | undefined }[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const scoped = Object.hasOwn(body.messages[0], 'reasoning_content');
    seen.push({ scoped, signal: init.signal });
    if (!scoped) return reply();
    entered();
    await new Promise<void>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    return reply();
  });
  const payload = JSON.stringify({
    model: options.model,
    messages: [{ role: 'assistant', content: 'fixture' }],
  });
  const url = 'https://opencode.ai/zen/go/v1/chat/completions';
  let closed = false;
  const active = drain(
    withGoReasoning(async function* () {
      try {
        await fetch(url, { method: 'POST', body: payload, signal: controller.signal });
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        closed = true;
      }
    }),
  );
  const rejected = expect(active).rejects.toThrow('cancel fixture');
  await started;
  await fetch(url, { method: 'POST', body: payload });
  controller.abort(new Error('cancel fixture'));
  await rejected;
  expect(seen).toEqual([
    { scoped: true, signal: controller.signal },
    { scoped: false, signal: undefined },
  ]);
  expect(closed).toBe(true);
});
