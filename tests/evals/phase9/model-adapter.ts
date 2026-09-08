import { randomUUID } from 'node:crypto';
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
import { ExperimentBudget, isPeak, PRICING, usageCost } from './metrics';

const MAX_OUTPUT_TOKENS = 32768;
const CONTEXT_LIMIT = 1_000_000;

export const MODEL_CONFIG = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  parameters: {
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    thinking: 'enabled' as const,
    reasoningEffort: 'high' as const,
    retries: 0,
    contextLimit: CONTEXT_LIMIT,
    endpoint: 'https://api.deepseek.com',
    requestReservationUsd:
      (CONTEXT_LIMIT * PRICING.peak.input + MAX_OUTPUT_TOKENS * PRICING.peak.output) / 1_000_000,
  },
};
export class MeteredFlashAdapter extends LlmAdapter {
  readonly calls: {
    start: number;
    end?: number;
    usage?: TokenUsage;
    costUsd?: number;
    failed?: boolean;
    finishReason?: string;
    outputTruncated?: boolean;
    sessionId?: string;
  }[] = [];
  readonly started = Date.now();
  toolCalls = 0;
  private readonly attemptBudget = new ExperimentBudget(2);
  private readonly adapter: LlmAdapter;
  constructor(
    private readonly groupBudget: ExperimentBudget,
    adapter?: LlmAdapter,
  ) {
    super();
    if (adapter) {
      this.adapter = adapter;
      return;
    }
    const connection = resolveAdapterOptions({
      baseURL: MODEL_CONFIG.parameters.endpoint,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      maxTokens: MODEL_CONFIG.parameters.maxTokens,
      thinking: MODEL_CONFIG.parameters.thinking,
      reasoningEffort: MODEL_CONFIG.parameters.reasoningEffort,
      retryPolicy: { mode: 'normal', maxRetries: MODEL_CONFIG.parameters.retries },
    });
    const userId = randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>;
    this.adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: async () => {
        const key = process.env.DEEPSEEK_API_KEY;
        if (!key) throw new Error('DEEPSEEK_API_KEY required');
        return key;
      },
      resolveUserId: () => userId,
    });
  }
  get costUsd() {
    return this.attemptBudget.costUsd;
  }
  async approveTool(): Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string }> {
    if (
      this.toolCalls >= 240 ||
      Date.now() - this.started >= 1_200_000 ||
      this.costUsd === 'unknown' ||
      (typeof this.costUsd === 'number' && this.costUsd >= 2)
    )
      return { kind: 'deny', reason: 'Phase 9 attempt budget exhausted' };
    this.toolCalls++;
    return { kind: 'allow' };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.calls.length >= 120 || this.toolCalls >= 240 || Date.now() - this.started >= 1_200_000)
      throw new Error('Phase 9 attempt budget exhausted');
    // Reserve the full configured context and output cap at the higher tariff.
    const reserve = MODEL_CONFIG.parameters.requestReservationUsd;
    const attempt = this.attemptBudget.reserve(reserve);
    let group: symbol;
    try {
      group = this.groupBudget.reserve(reserve);
    } catch (error) {
      this.attemptBudget.finish(attempt, 0);
      throw error;
    }
    const call: MeteredFlashAdapter['calls'][number] = {
      start: Date.now(),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    };
    this.calls.push(call);
    try {
      for await (const chunk of this.adapter.stream({
        ...options,
        model: MODEL_CONFIG.model,
        maxTokens: MODEL_CONFIG.parameters.maxTokens,
        temperature: MODEL_CONFIG.parameters.temperature,
        reasoningEffort: ReasoningEffortId(MODEL_CONFIG.parameters.reasoningEffort),
      })) {
        if (chunk.type === 'usage') call.usage = chunk.usage;
        if (chunk.type === 'finish') {
          call.finishReason = chunk.reason.kind;
          call.outputTruncated = chunk.reason.kind === 'max-tokens';
        }
        yield chunk;
      }
    } catch (error) {
      call.failed = true;
      throw error;
    } finally {
      call.end = Date.now();
      const cost =
        call.usage === undefined ? undefined : usageCost(call.usage, isPeak(new Date(call.start)));
      if (cost !== undefined) call.costUsd = cost;
      this.attemptBudget.finish(attempt, cost);
      this.groupBudget.finish(group, cost);
    }
  }
}
