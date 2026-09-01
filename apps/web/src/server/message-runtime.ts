import { basename, dirname, resolve } from 'node:path';
import type { MessageBus, MessageCommitted } from '@agora/comm-bus';
import { toDisplayMessageEvent } from '@agora/comm-bus';
import { JsonProjectChannelStore } from '@agora/comm-channels';
import {
  type AppState,
  createMainChannel,
  type Message,
  type Mutation,
  type RoleId,
  type RoleSpec,
} from '@agora/core-domain';
import {
  type MessageCommitResult,
  MessageService,
  type MutationCommitResult,
} from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
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
  readonly #roster: readonly RoleSpec[];
  readonly #enabledRoles: readonly RoleId[];

  constructor(root: string, stream: ChannelStream, roster: readonly RoleSpec[]) {
    this.root = root;
    this.store = new JsonTaskStateStore(root);
    this.#enabledRoles = roster.filter((spec) => spec.enabled).map((spec) => spec.role);
    this.channels = new JsonProjectChannelStore(root, this.#enabledRoles);
    this.stream = stream;
    this.#service = new MessageService(this.store, new SseMessageBus(stream), this.channels);
    this.#roster = roster;
  }

  async initialize(scope: TaskScope, goal: string): Promise<AppState> {
    await this.#initializeChannels(scope.projectId);
    return this.#service.initialize(scope, goal);
  }

  async initializeState(scope: TaskScope, state: AppState): Promise<AppState> {
    await this.#initializeChannels(scope.projectId);
    return this.store.initialize(scope, state);
  }

  commitMutations(scope: TaskScope, mutations: readonly Mutation[]): Promise<MutationCommitResult> {
    return this.#service.commitMutations(scope, mutations);
  }

  commitMessage(scope: TaskScope, message: Message): Promise<MessageCommitResult> {
    return this.#service.commitMessage(scope, message);
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
    const result = await this.#service.commitPlannedMessage(scope, input.msgId, (state) => {
      const intent = parseLeaderIntent(input.display);
      const planned = planLeaderIntent(intent, state, this.#roster);
      const message: Message = {
        msgId: input.msgId,
        channelId: input.channelId,
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: planned.intent,
          action: planned.action,
        },
        display: input.display,
        ts: input.ts,
      };
      return { message, mutations: planned.mutations };
    });

    return { ...result, action: actionFrom(result.message) };
  }

  #initializeChannels(projectId: string) {
    return this.channels.initialize(projectId, [createMainChannel(this.#enabledRoles)]);
  }
}

export function createMessageRuntime(
  root: string,
  stream = new ChannelStream(),
  roster: readonly RoleSpec[] = DEFAULT_ROSTER,
): MessageRuntime {
  return new MessageRuntime(root, stream, roster);
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
