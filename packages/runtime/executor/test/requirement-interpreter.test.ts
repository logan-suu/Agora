// Only external model responses are scripted; the official Harness loop, system projection,
// tool filtering, format repair and persisted sessions use their production implementations.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import { HarnessRequirementInterpreter } from '../src/requirement-interpreter';

class ScriptedModel extends LlmAdapter {
  calls: Parameters<LlmAdapter['stream']>[0][] = [];
  constructor(private replies: string[]) {
    super();
  }
  async *stream(options: Parameters<LlmAdapter['stream']>[0]): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    const text = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)] ?? '';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const input = {
  projectId: 'p',
  taskId: 't',
  sourceMsgId: 'input-1',
  text: 'Change the ticket price to 900 cents per person.',
  goal: 'Ticket calculator',
  requirements: [
    {
      id: 'tickets',
      story: 'Tickets cost 1000 cents.',
      acceptance: ['Two tickets cost 2000 cents.'],
      nonGoals: ['No payment processing.'],
    },
  ],
  decisions: [],
};
const response = {
  kind: 'proposal',
  summary: 'Review the new ticket price.',
  changes: [
    {
      requirementId: 'tickets',
      requirement: {
        story: 'Tickets cost 900 cents.',
        acceptance: ['Two tickets cost 1800 cents.'],
        nonGoals: ['No payment processing.'],
      },
    },
  ],
};

describe('tool-free Harness requirement interpretation', () => {
  it('projects only supplied facts and returns an uncommitted proposal using the selected model', async () => {
    const adapter = new ScriptedModel([JSON.stringify(response)]);
    const interpreter = new HarnessRequirementInterpreter('configured-model', {
      adapter,
      provider: 'test-input',
    });
    expect(await interpreter.interpret(input)).toEqual(response);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.model).toBe('configured-model');
    expect(adapter.calls[0]?.tools ?? []).toHaveLength(0);
    expect(adapter.calls[0]?.system).toContain(input.text);
    expect(adapter.calls[0]?.system).toContain('No payment processing.');
    expect(adapter.calls[0]?.system).toContain('cannot execute or approve any action');
    expect(input.requirements[0]?.story).toContain('1000');
  });
  it('uses bounded official format repair and rejects unsupported authority-bearing output', async () => {
    const adapter = new ScriptedModel([
      '{"kind":"approve_completion"}',
      JSON.stringify({ kind: 'clarification', text: 'Which amount should change?' }),
    ]);
    expect(await new HarnessRequirementInterpreter('model', { adapter }).interpret(input)).toEqual({
      kind: 'clarification',
      text: 'Which amount should change?',
    });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls.every((call) => (call.tools ?? []).length === 0)).toBe(true);
  });
  it('keeps retry attempts in separate durable sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-input-sessions-'));
    const adapter = new ScriptedModel([JSON.stringify(response)]);
    try {
      const interpreter = new HarnessRequirementInterpreter('model', {
        adapter,
        sessionPersistence: { root, cwd: root, projectId: 'p', taskId: 't' },
      });
      await interpreter.interpret(input);
      const first = await readdir(root, { recursive: true });
      await interpreter.interpret(input);
      const second = await readdir(root, { recursive: true });
      expect(second.length).toBeGreaterThan(first.length);
      expect(adapter.calls).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
