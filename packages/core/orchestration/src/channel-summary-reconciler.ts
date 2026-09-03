import {
  allowedChannelEntries,
  type LegacyBubbledSummary,
  type ProjectChannelStore,
} from '@agora/comm-channels';
import {
  type AppState,
  type ChannelSummary,
  emptyChannelSummary,
  type Message,
  parseChannelSummary,
  type SubChannel,
} from '@agora/core-domain';
import type { ChannelSummaryGenerator } from '@agora/runtime-executor';
import type { TaskScope, TaskStateStore } from '@agora/runtime-state';

import type { MessageService } from './message-service';

const MAX_REF_COMMIT_ATTEMPTS = 4;

export interface ChannelSummaryReconcilerOptions {
  channels: ProjectChannelStore;
  messages: MessageService;
  state: TaskStateStore;
  generator: ChannelSummaryGenerator;
  legacySummaries?: (projectId: string) => Promise<LegacyBubbledSummary[]>;
  acknowledgeLegacySummary?: (projectId: string, channelId: string) => Promise<void>;
  clock?: () => number;
}

/** Repairs every closed sub-channel to message-first/ref-second completion. */
export class ChannelSummaryReconciler {
  readonly #options: ChannelSummaryReconcilerOptions;

  constructor(options: ChannelSummaryReconcilerOptions) {
    this.#options = options;
  }

  async reconcile(scope: TaskScope): Promise<AppState | undefined> {
    const state = await this.#options.state.load(scope);
    if (state === undefined) return undefined;
    const snapshot = await this.#options.channels.load(scope.projectId);
    if (snapshot === undefined) return state;
    const legacy = new Map(
      (await this.#options.legacySummaries?.(scope.projectId))
        ?.filter((entry) => entry.taskId === scope.taskId)
        .map((entry) => [entry.channelId, entry] as const) ?? [],
    );
    for (const channel of snapshot.channels) {
      if (channel.kind !== 'sub' || channel.taskId !== scope.taskId || !channel.closed) continue;
      if (channel.bubbledSummaryRef !== undefined && !legacy.has(channel.channelId)) continue;
      await this.#reconcileOne(scope, channel, legacy.get(channel.channelId));
    }
    return this.#requiredState(scope);
  }

  async #reconcileOne(
    scope: TaskScope,
    initialChannel: SubChannel,
    legacy: LegacyBubbledSummary | undefined,
  ): Promise<void> {
    const msgId = `channel-bubble:${initialChannel.channelId}`;
    let state = await this.#requiredState(scope);
    let canonical = state.messages.find((message) => message.msgId === msgId);
    const sourceEntries = allowedChannelEntries(state, initialChannel);
    const allowedSourceIds = new Set(sourceEntries.map((entry) => entry.ref.msgId));

    if (canonical === undefined) {
      const generated =
        legacy === undefined
          ? sourceEntries.length === 0
            ? emptyChannelSummary()
            : await this.#options.generator.generate({
                channel: initialChannel,
                entries: sourceEntries,
              })
          : legacySummary(legacy.summary);
      const summary = parseChannelSummary(generated, allowedSourceIds);
      const committed = await this.#options.messages.commitMessage(
        scope,
        summaryMessage(initialChannel, summary, this.#options.clock?.() ?? Date.now()),
      );
      canonical = committed.message;
    }

    state = await this.#requiredState(scope);
    canonical = state.messages.find((message) => message.msgId === msgId);
    if (canonical === undefined)
      throw new Error(`canonical channel summary "${msgId}" disappeared`);
    validateCanonicalMessage(canonical, initialChannel, allowedSourceIds);

    for (let attempt = 0; attempt < MAX_REF_COMMIT_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#options.channels.load(scope.projectId);
      if (snapshot === undefined)
        throw new Error('project channel store disappeared during reconcile');
      const channel = snapshot.channels.find(
        (candidate): candidate is SubChannel => candidate.channelId === initialChannel.channelId,
      );
      if (channel === undefined || channel.kind !== 'sub') {
        throw new Error(`sub-channel "${initialChannel.channelId}" disappeared during reconcile`);
      }
      const expectedRef = { taskId: scope.taskId, msgId };
      const hasLegacy = 'bubbledSummary' in (channel as unknown as Record<string, unknown>);
      if (
        channel.bubbledSummaryRef?.taskId === expectedRef.taskId &&
        channel.bubbledSummaryRef.msgId === expectedRef.msgId &&
        !hasLegacy
      ) {
        if (legacy !== undefined) await this.#acknowledgeLegacy(scope.projectId, channel.channelId);
        return;
      }
      const channels = snapshot.channels.map((candidate) =>
        candidate.channelId === channel.channelId
          ? canonicalSubChannel(channel, expectedRef)
          : candidate,
      );
      try {
        await this.#options.channels.commit(scope.projectId, snapshot.revision, channels);
        if (legacy !== undefined) await this.#acknowledgeLegacy(scope.projectId, channel.channelId);
        return;
      } catch (error) {
        if (
          !String(error).includes('expected revision') ||
          attempt === MAX_REF_COMMIT_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
  }

  async #acknowledgeLegacy(projectId: string, channelId: string): Promise<void> {
    await this.#options.acknowledgeLegacySummary?.(projectId, channelId);
  }

  async #requiredState(scope: TaskScope): Promise<AppState> {
    const state = await this.#options.state.load(scope);
    if (state === undefined) throw new Error('task state disappeared during channel reconcile');
    return state;
  }
}

function summaryMessage(channel: SubChannel, summary: ChannelSummary, ts: number): Message {
  return {
    msgId: `channel-bubble:${channel.channelId}`,
    threadId: channel.threadId,
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    payload: {
      kind: 'channel_summary',
      channelId: channel.channelId,
      threadId: channel.threadId,
      summary,
    },
    display: summary.conclusion,
    ts,
  };
}

function validateCanonicalMessage(
  message: Message,
  channel: SubChannel,
  allowedSourceIds: ReadonlySet<string>,
): void {
  if (
    message.msgId !== `channel-bubble:${channel.channelId}` ||
    message.threadId !== channel.threadId ||
    message.channelId !== 'main' ||
    message.fromRole !== 'COORDINATOR' ||
    message.type !== 'announce'
  ) {
    throw new Error('canonical channel summary message identity is invalid');
  }
  const keys = Object.keys(message.payload).sort();
  if (keys.join(',') !== ['channelId', 'kind', 'summary', 'threadId'].join(',')) {
    throw new Error('canonical channel summary payload contains missing or unexpected fields');
  }
  if (
    message.payload.kind !== 'channel_summary' ||
    message.payload.channelId !== channel.channelId ||
    message.payload.threadId !== channel.threadId
  ) {
    throw new Error('canonical channel summary payload scope is invalid');
  }
  const summary = parseChannelSummary(message.payload.summary, allowedSourceIds);
  if (message.display !== summary.conclusion) {
    throw new Error('canonical channel summary display must equal its conclusion');
  }
}

function canonicalSubChannel(
  channel: SubChannel,
  ref: { taskId: string; msgId: string },
): SubChannel {
  const record = structuredClone(channel) as unknown as Record<string, unknown>;
  delete record.bubbledSummary;
  delete record.localContext;
  record.bubbledSummaryRef = ref;
  return record as unknown as SubChannel;
}

function legacySummary(value: string): ChannelSummary {
  return {
    conclusion: value.trim().length === 0 ? 'No conclusion recorded.' : value,
    keyDecisions: [],
    openQuestions: [],
    sourceMsgIds: [],
  };
}
