import type { ProjectChannelStore } from '@agora/comm-channels';
import type { ParticipantId, RoleId, SubChannel } from '@agora/core-domain';
import type { TaskScope } from '@agora/runtime-state';

import type { MessageService } from './message-service';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface OpenSubChannelInput {
  scope: TaskScope;
  actor: ParticipantId;
  actionId: string;
  threadId?: string;
  requestedRoles: readonly RoleId[];
  topic: string;
}

export interface CloseSubChannelInput {
  scope: TaskScope;
  actor: ParticipantId;
  channelId: string;
}

export interface ChannelLifecycleResult {
  channel: SubChannel;
  changed: boolean;
  announced: boolean;
}

export class ChannelLifecycleRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelLifecycleRejectedError';
  }
}

export class ChannelLifecycleService {
  readonly #channels: ProjectChannelStore;
  readonly #messages: MessageService;
  readonly #enabledRoles: readonly RoleId[];
  readonly #clock: () => number;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    channels: ProjectChannelStore,
    messages: MessageService,
    enabledRoles: readonly RoleId[],
    clock: () => number = Date.now,
  ) {
    this.#channels = channels;
    this.#messages = messages;
    this.#enabledRoles = [...enabledRoles];
    this.#clock = clock;
  }

  open(input: OpenSubChannelInput): Promise<ChannelLifecycleResult> {
    return this.#enqueue(input.scope.projectId, async () => {
      const actionId = safeSegment(input.actionId, 'actionId');
      const threadId = safeSegment(input.threadId ?? actionId, 'threadId');
      const topic = nonEmptyString(input.topic, 'topic');
      this.#assertActor(input.actor);
      for (const role of input.requestedRoles) this.#assertEnabledRole(role, 'requested role');

      const requested = new Set<RoleId>(input.requestedRoles);
      if (input.actor !== 'leader') requested.add(input.actor);
      if (requested.size === 0) {
        throw new ChannelLifecycleRejectedError(
          'sub channel must include at least one enabled role',
        );
      }
      const participants: ParticipantId[] = [
        'leader',
        ...this.#enabledRoles.filter((role) => requested.has(role)),
      ];

      const snapshot = await this.#loadProject(input.scope.projectId);
      const existing = snapshot.channels.find(
        (channel): channel is SubChannel =>
          channel.kind === 'sub' &&
          channel.taskId === input.scope.taskId &&
          channel.threadId === threadId,
      );

      let channel: SubChannel;
      let changed = false;
      if (existing !== undefined) {
        if (existing.closed) {
          throw new ChannelLifecycleRejectedError(
            `closed thread cannot be reopened: "${threadId}"`,
          );
        }
        if (existing.topic !== topic || !sameStringSet(existing.participants, participants)) {
          throw new ChannelLifecycleRejectedError(
            `thread "${threadId}" conflicts with existing sub-channel`,
          );
        }
        channel = existing;
      } else {
        channel = {
          channelId: `sub-${safeSegment(input.scope.taskId, 'taskId')}-${actionId}`,
          kind: 'sub',
          taskId: input.scope.taskId,
          threadId,
          topic,
          createdBy: input.actor,
          participants,
          localContext: [],
          closed: false,
        };
        const commit = await this.#channels.commit(input.scope.projectId, snapshot.revision, [
          ...snapshot.channels,
          channel,
        ]);
        changed = commit.changed;
        const committed = commit.snapshot.channels.find(
          (candidate): candidate is SubChannel => candidate.channelId === channel.channelId,
        );
        if (committed === undefined || committed.kind !== 'sub') {
          throw new Error(`committed sub-channel "${channel.channelId}" is missing`);
        }
        channel = committed;
      }

      const announcement = await this.#messages.commitMessage(input.scope, {
        msgId: `${channel.channelId}-opened`,
        threadId: channel.threadId,
        channelId: 'main',
        fromRole: input.actor,
        type: 'announce',
        payload: {
          kind: 'sub_channel_opened',
          channelId: channel.channelId,
          threadId: channel.threadId,
          topic: channel.topic,
          participants: channel.participants,
        },
        display: `Opened sub-channel ${channel.channelId}: ${channel.topic}`,
        ts: this.#clock(),
      });

      return { channel: structuredClone(channel), changed, announced: announcement.published };
    });
  }

  close(input: CloseSubChannelInput): Promise<ChannelLifecycleResult> {
    return this.#enqueue(input.scope.projectId, async () => {
      this.#assertActor(input.actor);
      const channelId = safeSegment(input.channelId, 'channelId');
      if (channelId === 'main') {
        throw new ChannelLifecycleRejectedError('main channel cannot be closed');
      }

      const snapshot = await this.#loadProject(input.scope.projectId);
      const existing = snapshot.channels.find((channel) => channel.channelId === channelId);
      if (existing === undefined) {
        throw new ChannelLifecycleRejectedError(`channel "${channelId}" does not exist`);
      }
      if (existing.kind !== 'sub') {
        throw new ChannelLifecycleRejectedError('main channel cannot be closed');
      }
      if (existing.taskId !== input.scope.taskId) {
        throw new ChannelLifecycleRejectedError(
          `channel "${channelId}" is bound to taskId "${existing.taskId}", not "${input.scope.taskId}"`,
        );
      }
      if (!existing.participants.includes(input.actor)) {
        throw new ChannelLifecycleRejectedError(
          `actor "${input.actor}" is not allowed to close channel "${channelId}"`,
        );
      }

      let channel = existing;
      let changed = false;
      if (!existing.closed) {
        const channels = snapshot.channels.map((candidate) =>
          candidate.channelId === channelId ? { ...candidate, closed: true } : candidate,
        );
        const commit = await this.#channels.commit(
          input.scope.projectId,
          snapshot.revision,
          channels,
        );
        changed = commit.changed;
        const committed = commit.snapshot.channels.find(
          (candidate): candidate is SubChannel => candidate.channelId === channelId,
        );
        if (committed === undefined || committed.kind !== 'sub') {
          throw new Error(`committed sub-channel "${channelId}" is missing`);
        }
        channel = committed;
      }

      const announcement = await this.#messages.commitMessage(input.scope, {
        msgId: `${channel.channelId}-closed`,
        threadId: channel.threadId,
        channelId: 'main',
        fromRole: input.actor,
        type: 'announce',
        payload: {
          kind: 'sub_channel_closed',
          channelId: channel.channelId,
          threadId: channel.threadId,
        },
        display: `Closed sub-channel ${channel.channelId}`,
        ts: this.#clock(),
      });

      return { channel: structuredClone(channel), changed, announced: announcement.published };
    });
  }

  async #loadProject(projectId: string) {
    const snapshot = await this.#channels.load(projectId);
    if (snapshot === undefined) {
      throw new Error(`project channel store is not initialized for projectId "${projectId}"`);
    }
    return snapshot;
  }

  #assertActor(actor: ParticipantId): void {
    if (actor !== 'leader') this.#assertEnabledRole(actor, 'actor');
  }

  #assertEnabledRole(role: RoleId, field: string): void {
    if (!this.#enabledRoles.includes(role)) {
      throw new ChannelLifecycleRejectedError(`${field} "${role}" is not enabled`);
    }
  }

  async #enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(projectId, tail);

    try {
      return await result;
    } finally {
      if (this.#queues.get(projectId) === tail) this.#queues.delete(projectId);
    }
  }
}

function safeSegment(value: string, field: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new ChannelLifecycleRejectedError(`${field} must be a safe non-empty segment`);
  }
  return value;
}

function nonEmptyString(value: string, field: string): string {
  if (value.length === 0) {
    throw new ChannelLifecycleRejectedError(`${field} must be a non-empty string`);
  }
  return value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}
