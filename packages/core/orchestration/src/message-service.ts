import type { MessageBus } from '@agora/comm-bus';
import {
  assertMessageChannelAccess,
  type ProjectChannelSnapshot,
  type ProjectChannelStore,
} from '@agora/comm-channels';
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

export interface MutationCommitResult {
  state: AppState;
  changed: boolean;
  publishedMessages: readonly Message[];
}

export class MessageService {
  readonly #store: TaskStateStore;
  readonly #bus: MessageBus;
  readonly #channels: ProjectChannelStore;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(store: TaskStateStore, bus: MessageBus, channels: ProjectChannelStore) {
    this.#store = store;
    this.#bus = bus;
    this.#channels = channels;
  }

  initialize(scope: TaskScope, goal: string): Promise<AppState> {
    return this.#store.initialize(
      scope,
      createInitialAppState(scope.taskId, goal, scope.projectId),
    );
  }

  async commitMessage(scope: TaskScope, message: Message): Promise<MessageCommitResult> {
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
      const project = await this.#loadChannels(scope.projectId);
      assertMessageChannelAccess(project, scope.taskId, planned.message);

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

  async commitMutations(
    scope: TaskScope,
    mutations: readonly Mutation[],
  ): Promise<MutationCommitResult> {
    return this.#enqueue(scope, async () => {
      const current = await this.#store.load(scope);
      if (current === undefined) {
        throw new Error(
          `task state is not initialized for projectId "${scope.projectId}" and taskId "${scope.taskId}"`,
        );
      }

      const messages = mutations.flatMap((mutation) =>
        mutation.op === 'append' && mutation.field === 'messages'
          ? [mutation.value as Message]
          : [],
      );
      if (messages.length > 0) {
        const project = await this.#loadChannels(scope.projectId);
        for (const message of messages) {
          assertMessageChannelAccess(project, scope.taskId, message);
        }
      }
      const commit = await this.#store.commit(scope, mutations);
      const existingIds = new Set(current.messages.map((message) => message.msgId));
      const publishedMessages = commit.state.messages.filter(
        (message) => !existingIds.has(message.msgId),
      );
      for (const message of publishedMessages) {
        await this.#bus.publish({ ...scope, message });
      }
      return { state: commit.state, changed: commit.changed, publishedMessages };
    });
  }

  async #loadChannels(projectId: string): Promise<ProjectChannelSnapshot> {
    const snapshot = await this.#channels.load(projectId);
    if (snapshot === undefined) {
      throw new Error(`project channel store is not initialized for projectId "${projectId}"`);
    }
    return snapshot;
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
