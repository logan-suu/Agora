import {
  type ChannelSummary,
  parseChannelSummary,
  type RoleSpec,
  type SubChannel,
} from '@agora/core-domain';

import type { HarnessExecutorOptions } from './harness-executor';
import { HarnessExecutor } from './harness-executor';

const SUMMARY_INPUT_BUDGET_CHARS = 4000;

export interface ChannelSummarySourceEntry {
  ref: { taskId: string; msgId: string };
  fromRole: string;
  type: string;
  content?: Record<string, unknown>;
}

export interface ChannelSummaryGenerator {
  generate(input: {
    channel: SubChannel;
    entries: readonly ChannelSummarySourceEntry[];
  }): Promise<ChannelSummary>;
}

export interface HarnessChannelSummaryGeneratorOptions
  extends Pick<HarnessExecutorOptions, 'adapter' | 'provider' | 'deepseek'> {
  model?: string;
}

/** One-shot, tool-less close summarizer over the existing thin Harness. */
export class HarnessChannelSummaryGenerator implements ChannelSummaryGenerator {
  readonly #options: HarnessChannelSummaryGeneratorOptions;

  constructor(options: HarnessChannelSummaryGeneratorOptions = { deepseek: true }) {
    this.#options = options;
  }

  async generate(input: {
    channel: SubChannel;
    entries: readonly ChannelSummarySourceEntry[];
  }): Promise<ChannelSummary> {
    if (input.entries.length === 0) return emptySummary();
    const allowed = new Set(input.entries.map((entry) => entry.ref.msgId));
    const executor = new HarnessExecutor(summaryRole(this.#options.model), {
      ...this.#options,
      allowTools: [],
      tools: [],
    });
    try {
      const chunks = splitEvery(JSON.stringify(input.entries), SUMMARY_INPUT_BUDGET_CHARS);
      const summaries: ChannelSummary[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        summaries.push(
          await runSummaryTurn(executor, input.channel, allowed, {
            stage: 'chunk',
            chunkIndex: index,
            chunkCount: chunks.length,
            serializedFacts: chunks[index],
          }),
        );
      }
      if (summaries.length === 1) return summaries[0] as ChannelSummary;
      return runSummaryTurn(executor, input.channel, allowed, {
        stage: 'merge',
        summaries,
      });
    } finally {
      await executor.dispose();
    }
  }
}

function summaryRole(model?: string): RoleSpec {
  return {
    role: 'COORDINATOR',
    enabled: true,
    executor: 'harness',
    systemPrompt:
      'Summarize only the supplied channel facts. Return one JSON object and no markdown. ' +
      'Exact keys: conclusion, keyDecisions, openQuestions, sourceMsgIds. ' +
      'Each keyDecisions item has exact keys decision and rationale. ' +
      'Do not invent sourceMsgIds.',
    tools: [],
    projection: [],
    routeWhen: 'never',
    ...(model === undefined ? {} : { model }),
  };
}

async function runSummaryTurn(
  executor: HarnessExecutor,
  channel: SubChannel,
  allowed: ReadonlySet<string>,
  input: Record<string, unknown>,
): Promise<ChannelSummary> {
  const result = await executor.step({
    sessionId: `channel-summary-${crypto.randomUUID()}`,
    view: {
      role: 'COORDINATOR',
      slices: {
        channel: {
          channelId: channel.channelId,
          threadId: channel.threadId,
          topic: channel.topic,
        },
        summaryInput: input,
      },
    },
  });
  const text = result.output.text;
  if (typeof text !== 'string') throw new Error('channel summary Harness turn returned no text');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('channel summary Harness output must be pure JSON', { cause: error });
  }
  return parseChannelSummary(value, allowed);
}

function splitEvery(value: string, limit: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += limit) {
    chunks.push(value.slice(offset, offset + limit));
  }
  return chunks;
}

export function emptySummary(): ChannelSummary {
  return {
    conclusion: 'No conclusion recorded.',
    keyDecisions: [],
    openQuestions: [],
    sourceMsgIds: [],
  };
}
