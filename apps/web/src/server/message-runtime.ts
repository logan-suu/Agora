import { basename, dirname, resolve } from 'node:path';
import type { MessageBus, MessageCommitted } from '@agora/comm-bus';
import { toDisplayMessageEvent } from '@agora/comm-bus';
import type { AppState, Message, RoleSpec } from '@agora/core-domain';
import { type MessageCommitResult, MessageService } from '@agora/core-orchestration';
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
  readonly store: JsonTaskStateStore;
  readonly stream: ChannelStream;
  readonly #service: MessageService;
  readonly #roster: readonly RoleSpec[];

  constructor(root: string, stream: ChannelStream, roster: readonly RoleSpec[]) {
    this.store = new JsonTaskStateStore(root);
    this.stream = stream;
    this.#service = new MessageService(this.store, new SseMessageBus(stream));
    this.#roster = roster;
  }

  initialize(scope: TaskScope, goal: string): Promise<AppState> {
    return this.#service.initialize(scope, goal);
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
}

export function createMessageRuntime(
  root: string,
  stream = new ChannelStream(),
  roster: readonly RoleSpec[] = DEFAULT_ROSTER,
): MessageRuntime {
  return new MessageRuntime(root, stream, roster);
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
export const messageRuntime = createMessageRuntime(defaultDataRoot, channelStream);
