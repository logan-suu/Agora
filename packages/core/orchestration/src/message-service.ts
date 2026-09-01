import type { MessageBus } from '@agora/comm-bus';
import {
  type AppState,
  appendMutation,
  createInitialAppState,
  type Message,
  type Mutation,
} from '@agora/core-domain';
import type { TaskScope, TaskStateStore } from '@agora/runtime-state';

export interface MessageCommitResult {
  state: AppState;
  published: boolean;
  message: Message;
}

export interface PlannedMessage {
  message: Message;
  mutations: readonly Mutation[];
}

export class MessageService {
  readonly #store: TaskStateStore;
  readonly #bus: MessageBus;
  readonly #queues = new Map<string, Promise<void>>();

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
    this.#assertMainChannel(message);
    return this.commitPlannedMessage(scope, message.msgId, () => ({ message, mutations: [] }));
  }

  async commitPlannedMessage(
    scope: TaskScope,
    msgId: string,
    plan: (state: AppState) => PlannedMessage,
  ): Promise<MessageCommitResult> {
    return this.#enqueue(scope, async () => {
      const current = await this.#store.load(scope);
      if (current === undefined) {
        throw new Error(
          `task state is not initialized for projectId "${scope.projectId}" and taskId "${scope.taskId}"`,
        );
      }

      const existing = current.messages.find((entry) => entry.msgId === msgId);
      if (existing !== undefined) {
        return { state: current, published: false, message: existing };
      }

      const planned = plan(current);
      if (planned.message.msgId !== msgId) {
        throw new Error(
          `planned message msgId "${planned.message.msgId}" does not match requested msgId "${msgId}"`,
        );
      }
      this.#assertMainChannel(planned.message);

      const commit = await this.#store.commit(scope, [
        appendMutation('messages', planned.message),
        ...planned.mutations,
      ]);
      if (!commit.changed) {
        throw new Error(`new message "${msgId}" produced no state change`);
      }

      await this.#bus.publish({ ...scope, message: planned.message });
      return { state: commit.state, published: true, message: planned.message };
    });
  }

  #assertMainChannel(message: Message): void {
    if (message.channelId !== 'main') {
      throw new Error('Phase 5 message submission only supports channelId "main"');
    }
  }

  async #enqueue<T>(scope: TaskScope, operation: () => Promise<T>): Promise<T> {
    const key = `${scope.projectId}\u0000${scope.taskId}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, tail);

    try {
      return await result;
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }
}
