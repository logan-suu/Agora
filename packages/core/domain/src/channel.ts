import type { RoleId } from './state';

const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ParticipantId = 'leader' | RoleId;

export interface MessageRef {
  taskId: string;
  msgId: string;
}

interface ChannelBase {
  channelId: string;
  participants: ParticipantId[];
  localContext: MessageRef[];
  closed: boolean;
  bubbledSummary?: string;
}

export interface MainChannel extends ChannelBase {
  channelId: 'main';
  kind: 'main';
  taskId?: never;
}

export interface SubChannel extends ChannelBase {
  kind: 'sub';
  taskId: string;
}

export type Channel = MainChannel | SubChannel;

export function createMainChannel(enabledRoles: readonly RoleId[]): MainChannel {
  return {
    channelId: 'main',
    kind: 'main',
    participants: ['leader', ...enabledRoles],
    localContext: [],
    closed: false,
  };
}

export function assertValidChannelRegistry(
  channels: unknown,
  enabledRoles: readonly RoleId[],
): asserts channels is readonly Channel[] {
  if (!Array.isArray(channels)) throw new Error('channels must be an array');

  const enabled = new Set<string>(enabledRoles);
  if (enabled.size !== enabledRoles.length) {
    throw new Error('enabled roster roles must be unique');
  }

  const channelIds = new Set<string>();
  let mainCount = 0;

  for (const value of channels) {
    const channel = channelRecord(value);
    const channelId = requiredSafeSegment(channel.channelId, 'channelId');
    if (channelIds.has(channelId)) throw new Error('channelId must be unique within project');
    channelIds.add(channelId);

    if (channel.kind !== 'main' && channel.kind !== 'sub') {
      throw new Error(`channel "${channelId}" kind must be "main" or "sub"`);
    }
    if (typeof channel.closed !== 'boolean') {
      throw new Error(`channel "${channelId}" closed must be boolean`);
    }
    if (channel.bubbledSummary !== undefined && typeof channel.bubbledSummary !== 'string') {
      throw new Error(`channel "${channelId}" bubbledSummary must be a string`);
    }

    const participants = stringArray(channel.participants, `channel "${channelId}" participants`);
    assertUnique(participants, `channel "${channelId}" participants`);
    if (!participants.includes('leader')) {
      throw new Error(`channel "${channelId}" must include leader`);
    }

    const subTaskId =
      channel.kind === 'sub'
        ? requiredSafeSegment(channel.taskId, 'sub channel taskId')
        : undefined;

    const localContext = arrayValue(channel.localContext, `channel "${channelId}" localContext`);
    for (const reference of localContext) {
      const record = channelRecord(reference);
      const taskId = requiredSafeSegment(record.taskId, 'localContext taskId');
      requiredNonEmptyString(record.msgId, 'localContext msgId');
      if (subTaskId !== undefined && taskId !== subTaskId) {
        throw new Error(`sub channel "${channelId}" localContext taskId must match channel taskId`);
      }
    }

    if (channel.kind === 'main') {
      mainCount += 1;
      if (channelId !== 'main') throw new Error('main channelId must be "main"');
      if ('taskId' in channel) throw new Error('main channel must not declare taskId');
      if (channel.closed) throw new Error('main channel must remain open');
      if (!sameStringSet(participants, ['leader', ...enabledRoles])) {
        throw new Error('main channel participants must equal leader plus enabled roster');
      }
      continue;
    }

    const agentParticipants = participants.filter((participant) => participant !== 'leader');
    if (agentParticipants.length === 0) {
      throw new Error(`sub channel "${channelId}" must include at least one enabled role`);
    }
    for (const participant of agentParticipants) {
      if (!enabled.has(participant)) {
        throw new Error(`sub channel "${channelId}" participant "${participant}" is not enabled`);
      }
    }
  }

  if (mainCount !== 1) throw new Error('channel registry must contain exactly one main channel');
}

function channelRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('channel registry entries must be objects');
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  const values = arrayValue(value, field);
  if (!values.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    throw new Error(`${field} must contain non-empty strings`);
  }
  return values as string[];
}

function requiredSafeSegment(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_SCOPE_SEGMENT.test(value)) {
    throw new Error(`${field} must be a safe non-empty segment`);
  }
  return value;
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}
