// The scripted provider isolates malformed model output; the real Harness loop,
// projection hook, tool restrictions and turn boundaries remain under test.
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it, vi } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';
import { project } from '../src/project';

class Replies extends LlmAdapter {
  calls: GenerateOptions[] = [];
  onFinish?: () => void;
  constructor(private readonly replies: string[]) {
    super();
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    const text = this.replies[this.calls.length - 1] ?? 'still invalid';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    this.onFinish?.();
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const spec = PHASE0_ROSTER.find((r) => r.role === 'CODER');
if (!spec) throw new Error('missing CODER');
const context = {
  sessionId: 'output-repair',
  view: project(createInitialAppState('repair', 'projected goal'), 'CODER', PHASE0_ROSTER),
};
const validate = ({ text }: { text: string | null }) => {
  JSON.parse(text ?? '');
};

describe('bounded structured output repair', () => {
  it.each(['Explanation before JSON {"ok":true}', '{"regex":"/\\s+/g"}'])(
    'regenerates invalid syntax in the official turn without publishing the rejected candidate: %s',
    async (bad) => {
      const adapter = new Replies([bad, '{"ok":true}']);
      const reader = vi.fn(() => []);
      const executor = new HarnessExecutor(spec, {
        adapter,
        validateTurnOutput: validate,
        readTurnMutations: reader,
      });
      try {
        const result = await executor.step(context);
        expect(adapter.calls).toHaveLength(2);
        expect(reader).toHaveBeenCalledExactlyOnceWith({ text: '{"ok":true}' });
        expect(result.output).toEqual({ text: '{"ok":true}' });
        expect(result.mutations).toHaveLength(1);
        const repairInput = JSON.stringify(adapter.calls[1]?.messages);
        expect(
          adapter.calls[1]?.messages.some((m) =>
            m.content.some((c) => c.type === 'text' && c.text === JSON.stringify(context.view)),
          ),
        ).toBe(true);
        expect(repairInput).toContain('output-format-repair');
        expect(JSON.stringify(result.mutations)).not.toContain(bad);
      } finally {
        await executor.dispose();
      }
    },
  );
  it('allows only two additional requests and leaves the final invalid output rejected', async () => {
    const adapter = new Replies(['bad1', 'bad2', 'bad3']);
    const reader = vi.fn(({ text }: { text: string | null }) => {
      validate({ text });
      return [];
    });
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validate,
      readTurnMutations: reader,
    });
    try {
      await expect(executor.step(context)).rejects.toThrow();
      expect(adapter.calls).toHaveLength(3);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });
  it('does not replay side effects or rewrite objection controls as ordinary structured output', async () => {
    const adapter = new Replies([
      '<agora-objection>{"claim":"contradiction"</argument></agora-objection>',
      '{}',
    ]);
    const reader = vi.fn(() => []);
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validate,
      readTurnMutations: reader,
    });
    try {
      await expect(executor.step(context)).rejects.toThrow('invalid agora objection');
      expect(adapter.calls).toHaveLength(1);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });
  it('removes tools for correction requests and restores the original grant on the next turn', async () => {
    const adapter = new Replies(['bad', '{}', '{}']);
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validate,
      tools: [
        {
          name: 'inspect',
          description: 'inspect',
          parameters: {},
          output: { schema: {}, render: () => [] },
          execute: async () => ({ ok: true }),
        },
      ],
      allowTools: ['inspect'],
    });
    try {
      await executor.step(context);
      await executor.step(context);
      expect(adapter.calls[0]?.tools?.map((t) => t.name)).toContain('inspect');
      expect(adapter.calls[1]?.tools ?? []).toEqual([]);
      expect(adapter.calls[2]?.tools?.map((t) => t.name)).toContain('inspect');
    } finally {
      await executor.dispose();
    }
  });
  it('rejects an empty new turn instead of accepting the preceding successful message', async () => {
    const adapter = new Replies(['{}', '', '', '']);
    const executor = new HarnessExecutor(spec, { adapter, validateTurnOutput: validate });
    try {
      await executor.step(context);
      await expect(executor.step(context)).rejects.toThrow();
      expect(adapter.calls).toHaveLength(4);
    } finally {
      await executor.dispose();
    }
  });
  it('lets a requested safe point close the turn without starting a correction request', async () => {
    const adapter = new Replies(['bad', '{}']);
    const reader = vi.fn(() => []);
    const executor = new HarnessExecutor(spec, {
      adapter,
      validateTurnOutput: validate,
      readTurnMutations: reader,
    });
    adapter.onFinish = () => executor.requestSafePoint();
    try {
      const result = await executor.step(context);
      expect(result.kind).toBe('tool');
      expect(result.mutations).toEqual([]);
      expect(adapter.calls).toHaveLength(1);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
    }
  });
});
