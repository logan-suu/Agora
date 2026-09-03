import {
  type ChannelSummary,
  emptyChannelSummary,
  parseChannelSummary,
  type RoleSpec,
  type SubChannel,
} from '@agora/core-domain';

import type { ChannelSummaryGenerator, ChannelSummarySourceEntry } from './base';
import type { HarnessExecutorOptions } from './harness-executor';
import { HarnessExecutor } from './harness-executor';

const SUMMARY_INPUT_BUDGET_CHARS = 4000;
const SUMMARY_OUTPUT_BUDGET_CHARS = 1600;

interface ChannelSummarySourceFragment {
  ref: { taskId: string; msgId: string };
  fromRole: string;
  type: string;
  fragmentIndex: number;
  fragmentCount: number;
  serializedFragment: string;
}

type ChannelSummaryFact = ChannelSummarySourceEntry | ChannelSummarySourceFragment;

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
    if (input.entries.length === 0) return emptyChannelSummary();
    const executor = new HarnessExecutor(summaryRole(this.#options.model), {
      ...this.#options,
      allowTools: [],
      tools: [],
    });
    try {
      const summaries: ChannelSummary[] = [];
      for (const facts of chunkEntries(input.entries)) {
        summaries.push(
          await runSummaryTurn(
            executor,
            input.channel,
            new Set(facts.map((fact) => fact.ref.msgId)),
            { stage: 'chunk', facts },
          ),
        );
      }
      return await mergeSummaries(executor, input.channel, summaries);
    } finally {
      await executor.dispose();
    }
  }
}

function summaryRole(model?: string): RoleSpec {
  return {
    role: 'COORDINATOR',
    executor: 'harness',
    systemPrompt:
      'Summarize only the supplied channel facts. A fragmented fact is a serialized JSON entry ' +
      'split across ordered fragments. Return one JSON object and no markdown. Exact keys: ' +
      'conclusion, keyDecisions, openQuestions, sourceMsgIds. Each keyDecisions item has exact ' +
      'keys decision and rationale. Do not invent sourceMsgIds.',
    tools: [],
    projection: [],
    routeWhen: 'never',
    ...(model === undefined ? {} : { model }),
  };
}

async function mergeSummaries(
  executor: HarnessExecutor,
  channel: SubChannel,
  initial: ChannelSummary[],
): Promise<ChannelSummary> {
  let pending = initial;
  while (pending.length > 1) {
    const next: ChannelSummary[] = [];
    for (const batch of packMergeBatches(pending)) {
      if (batch.length === 1) {
        next.push(batch[0] as ChannelSummary);
        continue;
      }
      next.push(
        await runSummaryTurn(
          executor,
          channel,
          new Set(batch.flatMap((summary) => summary.sourceMsgIds)),
          { stage: 'merge', summaries: batch },
        ),
      );
    }
    if (next.length >= pending.length) {
      throw new Error('channel summary merge made no progress within the input budget');
    }
    pending = next;
  }
  const result = pending[0];
  if (result === undefined) throw new Error('channel summary generation produced no result');
  return result;
}

async function runSummaryTurn(
  executor: HarnessExecutor,
  channel: SubChannel,
  allowed: ReadonlySet<string>,
  input: Record<string, unknown>,
): Promise<ChannelSummary> {
  assertWithinInputBudget(input);
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
  const summary = parseChannelSummary(value, allowed);
  if (JSON.stringify(summary).length > SUMMARY_OUTPUT_BUDGET_CHARS) {
    throw new Error(
      `channel summary output exceeds ${SUMMARY_OUTPUT_BUDGET_CHARS} character merge budget`,
    );
  }
  return summary;
}

function chunkEntries(entries: readonly ChannelSummarySourceEntry[]): ChannelSummaryFact[][] {
  const facts = entries.flatMap((entry) =>
    fitsInputBudget({ stage: 'chunk', facts: [entry] }) ? [entry] : fragmentEntry(entry),
  );
  return packByBudget(facts, (items) => ({ stage: 'chunk', facts: items }));
}

function fragmentEntry(entry: ChannelSummarySourceEntry): ChannelSummarySourceFragment[] {
  const serialized = JSON.stringify(entry);
  const fragmentSize = maximumFragmentSize(entry, serialized.length);
  if (fragmentSize < 1) {
    throw new Error('channel summary entry metadata exceeds the input budget');
  }
  const fragmentCount = Math.ceil(serialized.length / fragmentSize);
  const fragments: ChannelSummarySourceFragment[] = [];
  for (let offset = 0; offset < serialized.length; offset += fragmentSize) {
    fragments.push({
      ref: entry.ref,
      fromRole: entry.fromRole,
      type: entry.type,
      fragmentIndex: fragments.length,
      fragmentCount,
      serializedFragment: serialized.slice(offset, offset + fragmentSize),
    });
  }
  for (const fragment of fragments) {
    assertWithinInputBudget({ stage: 'chunk', facts: [fragment] });
  }
  return fragments;
}

function maximumFragmentSize(entry: ChannelSummarySourceEntry, maximum: number): number {
  let lower = 0;
  let upper = maximum;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    const placeholder: ChannelSummarySourceFragment = {
      ref: entry.ref,
      fromRole: entry.fromRole,
      type: entry.type,
      fragmentIndex: Number.MAX_SAFE_INTEGER,
      fragmentCount: Number.MAX_SAFE_INTEGER,
      serializedFragment: 'x'.repeat(candidate),
    };
    if (fitsInputBudget({ stage: 'chunk', facts: [placeholder] })) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function packMergeBatches(summaries: readonly ChannelSummary[]): ChannelSummary[][] {
  return packByBudget(summaries, (items) => ({ stage: 'merge', summaries: items }));
}

function packByBudget<T>(
  values: readonly T[],
  wrap: (items: readonly T[]) => Record<string, unknown>,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const value of values) {
    const candidate = [...current, value];
    if (fitsInputBudget(wrap(candidate))) {
      current = candidate;
      continue;
    }
    if (current.length === 0) throw new Error('channel summary item exceeds the input budget');
    batches.push(current);
    current = [value];
    assertWithinInputBudget(wrap(current));
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function fitsInputBudget(input: Record<string, unknown>): boolean {
  return JSON.stringify(input).length <= SUMMARY_INPUT_BUDGET_CHARS;
}

function assertWithinInputBudget(input: Record<string, unknown>): void {
  if (!fitsInputBudget(input)) {
    throw new Error(`channel summary input exceeds ${SUMMARY_INPUT_BUDGET_CHARS} character budget`);
  }
}
