import { basename, dirname, resolve } from 'node:path';
import type { MessageBus, MessageCommitted } from '@agora/comm-bus';
import { toDisplayMessageEvent } from '@agora/comm-bus';
import { DerivedChannelContextBuilder, JsonProjectChannelStore } from '@agora/comm-channels';
import {
  type AppState,
  createMainChannel,
  type Message,
  type Mutation,
  type RoleId,
  type RoleSpec,
} from '@agora/core-domain';
import {
  ChannelLifecycleRejectedError,
  ChannelLifecycleService,
  ChannelSummaryReconciler,
  type MessageCommitResult,
  MessageService,
  type MutationCommitResult,
} from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import {
  type ChannelSummaryGenerator,
  HarnessChannelSummaryGenerator,
} from '@agora/runtime-executor';
import { JsonTaskStateStore, type TaskScope } from '@agora/runtime-state';

import { type LeaderActionStatus, parseLeaderIntent, planLeaderIntent } from '../lib/intent';
import { type ChannelAddress, ChannelStream, channelStream } from './channel-stream';

class SseMessageBus implements MessageBus {
  readonly #stream: ChannelStream;

  constructor(stream: ChannelStream) {
    this.#stream = stream;
  }

  async publish(event: MessageCommitted): Promise<void> {
    const address: ChannelAddress = {
      projectId: event.projectId,
      taskId: event.taskId,
      channelId: event.message.channelId,
    };
    this.#stream.publish(address, {
      type: 'message',
      data: toDisplayMessageEvent(event),
    });
  }
}

export class MessageRuntime {
  readonly root: string;
  readonly store: JsonTaskStateStore;
  readonly channels: JsonProjectChannelStore;
  readonly stream: ChannelStream;
  readonly #service: MessageService;
  readonly #lifecycle: ChannelLifecycleService;
  readonly #summaryReconciler: ChannelSummaryReconciler;
  readonly #roster: readonly RoleSpec[];
  readonly #channelContext = new DerivedChannelContextBuilder();
  readonly #enabledRoles: readonly RoleId[];
  readonly #leaderQueues = new Map<string, Promise<void>>();

  constructor(
    root: string,
    stream: ChannelStream,
    roster: readonly RoleSpec[],
    summaryGenerator: ChannelSummaryGenerator = new HarnessChannelSummaryGenerator(),
  ) {
    this.root = root;
    this.store = new JsonTaskStateStore(root);
    this.#enabledRoles = roster.filter((spec) => spec.enabled).map((spec) => spec.role);
    this.channels = new JsonProjectChannelStore(root, this.#enabledRoles);
    this.stream = stream;
    this.#service = new MessageService(this.store, new SseMessageBus(stream), this.channels);
    this.#lifecycle = new ChannelLifecycleService(this.channels, this.#service, this.#enabledRoles);
    this.#summaryReconciler = new ChannelSummaryReconciler({
      channels: this.channels,
      messages: this.#service,
      state: this.store,
      generator: summaryGenerator,
      legacySummaries: (projectId) => this.channels.legacyBubbledSummaries(projectId),
    });
    this.#roster = roster;
  }

  async initialize(scope: TaskScope, goal: string): Promise<AppState> {
    await this.ensureProjectChannels(scope.projectId);
    const state = await this.#service.initialize(scope, goal);
    return (await this.#summaryReconciler.reconcile(scope)) ?? state;
  }

  async initializeState(scope: TaskScope, state: AppState): Promise<AppState> {
    await this.ensureProjectChannels(scope.projectId);
    const initialized = await this.store.initialize(scope, state);
    return (await this.#summaryReconciler.reconcile(scope)) ?? initialized;
  }

  commitMutations(scope: TaskScope, mutations: readonly Mutation[]): Promise<MutationCommitResult> {
    return this.#service.commitMutations(scope, mutations);
  }

  commitMessage(scope: TaskScope, message: Message): Promise<MessageCommitResult> {
    return this.#service.commitMessage(scope, message);
  }

  ensureProjectChannels(projectId: string) {
    return this.channels.initialize(projectId, [createMainChannel(this.#enabledRoles)]);
  }

  async channelContextFor(state: AppState, role: string) {
    const snapshot = await this.channels.load(state.projectId);
    if (snapshot === undefined) {
      throw new Error(
        `project channel store is not initialized for projectId "${state.projectId}"`,
      );
    }
    return this.#channelContext.build(snapshot, state, role);
  }

  reconcileChannels(scope: TaskScope): Promise<AppState | undefined> {
    return this.#summaryReconciler.reconcile(scope);
  }

  async commitLeaderMessage(
    scope: TaskScope,
    input: {
      msgId: string;
      channelId: string;
      display: string;
      ts: number;
    },
  ): Promise<MessageCommitResult & { action: LeaderActionStatus }> {
    return this.#enqueueLeader(scope, () => this.#commitLeaderMessage(scope, input));
  }

  async #commitLeaderMessage(
    scope: TaskScope,
    input: {
      msgId: string;
      channelId: string;
      display: string;
      ts: number;
    },
  ): Promise<MessageCommitResult & { action: LeaderActionStatus }> {
    const current = await this.store.load(scope);
    if (current === undefined) {
      throw new Error(
        `task state is not initialized for projectId "${scope.projectId}" and taskId "${scope.taskId}"`,
      );
    }
    const existing = current.messages.find((message) => message.msgId === input.msgId);
    if (existing !== undefined) {
      return { state: current, published: false, message: existing, action: actionFrom(existing) };
    }
    await this.#summaryReconciler.reconcile(scope);

    const intent = parseLeaderIntent(input.display);
    let lifecycleRejection: LeaderActionStatus | undefined;
    try {
      if (intent.kind === 'open_sub_channel') {
        if (input.channelId !== 'main') {
          throw new ChannelLifecycleRejectedError('channel lifecycle commands must use main');
        }
        await this.#lifecycle.open({
          scope,
          actor: 'leader',
          actionId: input.msgId,
          requestedRoles: intent.requestedRoles,
          topic: intent.topic,
        });
      } else if (intent.kind === 'close_sub_channel') {
        if (input.channelId !== 'main') {
          throw new ChannelLifecycleRejectedError('channel lifecycle commands must use main');
        }
        await this.#lifecycle.close({
          scope,
          actor: 'leader',
          actionId: input.msgId,
          channelId: intent.channelId,
        });
        await this.#summaryReconciler.reconcile(scope);
      }
    } catch (error) {
      if (!(error instanceof ChannelLifecycleRejectedError)) throw error;
      lifecycleRejection = { status: 'rejected', reason: error.message };
    }

    const result = await this.#service.commitPlannedMessage(scope, input.msgId, (state) => {
      const planned = planLeaderIntent(intent, state, this.#roster);
      const action = lifecycleRejection ?? planned.action;
      const message: Message = {
        msgId: input.msgId,
        channelId: input.channelId,
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: planned.intent,
          action,
        },
        display: input.display,
        ts: input.ts,
      };
      return { message, mutations: planned.mutations };
    });

    return { ...result, action: actionFrom(result.message) };
  }

  async handleWorkerOutput(
    state: AppState,
    role: string,
    output: Record<string, unknown>,
  ): Promise<void> {
    const action = output.channelAction;
    if (typeof action !== 'object' || action === null || Array.isArray(action)) return;
    const record = action as Record<string, unknown>;
    const scope = { projectId: state.projectId, taskId: state.taskId };
    if (record.kind === 'open_sub_channel') {
      if (
        typeof record.actionId !== 'string' ||
        (record.threadId !== undefined && typeof record.threadId !== 'string') ||
        !Array.isArray(record.requestedRoles) ||
        !record.requestedRoles.every((requested) => typeof requested === 'string') ||
        typeof record.topic !== 'string'
      ) {
        throw new Error('invalid structured open_sub_channel output');
      }
      await this.#lifecycle.open({
        scope,
        actor: role,
        actionId: record.actionId,
        ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
        requestedRoles: record.requestedRoles,
        topic: record.topic,
      });
      return;
    }
    if (record.kind === 'close_sub_channel') {
      if (typeof record.channelId !== 'string') {
        throw new Error('invalid structured close_sub_channel output');
      }
      if (typeof record.actionId !== 'string') {
        throw new Error('invalid structured close_sub_channel output');
      }
      await this.#lifecycle.close({
        scope,
        actor: role,
        actionId: record.actionId,
        channelId: record.channelId,
      });
      await this.#summaryReconciler.reconcile(scope);
      return;
    }
    throw new Error('unknown structured channel action output');
  }

  async #enqueueLeader<T>(scope: TaskScope, operation: () => Promise<T>): Promise<T> {
    const key = `${scope.projectId}\u0000${scope.taskId}`;
    const previous = this.#leaderQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#leaderQueues.set(key, tail);

    try {
      return await result;
    } finally {
      if (this.#leaderQueues.get(key) === tail) this.#leaderQueues.delete(key);
    }
  }
}

export function createMessageRuntime(
  root: string,
  stream = new ChannelStream(),
  roster: readonly RoleSpec[] = DEFAULT_ROSTER,
  summaryGenerator?: ChannelSummaryGenerator,
): MessageRuntime {
  return new MessageRuntime(root, stream, roster, summaryGenerator);
}

export function getOrCreateMessageRuntime(
  registry: { messageRuntime: MessageRuntime | undefined },
  create: () => MessageRuntime,
): MessageRuntime {
  if (registry.messageRuntime !== undefined) return registry.messageRuntime;
  const runtime = create();
  registry.messageRuntime = runtime;
  return runtime;
}

function actionFrom(message: Message): LeaderActionStatus {
  const action = message.payload.action;
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return { status: 'none' };
  }
  const status = (action as Record<string, unknown>).status;
  if (status === 'applied' || status === 'none') return { status };
  const reason = (action as Record<string, unknown>).reason;
  if (status === 'rejected' && typeof reason === 'string') return { status, reason };
  const targetPhase = (action as Record<string, unknown>).targetPhase;
  if (
    status === 'deferred' &&
    (targetPhase === 6 || targetPhase === 8 || targetPhase === 9) &&
    typeof reason === 'string'
  ) {
    return { status, targetPhase, reason };
  }
  return { status: 'none' };
}

const workingDirectory = process.cwd();
const workspaceRoot =
  basename(workingDirectory) === 'web' && basename(dirname(workingDirectory)) === 'apps'
    ? resolve(workingDirectory, '../..')
    : workingDirectory;
const defaultDataRoot = process.env.AGORA_DATA_ROOT ?? resolve(workspaceRoot, '.data');
const processRegistry = globalThis as typeof globalThis & {
  __agoraMessageRuntime?: MessageRuntime;
};
export const messageRuntime = getOrCreateMessageRuntime(
  {
    get messageRuntime() {
      return processRegistry.__agoraMessageRuntime;
    },
    set messageRuntime(runtime: MessageRuntime | undefined) {
      if (runtime === undefined) {
        delete processRegistry.__agoraMessageRuntime;
      } else {
        processRegistry.__agoraMessageRuntime = runtime;
      }
    },
  },
  () => createMessageRuntime(defaultDataRoot, channelStream),
);
