import type {
  AppState,
  Channel,
  Message,
  MessageRef,
  MsgType,
  ParticipantId,
} from '@agora/core-domain';

import type { ProjectChannelSnapshot } from './base';

export const CHANNEL_CONTEXT_BUDGET_CHARS = 4000;

export interface ChannelContextEntry {
  ref: MessageRef;
  fromRole: string;
  type: MsgType;
  content?: Record<string, unknown>;
}

export interface ChannelContext {
  channelId: string;
  kind: 'main' | 'sub';
  threadId?: string;
  topic?: string;
  entries: ChannelContextEntry[];
  omittedRefs: MessageRef[];
}

export interface ChannelContextBuilder {
  build(project: ProjectChannelSnapshot, task: AppState, role: ParticipantId): ChannelContext[];
}

/** Read-time, default-deny Channel projection. It never copies Message.display. */
export class DerivedChannelContextBuilder implements ChannelContextBuilder {
  build(project: ProjectChannelSnapshot, task: AppState, role: ParticipantId): ChannelContext[] {
    if (project.projectId !== task.projectId) {
      throw new Error(
        `project identity mismatch: channel snapshot is "${project.projectId}" but task is "${task.projectId}"`,
      );
    }

    return project.channels.flatMap((channel) => {
      if (!channel.participants.includes(role)) return [];
      if (channel.kind === 'sub' && channel.taskId !== task.taskId) return [];

      const candidates = task.messages.flatMap((message) => {
        if (message.channelId !== channel.channelId) return [];
        if (!channel.participants.includes(message.fromRole)) return [];
        if (channel.kind === 'main' && message.type === 'chat') return [];
        return [entryOf(task.taskId, message)];
      });
      const { entries, omittedRefs } = withinBudget(candidates, CHANNEL_CONTEXT_BUDGET_CHARS);
      return [
        {
          channelId: channel.channelId,
          kind: channel.kind,
          ...(channel.kind === 'sub' ? { threadId: channel.threadId, topic: channel.topic } : {}),
          entries,
          omittedRefs,
        },
      ];
    });
  }
}

/** The same allowlist projection without runtime truncation, used by close summaries. */
export function allowedChannelEntries(task: AppState, channel: Channel): ChannelContextEntry[] {
  return task.messages.flatMap((message) =>
    message.channelId === channel.channelId && channel.participants.includes(message.fromRole)
      ? [entryOf(task.taskId, message)]
      : [],
  );
}

function entryOf(taskId: string, message: Message): ChannelContextEntry {
  const content = projectedPayload(message);
  return {
    ref: { taskId, msgId: message.msgId },
    fromRole: message.fromRole,
    type: message.type,
    ...(content === undefined ? {} : { content }),
  };
}

function projectedPayload(message: Message): Record<string, unknown> | undefined {
  const kind = message.payload.kind;
  if (message.type === 'announce') {
    if (kind === 'sub_channel_opened') {
      return picked(message.payload, ['kind', 'channelId', 'threadId', 'topic', 'participants']);
    }
    if (kind === 'sub_channel_closed') {
      return picked(message.payload, ['kind', 'channelId', 'threadId']);
    }
    if (kind === 'channel_summary') {
      return picked(message.payload, ['kind', 'channelId', 'threadId', 'summary']);
    }
    return picked(message.payload, ['nextRole', 'reason', 'sourceMsgId']);
  }
  if (message.type === 'feedback') {
    return picked(message.payload, [
      'reason',
      'failureStreak',
      'failed',
      'total',
      'issueScope',
      'summary',
      'comments',
      'degraded',
      'degradedReason',
    ]);
  }
  if (message.type === 'escalation') {
    return picked(message.payload, ['reason', 'iterationCount', 'limit']);
  }
  if (message.type === 'handoff') {
    return picked(message.payload, ['kind', 'fromRole', 'toRole', 'summary', 'artifacts', 'risks']);
  }
  if (message.type === 'question' || message.type === 'objection') {
    return picked(message.payload, ['kind', 'question', 'reason', 'blocking', 'sourceMsgId']);
  }
  if (message.type === 'chat' && kind === 'leader_intent') {
    return picked(message.payload, ['kind', 'intent', 'action']);
  }
  return undefined;
}

function picked(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (payload[key] !== undefined) result[key] = structuredClone(payload[key]);
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function withinBudget(
  candidates: readonly ChannelContextEntry[],
  budget: number,
): { entries: ChannelContextEntry[]; omittedRefs: MessageRef[] } {
  const retained: ChannelContextEntry[] = [];
  let used = 2;
  let boundary = candidates.length;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const cost = JSON.stringify(candidate).length + (retained.length === 0 ? 0 : 1);
    if (used + cost > budget) {
      boundary = index + 1;
      break;
    }
    retained.unshift(structuredClone(candidate));
    used += cost;
    boundary = index;
  }
  return {
    entries: retained,
    omittedRefs: candidates.slice(0, boundary).map((entry) => ({ ...entry.ref })),
  };
}
