import type { MessageBus } from '@agora/comm-bus';
import {
  type AppState,
  appendMutation,
  createInitialAppState,
  type Message,
} from '@agora/core-domain';
import type { TaskScope, TaskStateStore } from '@agora/runtime-state';

export interface MessageCommitResult {
  state: AppState;
  published: boolean;
}

export class MessageService {
  readonly #store: TaskStateStore;
  readonly #bus: MessageBus;

  constructor(store: TaskStateStore, bus: MessageBus) {
    this.#store = store;
    this.#bus = bus;
  }

  initialize(scope: TaskScope, goal: string): Promise<AppState> {
    return this.#store.initialize(
      scope,
      createInitialAppState(scope.taskId, goal, scope.projectId),
    );
  }

  async commitMessage(scope: TaskScope, message: Message): Promise<MessageCommitResult> {
    if (message.channelId !== 'main') {
      throw new Error('Phase 5 message submission only supports channelId "main"');
    }

    const commit = await this.#store.commit(scope, [appendMutation('messages', message)]);
    if (!commit.changed) return { state: commit.state, published: false };

    await this.#bus.publish({ ...scope, message });
    return { state: commit.state, published: true };
  }
}
