import { expect, it } from 'vitest';
import { observeResponse, wireUsage } from './wire-usage';

it('reads disjoint token counts from official wire fields without requiring the optional cache-miss field', () => {
  const frame = {
    usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 20, completion_tokens: 50 },
  };
  expect(wireUsage(`: keepalive\n\ndata: ${JSON.stringify(frame)}\n\ndata: [DONE]\n`)).toEqual({
    inputTokens: 100,
    cacheReadTokens: 20,
    outputTokens: 50,
  });
  expect(wireUsage(JSON.stringify(frame))).toEqual({
    inputTokens: 100,
    cacheReadTokens: 20,
    outputTokens: 50,
  });
  expect(wireUsage('data: [DONE]\n')).toBeUndefined();
  expect(
    wireUsage(
      JSON.stringify({
        usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 20, completion_tokens: 1 },
      }),
    ),
  ).toBeUndefined();
});
it('records usage before forwarding the finish bytes and survives normal consumer cancellation', async () => {
  const bytes = new TextEncoder().encode(
    'data: {"usage":{"prompt_tokens":12,"prompt_cache_hit_tokens":2,"completion_tokens":3}}\n\n',
  );
  let observed: unknown;
  const source = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(bytes);
      },
    }),
  );
  const response = observeResponse(source, (usage) => {
    observed = usage;
  });
  const reader = response.body?.getReader();
  expect((await reader?.read())?.value).toEqual(bytes);
  await reader?.cancel('DeepSeek stream consumer stopped');
  expect(observed).toEqual({ inputTokens: 10, cacheReadTokens: 2, outputTokens: 3 });
});
