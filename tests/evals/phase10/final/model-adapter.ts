import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import {
  type GenerateOptions,
  LlmAdapter,
  ReasoningEffortId,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import {
  DeepSeekAdapter,
  type DeepSeekAdapterOptions,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek';
import { isPeak } from '../../phase9/metrics';
import type { BudgetLedger, Variant } from './accounting';
import { estimateInputTokens, inputByteUpperBound } from './context-budget';
import { normalizeGoToolStream } from './go-tool-stream';
import { CONFIG } from './model-profile';
import { resolveOpenCodeGoApiKey } from './opencode-go';

export const MODELS = ['deepseek-v4-flash', 'deepseek-flash'] as const;
type Model = (typeof MODELS)[number];

export { CONFIG } from './model-profile';

export function fixedRoster(variant: Variant) {
  return DEFAULT_ROSTER.map((spec) => ({
    ...structuredClone(spec),
    model:
      variant === 'mixed' && ['PM', 'ARCHITECT', 'REVIEWER'].includes(spec.role)
        ? MODELS[1]
        : MODELS[0],
  }));
}
export function costOf(
  model: string,
  usage: TokenUsage,
  peak: boolean,
  pricing: {
    peakRates: Readonly<Record<string, { input: number; cacheRead: number; output: number }>>;
  } = CONFIG,
): number | undefined {
  const values = [
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.outputTokens,
    usage.cacheWriteTokens ?? 0,
  ];
  if (values.some((value) => value === undefined || !Number.isFinite(value) || value < 0))
    return undefined;
  const rates = pricing.peakRates[model];
  if (rates === undefined) return undefined;
  return (
    (((usage.inputTokens + (usage.cacheWriteTokens ?? 0)) * rates.input +
      (usage.cacheReadTokens as number) * rates.cacheRead +
      usage.outputTokens * rates.output) /
      1_000_000) *
    (peak ? 1 : 0.5)
  );
}
export class MeteredAdapter extends LlmAdapter {
  readonly calls: {
    id: string;
    model: Model;
    start: number;
    end?: number;
    sessionId?: string;
    purpose?: GenerateOptions['purpose'];
    usage?: TokenUsage;
    costUsd?: number;
    costBasis?: 'reported-cache-split' | 'uncached-input-upper-bound';
    failed?: boolean;
    finishReason?: string;
    inputBytes: number;
    inputTokenEstimate: number;
    reservedUsd: number;
  }[] = [];
  readonly started = Date.now();
  toolCalls = 0;
  private readonly provider: LlmAdapter;
  constructor(
    private readonly ledger: BudgetLedger,
    private readonly trial: string,
    private readonly category: 'formal' | 'diagnostic',
    provider?: LlmAdapter,
  ) {
    super();
    if (provider === undefined && basename(ledger.path) !== CONFIG.budgetFile)
      throw new Error('OpenCode Go requires its separate quota ledger');
    const connection = resolveAdapterOptions({
      baseURL: CONFIG.endpoint,
      apiKeyEnv: CONFIG.apiKeyEnv,
      maxTokens: CONFIG.maxTokens,
      thinking: CONFIG.thinking,
      reasoningEffort: CONFIG.reasoningEffort,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    });
    const userId = randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>;
    // Harness owns finite request retries; each retry re-enters this meter.
    this.provider =
      provider ??
      new DeepSeekAdapter({
        options: () => connection,
        resolveApiKey: () => resolveOpenCodeGoApiKey(),
        resolveUserId: () => userId,
      });
  }
  async approveTool(): Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string }> {
    if (
      this.toolCalls >= CONFIG.maxTools ||
      Date.now() - this.started >= CONFIG.maxDurationMs ||
      this.ledger.spent === 'unknown'
    )
      return { kind: 'deny', reason: 'Phase 10 attempt budget exhausted' };
    this.toolCalls++;
    return { kind: 'allow' };
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    const resolved = await this.provider.resolveModel(provider, model, signal);
    return {
      ...resolved,
      context: {
        contextWindow: Math.min(
          CONFIG.contextLimit,
          resolved.context?.contextWindow ?? CONFIG.contextLimit,
        ),
      },
    };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!MODELS.includes(options.model as Model)) throw new Error('unregistered benchmark model');
    const model = options.model as Model;
    // Official compaction needs a text summary, never another executable tool call.
    // Preserve its history and identity; only remove auxiliary tool availability.
    if (options.purpose === 'compaction') options = { ...options, tools: [] };
    if (
      this.calls.length >= CONFIG.maxCalls ||
      this.toolCalls >= CONFIG.maxTools ||
      Date.now() - this.started >= CONFIG.maxDurationMs
    )
      throw new Error('attempt budget exhausted');
    // Context admission uses Harness's estimator; monetary reservation uses a byte upper bound.
    const inputBytes = Buffer.byteLength(
      JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools }),
    );
    const inputTokenEstimate = estimateInputTokens(options);
    if (inputTokenEstimate > CONFIG.contextLimit) throw new Error('context limit exhausted');
    if (!options.sessionId) throw new Error('OpenCode Go requires a stable Harness sessionId');
    const rates = CONFIG.peakRates[model];
    const reserve =
      (Math.max(CONFIG.contextLimit, inputByteUpperBound(options)) * rates.input +
        CONFIG.maxTokens * rates.output) /
      1_000_000;
    const id = randomUUID();
    this.ledger.reserve(id, this.trial, this.category, reserve);
    const call: MeteredAdapter['calls'][number] = {
      id,
      model,
      start: Date.now(),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      inputBytes,
      inputTokenEstimate,
      reservedUsd: reserve,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    };
    this.calls.push(call);
    try {
      for await (const chunk of normalizeGoToolStream(
        this.provider.stream({
          ...options,
          model,
          maxTokens: CONFIG.maxTokens,
          temperature: CONFIG.temperature,
          reasoningEffort: ReasoningEffortId(CONFIG.reasoningEffort),
        }),
      )) {
        if (chunk.type === 'usage') call.usage = chunk.usage;
        if (chunk.type === 'finish') call.finishReason = chunk.reason.kind;
        yield chunk;
      }
    } catch (error) {
      call.failed = true;
      throw error;
    } finally {
      call.end = Date.now();
      let cost =
        call.usage === undefined
          ? undefined
          : costOf(model, call.usage, isPeak(new Date(call.start)));
      if (cost !== undefined) call.costBasis = 'reported-cache-split';
      else if (call.usage !== undefined && call.usage.cacheReadTokens === undefined) {
        // The locked adapter preserves total prompt tokens when no cache split is reported.
        // Price every input token at the uncached rate without changing the reported usage.
        cost = costOf(model, { ...call.usage, cacheReadTokens: 0 }, isPeak(new Date(call.start)));
        if (cost !== undefined) call.costBasis = 'uncached-input-upper-bound';
      }
      if (cost !== undefined) call.costUsd = cost;
      this.ledger.settle(id, cost);
    }
  }
}
