// The external provider is scripted; real metering, disk ledger and stop persistence remain active.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { BudgetLedger } from './accounting';
import { assertFormalAuthorization, FormalGuard, GuardedFormalMeter } from './formal-guard';

const options = {
  model: 'deepseek-v4-flash',
  sessionId: 'session',
  messages: [],
} as unknown as GenerateOptions;
async function consume(meter: GuardedFormalMeter) {
  for await (const _chunk of meter.stream(options)) {
    /* Drain the request. */
  }
}
it('requires the exact approved group and USD5 scope', () => {
  expect(() => assertFormalAuthorization('phase10-final-v14', undefined)).toThrow('authorization');
  for (const group of [
    'phase10-final-v3',
    'phase10-final-v4',
    'phase10-final-v5',
    'phase10-final-v6',
    'phase10-final-v7',
    'phase10-final-v8',
    'phase10-final-v9',
    'phase10-final-v10',
    'phase10-final-v11',
    'phase10-final-v12',
    'phase10-final-v13',
  ])
    expect(() => assertFormalAuthorization(group, 'phase10-final-v14-usd5')).toThrow(
      'authorization',
    );
  expect(() =>
    assertFormalAuthorization('phase10-final-v14', 'phase10-final-v14-usd5'),
  ).not.toThrow();
});
it.each(['throw', 'missing-usage', 'error-finish'] as const)(
  'stops subsequent requests after %s while preserving accounting',
  async (fault) => {
    const root = mkdtempSync(join(tmpdir(), 'formal-guard-'));
    try {
      let requests = 0;
      class Provider extends LlmAdapter {
        async *stream(): AsyncIterable<StreamChunk> {
          requests++;
          if (fault === 'throw') throw new Error('provider failed');
          if (fault === 'error-finish')
            yield {
              type: 'usage',
              usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
            } as StreamChunk;
          yield {
            type: 'finish',
            reason: { kind: fault === 'error-finish' ? 'error' : 'stop' },
          } as StreamChunk;
        }
      }
      const budget = new BudgetLedger(join(root, 'budget.json'), 5, 5);
      const guard = new FormalGuard(root);
      const meter = new GuardedFormalMeter(budget, 'trial', guard, new Provider());
      await expect(consume(meter)).rejects.toThrow();
      await expect(consume(meter)).rejects.toThrow('stopped');
      expect(requests).toBe(1);
      expect(meter.calls).toHaveLength(1);
      expect(fault === 'error-finish' ? Number(budget.spent) > 0 : budget.spent === 'unknown').toBe(
        true,
      );
      expect(JSON.parse(readFileSync(join(root, 'stop-requested.json'), 'utf8')).trial).toBe(
        'trial',
      );
      guard.stop('later', 'attempt-not-passed');
      expect(JSON.parse(readFileSync(join(root, 'stop-requested.json'), 'utf8')).trial).toBe(
        'trial',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('blocks provider I/O after an operator stop or a failed completed attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'formal-guard-'));
  try {
    let requests = 0;
    class Provider extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        requests++;
        yield {
          type: 'usage',
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
        } as StreamChunk;
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const guard = new FormalGuard(root);
    const meter = new GuardedFormalMeter(
      new BudgetLedger(join(root, 'budget.json'), 5, 5),
      'ok',
      guard,
      new Provider(),
    );
    await consume(meter);
    expect(requests).toBe(1);
    guard.check();
    guard.stop('failed-attempt', 'attempt-not-passed');
    expect(() => guard.check()).toThrow('stopped');
    await expect(consume(meter)).rejects.toThrow('stopped');
    expect(requests).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['tool-calls', 'empty', 'whitespace', 'text'] as const)(
  'requires a completed text summary for compaction (%s)',
  async (output) => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-guard-'));
    let requests = 0;
    class Provider extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        requests++;
        if (output === 'text' || output === 'whitespace') {
          const text = output === 'text' ? 'Verified earlier work.' : '  \n';
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 } };
        yield { type: 'finish', reason: { kind: output === 'tool-calls' ? 'tool-calls' : 'stop' } };
      }
    }
    try {
      const budget = new BudgetLedger(join(root, 'budget.json'), 5, 5);
      const guard = new FormalGuard(root);
      const meter = new GuardedFormalMeter(budget, 'summary', guard, new Provider());
      const summarize = async () => {
        for await (const _chunk of meter.stream({ ...options, purpose: 'compaction' })) {
        }
      };
      if (output === 'text') {
        await summarize();
        expect(() => guard.check()).not.toThrow();
      } else {
        await expect(summarize()).rejects.toThrow('summary');
        await expect(summarize()).rejects.toThrow('stopped');
      }
      expect(requests).toBe(1);
      expect(meter.calls).toHaveLength(1);
      expect(budget.spent).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
