// The external provider is scripted to inspect request policy and budget settlement without billing.
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { ExperimentBudget, usageCost } from './metrics';
import { MeteredFlashAdapter, MODEL_CONFIG } from './model-adapter';

class Provider extends LlmAdapter {
  requests: GenerateOptions[] = [];
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    yield {
      type: 'usage',
      usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 8192, reasoningTokens: 8192 },
    };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  }
}
const request: GenerateOptions = {
  provider: 'test',
  model: 'ignored',
  maxTokens: 10,
  messages: [],
};

it('records provider truncation and settles its usage after the stream naturally ends', async () => {
  const provider = new Provider();
  const budget = new ExperimentBudget(2);
  const adapter = new MeteredFlashAdapter(budget, provider);
  const chunks = [];
  for await (const chunk of adapter.stream(request)) chunks.push(chunk);
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } });
  expect(adapter.calls[0]).toMatchObject({ finishReason: 'max-tokens', outputTruncated: true });
  expect(adapter.costUsd).toBe(budget.costUsd);
  expect(adapter.calls[0]?.costUsd).toBeGreaterThan(0);
});

it('uses the manifest parameters for actual requests and conservative output reservations', async () => {
  const provider = new Provider();
  const adapter = new MeteredFlashAdapter(new ExperimentBudget(2), provider);
  for await (const _ of adapter.stream(request)) {
    /* Drain the real wrapper. */
  }
  expect(provider.requests[0]).toMatchObject({
    model: MODEL_CONFIG.model,
    maxTokens: MODEL_CONFIG.parameters.maxTokens,
    temperature: MODEL_CONFIG.parameters.temperature,
    reasoningEffort: MODEL_CONFIG.parameters.reasoningEffort,
  });
  expect(MODEL_CONFIG.parameters.requestReservationUsd).toBe(
    usageCost(
      {
        inputTokens: MODEL_CONFIG.parameters.contextLimit,
        cacheReadTokens: 0,
        outputTokens: MODEL_CONFIG.parameters.maxTokens,
      },
      true,
    ),
  );
});

it('refuses the provider request before billing when the group cannot reserve its output', async () => {
  const provider = new Provider();
  const adapter = new MeteredFlashAdapter(new ExperimentBudget(0.01), provider);
  await expect(async () => {
    for await (const _ of adapter.stream(request)) {
      /* Drain. */
    }
  }).rejects.toThrow(/budget exhausted/);
  expect(provider.requests).toEqual([]);
  expect(adapter.calls).toEqual([]);
});
