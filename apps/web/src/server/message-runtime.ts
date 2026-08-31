import { basename, dirname, resolve } from 'node:path';
import type { MessageBus, MessageCommitted } from '@agora/comm-bus';
import { toDisplayMessageEvent } from '@agora/comm-bus';
import type { AppState, Message } from '@agora/core-domain';
import { type MessageCommitResult, MessageService } from '@agora/core-orchestration';
import { JsonTaskStateStore, type TaskScope } from '@agora/runtime-state';

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

  constructor(root: string, stream: ChannelStream) {
    this.store = new JsonTaskStateStore(root);
    this.stream = stream;
    this.#service = new MessageService(this.store, new SseMessageBus(stream));
  }

  initialize(scope: TaskScope, goal: string): Promise<AppState> {
    return this.#service.initialize(scope, goal);
  }

  commitMessage(scope: TaskScope, message: Message): Promise<MessageCommitResult> {
    return this.#service.commitMessage(scope, message);
  }
}

export function createMessageRuntime(root: string, stream = new ChannelStream()): MessageRuntime {
  return new MessageRuntime(root, stream);
}

const workingDirectory = process.cwd();
const workspaceRoot =
  basename(workingDirectory) === 'web' && basename(dirname(workingDirectory)) === 'apps'
    ? resolve(workingDirectory, '../..')
    : workingDirectory;
const defaultDataRoot = process.env.AGORA_DATA_ROOT ?? resolve(workspaceRoot, '.data');
export const messageRuntime = createMessageRuntime(defaultDataRoot, channelStream);
