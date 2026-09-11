// Only the external provider is scripted: requests, durable accounting and policy are real.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { HarnessExecutor, project } from '@agora/runtime-executor';
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { BudgetLedger } from './accounting';
import { FormalGuard, GuardedFormalMeter } from './formal-guard';
import { CONFIG, costOf, fixedRoster, MeteredAdapter } from './model-adapter';

class Provider extends LlmAdapter {
  models: string[] = [];
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.models.push(options.model);
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 50 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
it('honors the frozen role model on every request and persists all charges', async () => {
  const ledger = new BudgetLedger(
    join(mkdtempSync(join(tmpdir(), 'meter-')), 'budget.json'),
    20,
    17,
  );
  const provider = new Provider();
  const meter = new MeteredAdapter(ledger, 'trial', 'formal', provider);
  for (const model of ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-flash']) {
    for await (const _chunk of meter.stream({
      model,
      messages: [],
      sessionId: 'meter-test',
    } as unknown as GenerateOptions)) {
      /* Consume the real wrapper. */
    }
  }
  expect(provider.models).toEqual(['deepseek-v4-flash', 'deepseek-flash', 'deepseek-flash']);
  expect(meter.calls).toHaveLength(3);
  expect(ledger.spent).toBeGreaterThan(0);
  expect(
    fixedRoster('mixed')
      .filter((r) => r.model === 'deepseek-flash')
      .map((r) => r.role),
  ).toEqual(['PM', 'ARCHITECT', 'REVIEWER']);
  for (const variant of ['single', 'multi', 'parallel', 'sparse'] as const)
    expect(fixedRoster(variant).every((r) => r.model === 'deepseek-v4-flash')).toBe(true);
  expect(
    fixedRoster('mixed')
      .filter((r) => !['PM', 'ARCHITECT', 'REVIEWER'].includes(r.role))
      .every((r) => r.model === 'deepseek-v4-flash'),
  ).toBe(true);
});
it('refuses unknown models and oversized context before provider I/O', async () => {
  const ledger = new BudgetLedger(
    join(mkdtempSync(join(tmpdir(), 'meter-')), 'budget.json'),
    20,
    17,
  );
  const provider = new Provider();
  const meter = new MeteredAdapter(ledger, 'trial', 'formal', provider);
  const consume = async (options: unknown) => {
    for await (const _chunk of meter.stream(options as GenerateOptions)) {
    }
  };
  await expect(consume({ model: 'unknown', messages: [] })).rejects.toThrow('model');
  await expect(consume({ model: 'deepseek-v4-pro', messages: [] })).rejects.toThrow('model');
  await expect(
    consume({
      model: 'deepseek-v4-flash',
      messages: [{ content: [{ type: 'text', text: 'x'.repeat(65536 * 4 + 1) }] }],
    }),
  ).rejects.toThrow('context');
  await expect(
    consume({ model: 'deepseek-v4-flash', messages: [], system: 'x'.repeat(65536 * 4 + 1) }),
  ).rejects.toThrow('context');
  expect(provider.models).toEqual([]);
  expect(ledger.spent).toBe(0);
  expect(
    costOf('deepseek-flash', { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0 }, true),
  ).toBeUndefined();
  expect(costOf('deepseek-flash', { inputTokens: 1, outputTokens: 0 }, true)).toBeUndefined();
});
it('does not confuse serialized bytes with the configured Harness token estimate', async () => {
  const ledger = new BudgetLedger(
    join(mkdtempSync(join(tmpdir(), 'meter-')), 'budget.json'),
    20,
    17,
  );
  const provider = new Provider(),
    meter = new MeteredAdapter(ledger, 'trial', 'formal', provider);
  const options = {
    model: 'deepseek-flash',
    sessionId: 'meter-test',
    system: 'system',
    messages: [{ content: [{ type: 'text', text: 'x'.repeat(90000) }] }],
  } as unknown as GenerateOptions;
  for await (const _chunk of meter.stream(options)) {
  }
  expect(provider.models).toEqual(['deepseek-flash']);
  expect(meter.calls[0]?.inputBytes).toBeGreaterThan(65536);
  expect(meter.calls[0]?.inputTokenEstimate).toBeLessThan(65536);
});

it('advertises the effective evaluation context capacity to official Harness compaction', async () => {
  const ledger = new BudgetLedger(
    join(mkdtempSync(join(tmpdir(), 'meter-')), 'budget.json'),
    20,
    17,
  );
  const provider = new Provider();
  const meter = new MeteredAdapter(ledger, 'trial', 'formal', provider);
  for (const model of ['deepseek-v4-flash', 'deepseek-flash']) {
    expect(await meter.resolveModel('deepseek', model)).toMatchObject({
      provider: 'deepseek',
      id: model,
      context: { contextWindow: 65536 },
    });
  }
  expect(provider.models).toEqual([]);
  expect(ledger.spent).toBe(0);
});

class PressureProvider extends Provider {
  summaries = 0;
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 16000 } };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const summary = JSON.stringify(options.messages).includes(
      'You are now acting as a compaction engine',
    );
    if (summary) this.summaries++;
    const text =
      this.models.length === 0
        ? 'Prior result. '.repeat(8000)
        : summary
          ? 'Short prior checkpoint.'
          : 'Completed after compaction.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield* super.stream(options);
  }
}
it('runs official automatic pressure compaction through the metered adapter and accounts for its summary request', async () => {
  const ledger = new BudgetLedger(
    join(mkdtempSync(join(tmpdir(), 'meter-pressure-')), 'budget.json'),
    20,
    17,
  );
  const provider = new PressureProvider();
  const meter = new MeteredAdapter(ledger, 'pressure', 'diagnostic', provider);
  const coder = PHASE0_ROSTER.find((entry) => entry.role === 'CODER');
  if (coder === undefined) throw new Error('missing CODER fixture');
  const spec = { ...coder, model: 'deepseek-v4-flash' };
  const executor = new HarnessExecutor(spec, { adapter: meter });
  const context = {
    sessionId: 'pressure',
    view: project(createInitialAppState('pressure', 'Continue work'), 'CODER', PHASE0_ROSTER),
  };
  try {
    await executor.step(context);
    const result = await executor.step(context);
    expect(result.output).toEqual({ text: 'Completed after compaction.' });
    expect(provider.summaries).toBeGreaterThan(0);
    expect(meter.calls).toHaveLength(provider.models.length);
    expect(meter.calls.filter((call) => call.purpose === 'compaction')).toHaveLength(
      provider.summaries,
    );
    expect(
      meter.calls.every((call) => call.costUsd !== undefined && call.inputTokenEstimate <= 65536),
    ).toBe(true);
    expect(ledger.spent).toBeGreaterThan(0);
  } finally {
    await executor.dispose();
  }
});

it('selects OpenCode Go with the requested model mix and unchanged context budget', () => {
  expect(CONFIG).toMatchObject({
    provider: 'opencode-go',
    endpoint: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    contextLimit: 65536,
    maxTokens: 32768,
    accountingMetric: 'subscription-quota-equivalent-usd',
  });
  expect(
    costOf(
      'deepseek-v4-flash',
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 },
      true,
    ),
  ).toBeCloseTo(1.506);
});

it('records a conservative quota bound when Go omits cache breakdown without fabricating usage', async () => {
  class NoCacheProvider extends Provider {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 674, outputTokens: 65 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const ledger = new BudgetLedger(
    join(mkdtempSync(join(tmpdir(), 'meter-go-cache-')), 'budget.json'),
    20,
    17,
  );
  const meter = new MeteredAdapter(ledger, 'missing-cache', 'diagnostic', new NoCacheProvider());
  for await (const _chunk of meter.stream({
    model: 'deepseek-v4-flash',
    messages: [],
    sessionId: 'cache-diagnostic',
  } as unknown as GenerateOptions)) {
  }
  expect(meter.calls[0]?.usage).toEqual({ inputTokens: 674, outputTokens: 65 });
  expect(meter.calls[0]).toMatchObject({ costBasis: 'uncached-input-upper-bound' });
  expect(meter.calls[0]?.costUsd).toBeGreaterThan(0);
  expect(ledger.spent).not.toBe('unknown');
});

it('stops actual official pressure-compaction recovery before another provider request after an empty summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'formal-pressure-'));
  class EmptySummaryProvider extends PressureProvider {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.purpose !== 'compaction') {
        yield* super.stream(options);
        return;
      }
      this.models.push(options.model);
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const provider = new EmptySummaryProvider();
  const budget = new BudgetLedger(join(root, 'budget.json'), 5, 5);
  const guard = new FormalGuard(root);
  const meter = new GuardedFormalMeter(budget, 'invalid-summary', guard, provider);
  const coder = PHASE0_ROSTER.find((entry) => entry.role === 'CODER');
  if (!coder) throw new Error('Missing CODER fixture');
  const executor = new HarnessExecutor(
    { ...coder, model: 'deepseek-v4-flash' },
    { adapter: meter },
  );
  const context = {
    sessionId: 'invalid-summary',
    view: project(
      createInitialAppState('invalid-summary', 'Continue work'),
      'CODER',
      PHASE0_ROSTER,
    ),
  };
  try {
    await executor.step(context);
    await expect(executor.step(context)).rejects.toThrow();
    expect(() => guard.check()).toThrow('stopped');
    expect(provider.models).toHaveLength(2);
    expect(meter.calls).toHaveLength(2);
    expect(meter.calls[1]?.purpose).toBe('compaction');
    expect(meter.calls.every((call) => call.costUsd !== undefined)).toBe(true);
    expect(budget.spent).toBeGreaterThan(0);
  } finally {
    await executor.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
