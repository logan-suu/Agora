// Mock only the remote SSE transport; the Harness loop, tool execution, history,
// and compatible provider serialization are real. No paid requests are needed.
import { PHASE0_ROSTER } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';

it('replays empty and nonempty DeepSeek reasoning through tool steps and later turns', async () => {
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let toolExecutions = 0;
  globalThis.fetch = async (input, init) => {
    const body = (await new Request(input, init).json()) as Record<string, unknown>;
    current.push(body);
    const call = current.length;
    const delta =
      call <= 2
        ? {
            role: 'assistant',
            ...(call === 1 ? { reasoning_content: 'Preserve this reasoning verbatim.' } : {}),
            tool_calls: [
              {
                index: 0,
                id: `call-${call}`,
                type: 'function',
                function: { name: 'probe', arguments: '{}' },
              },
            ],
          }
        : { role: 'assistant', content: 'OK' };
    return new Response(
      `data: ${JSON.stringify({ id: `reply-${call}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: call <= 2 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const spec = PHASE0_ROSTER.find((entry) => entry.role === 'COORDINATOR');
  if (!spec) throw new Error('missing Coordinator');
  const cases = [
    { baseURL: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash', required: true },
    { baseURL: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-pro', required: true },
    { baseURL: 'https://other.example/v1', model: 'deepseek-v4-flash', required: false },
    { baseURL: 'https://opencode.ai/zen/go/v1', model: 'other-model', required: false },
  ];
  try {
    for (const [index, options] of cases.entries()) {
      current = [];
      requests.push(current);
      const executor = new HarnessExecutor(
        { ...spec, model: options.model },
        {
          compatible: {
            id: `reasoning-${index}`,
            ...options,
            contextWindow: 1000000,
            maxTokens: 384000,
            resolveApiKey: async () => 'test-key',
          },
          tools: [
            {
              name: 'probe',
              description: 'Return a local diagnostic result',
              parameters: {},
              output: { schema: {}, render: () => [] },
              execute: async () => {
                toolExecutions += 1;
                return { ok: true };
              },
            },
          ],
          allowTools: ['probe'],
        },
      );
      try {
        const context = {
          sessionId: `reasoning-${index}`,
          view: { role: 'COORDINATOR', slices: {} },
        };
        expect(await executor.step(context)).toMatchObject({ output: { text: 'OK' } });
        expect(await executor.step(context)).toMatchObject({ output: { text: 'OK' } });
      } finally {
        await executor.dispose();
      }
    }
    for (const [index, bodies] of requests.entries()) {
      expect(bodies).toHaveLength(4);
      const last = bodies[3];
      if (last === undefined) throw new Error('missing later-turn request');
      const assistants = (last.messages as Record<string, unknown>[]).filter(
        (message) => message.role === 'assistant',
      );
      expect(assistants).toHaveLength(3);
      expect(assistants[0]?.reasoning_content).toBe('Preserve this reasoning verbatim.');
      expect(assistants[1]?.reasoning_content).toBe(cases[index]?.required ? '' : undefined);
      expect(assistants[2]?.reasoning_content).toBe(cases[index]?.required ? '' : undefined);
      expect(bodies.every((body) => body.max_completion_tokens === 384000)).toBe(true);
      expect(
        bodies.some(
          (body) => (body.thinking as { type?: string } | undefined)?.type === 'disabled',
        ),
      ).toBe(false);
    }
    expect(toolExecutions).toBe(8);
  } finally {
    globalThis.fetch = original;
  }
});
