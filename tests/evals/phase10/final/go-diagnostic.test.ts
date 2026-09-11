// Only model replies are scripted to debug tool dispatch without another paid request.
import { PHASE0_ROSTER } from '@agora/core-domain';
import { HarnessExecutor } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';

it('executes the diagnostic read through real Harness tools and sandbox', async () => {
  const sandbox = new LocalTempSandbox();
  const workspace = await sandbox.createWorktree('go-offline-tool', 'CODER');
  await sandbox.write(workspace, 'audit.txt', 'PAGE_1_OK answer()=42');
  let reads = 0;
  const seen: GenerateOptions[] = [];
  class Adapter extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.push(options);
      if (seen.length === 1) {
        const block = {
          type: 'tool-call' as const,
          id: CallId('read-1'),
          name: 'read_audit',
          arguments: '{}',
        };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'text', text: 'PAGE_1_OK answer()=42' },
        };
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const spec = PHASE0_ROSTER.find((r) => r.role === 'CODER');
  if (!spec) throw new Error('missing CODER');
  const executor = new HarnessExecutor(spec, {
    adapter: new Adapter(),
    tools: [
      {
        name: 'read_audit',
        description: 'Read audit',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: {}, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async () => {
          reads++;
          return sandbox.read(workspace, 'audit.txt');
        },
      },
    ],
    allowTools: ['read_audit'],
    maxToolCallsPerTurn: 1,
    approval: async () => ({ kind: 'allow' }),
  });
  try {
    await executor.step({
      sessionId: 'offline-tool',
      view: { role: 'CODER', slices: { goal: 'Read the audit' } },
    });
    expect(reads, JSON.stringify(seen.at(-1)?.messages)).toBe(1);
    expect(JSON.stringify(seen.at(-1)?.messages)).toContain('PAGE_1_OK answer()=42');
  } finally {
    await executor.dispose();
    await sandbox.teardown('go-offline-tool');
  }
});
