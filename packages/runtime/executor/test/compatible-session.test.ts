// Mock only the remote provider transport to inspect headers without paid requests.
// Harness sessions, concurrent executors, and the compatible provider adapter remain real.
import { PHASE0_ROSTER } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';

it('binds Go routing headers to each real Harness session across concurrent and later turns', async () => {
  const original = globalThis.fetch;
  const seen: { url: string; session: string | null; maxTokens?: number }[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.json();
    seen.push({
      url: request.url,
      session: request.headers.get('x-opencode-session'),
      maxTokens: body.max_completion_tokens,
    });
    return new Response(
      `data: ${JSON.stringify({ id: 'session-check', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const spec = PHASE0_ROSTER.find((r) => r.role === 'COORDINATOR');
  if (!spec) throw new Error('missing Coordinator');
  const make = (baseURL = 'https://opencode.ai/zen/go/v1') =>
    new HarnessExecutor(spec, {
      compatible: {
        id: 'shared-connection',
        baseURL,
        model: 'deepseek-v4-flash',
        contextWindow: 1000000,
        maxTokens: 384000,
        resolveApiKey: async () => 'test-key',
      },
    });
  const a = make(),
    b = make(),
    other = make('https://other.example/v1');
  const step = (executor: HarnessExecutor, sessionId: string) =>
    executor.step({ sessionId, view: { role: 'COORDINATOR', slices: {} } });
  try {
    await Promise.all([step(a, 'worker-a'), step(b, 'worker-b')]);
    await step(a, 'worker-a');
    await step(other, 'worker-other');
    expect(
      seen
        .filter((r) => r.url.startsWith('https://opencode.ai/'))
        .map((r) => r.session)
        .sort(),
    ).toEqual(['worker-a', 'worker-a', 'worker-b']);
    expect(seen.find((r) => r.url.startsWith('https://other.example/'))?.session).toBeNull();
    expect(seen.map((r) => r.maxTokens)).toEqual([384000, 384000, 384000, 384000]);
    await fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(seen.at(-1)?.session).toBeNull();
  } finally {
    await Promise.all([a.dispose(), b.dispose(), other.dispose()]);
    globalThis.fetch = original;
  }
});
