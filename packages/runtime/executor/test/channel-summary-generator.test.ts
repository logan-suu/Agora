import type { SubChannel } from '@agora/core-domain';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { HarnessChannelSummaryGenerator } from '../src/index';

// Mock 原因（R11）：用确定性 adapter 验证薄 Harness 接线、分块与严格解析；
// live provider 链由本任务的 G5 测试单独覆盖。
class QueueAdapter extends LlmAdapter {
  calls = 0;
  readonly #replies: string[];

  constructor(replies: string[]) {
    super();
    this.#replies = [...replies];
  }

  async *stream(): AsyncIterable<StreamChunk> {
    const reply = this.#replies[this.calls] ?? this.#replies.at(-1) ?? '';
    this.calls += 1;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const channel: SubChannel = {
  channelId: 'sub-task-a',
  kind: 'sub',
  taskId: 'task-a',
  threadId: 'thread-a',
  topic: 'Resolve storage ordering',
  createdBy: 'CODER',
  participants: ['leader', 'CODER'],
  closed: true,
};

const summary = JSON.stringify({
  conclusion: 'Commit the message first.',
  keyDecisions: [{ decision: 'Use CAS', rationale: 'It makes recovery idempotent.' }],
  openQuestions: [],
  sourceMsgIds: ['m1'],
});

describe('HarnessChannelSummaryGenerator', () => {
  it('does not invoke Harness for an empty channel', async () => {
    const adapter = new QueueAdapter([summary]);
    const generator = new HarnessChannelSummaryGenerator({ adapter, provider: 'agora' });

    await expect(generator.generate({ channel, entries: [] })).resolves.toEqual({
      conclusion: 'No conclusion recorded.',
      keyDecisions: [],
      openQuestions: [],
      sourceMsgIds: [],
    });
    expect(adapter.calls).toBe(0);
  });

  it('runs the tool-less thin Harness and validates exact output/source scope', async () => {
    const generator = new HarnessChannelSummaryGenerator({
      adapter: new QueueAdapter([summary]),
      provider: 'agora',
    });
    await expect(
      generator.generate({
        channel,
        entries: [{ ref: { taskId: 'task-a', msgId: 'm1' }, fromRole: 'CODER', type: 'feedback' }],
      }),
    ).resolves.toMatchObject({ conclusion: 'Commit the message first.', sourceMsgIds: ['m1'] });
  });

  it('summarizes every <=4000-char chunk and merges once', async () => {
    const chunkSummary = JSON.stringify({
      conclusion: 'Partial.',
      keyDecisions: [],
      openQuestions: [],
      sourceMsgIds: ['m1'],
    });
    const adapter = new QueueAdapter([chunkSummary, chunkSummary, summary]);
    const generator = new HarnessChannelSummaryGenerator({ adapter, provider: 'agora' });

    await generator.generate({
      channel,
      entries: [
        {
          ref: { taskId: 'task-a', msgId: 'm1' },
          fromRole: 'CODER',
          type: 'feedback',
          content: { reason: 'x'.repeat(7000) },
        },
      ],
    });

    expect(adapter.calls).toBe(3);
  });

  it('rejects non-JSON, extra keys, empty rationale, and foreign source ids', async () => {
    const values = [
      '```json\n{}\n```',
      JSON.stringify({ ...JSON.parse(summary), extra: true }),
      JSON.stringify({
        ...JSON.parse(summary),
        keyDecisions: [{ decision: 'Use CAS', rationale: '' }],
      }),
      JSON.stringify({ ...JSON.parse(summary), sourceMsgIds: ['foreign'] }),
    ];
    for (const value of values) {
      const generator = new HarnessChannelSummaryGenerator({
        adapter: new QueueAdapter([value]),
        provider: 'agora',
      });
      await expect(
        generator.generate({
          channel,
          entries: [
            { ref: { taskId: 'task-a', msgId: 'm1' }, fromRole: 'CODER', type: 'feedback' },
          ],
        }),
      ).rejects.toThrow();
    }
  });
});
