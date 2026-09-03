import type { RoleId, RosterEntry } from './state';

const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ParticipantId = 'leader' | RoleId;

export interface MessageRef {
  taskId: string;
  msgId: string;
}

interface ChannelBase {
  channelId: string;
  participants: ParticipantId[];
  closed: boolean;
}

export interface MainChannel extends ChannelBase {
  channelId: 'main';
  kind: 'main';
  taskId?: never;
}

export interface SubChannel extends ChannelBase {
  kind: 'sub';
  taskId: string;
  threadId: string;
  topic: string;
  createdBy: ParticipantId;
  bubbledSummaryRef?: MessageRef;
}

export type Channel = MainChannel | SubChannel;

export function createMainChannel(enabledRoles: readonly RoleId[]): MainChannel {
  assertValidEnabledRoster(enabledRoles);
  return {
    channelId: 'main',
    kind: 'main',
    participants: ['leader', ...enabledRoles],
    closed: false,
  };
}

export function normalizeChannelParticipants(
  channels: readonly Channel[],
  roster: readonly RoleId[] | readonly RosterEntry[],
): Channel[] {
  assertValidChannelRegistry(channels, roster);
  const knownRoles = rosterRoleIds(roster);
  const participantOrder = new Map<string, number>([
    ['leader', 0],
    ...knownRoles.map((role, index) => [role, index + 1] as const),
  ]);

  return channels.map((channel) => ({
    ...structuredClone(channel),
    participants: [...channel.participants].sort(
      (left, right) =>
        (participantOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (participantOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  }));
}

export function assertValidChannelRegistry(
  channels: unknown,
  roster: readonly RoleId[] | readonly RosterEntry[],
): asserts channels is readonly Channel[] {
  if (!Array.isArray(channels)) throw new Error('channels must be an array');

  const knownRoles = rosterRoleIds(roster);
  const enabledRoles = enabledRoleIds(roster);
  assertValidEnabledRoster(enabledRoles);
  const known = new Set<string>(knownRoles);

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
    if ('localContext' in channel || 'bubbledSummary' in channel) {
      throw new Error(`channel "${channelId}" contains a retired derived field`);
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

    if (channel.kind === 'main') {
      mainCount += 1;
      if (channelId !== 'main') throw new Error('main channelId must be "main"');
      if ('taskId' in channel) throw new Error('main channel must not declare taskId');
      if ('bubbledSummaryRef' in channel) {
        throw new Error('main channel must not declare bubbledSummaryRef');
      }
      if (channel.closed) throw new Error('main channel must remain open');
      if (!sameStringSet(participants, ['leader', ...enabledRoles])) {
        throw new Error('main channel participants must equal leader plus enabled roster');
      }
      continue;
    }

    const agentParticipants = participants.filter((participant) => participant !== 'leader');
    if (agentParticipants.length === 0) {
      throw new Error(`sub channel "${channelId}" must include at least one known role`);
    }
    for (const participant of agentParticipants) {
      if (!known.has(participant)) {
        throw new Error(`sub channel "${channelId}" participant "${participant}" is not known`);
      }
    }

    requiredSafeSegment(channel.threadId, 'sub channel threadId');
    requiredNonEmptyString(channel.topic, 'sub channel topic');
    const createdBy = requiredNonEmptyString(channel.createdBy, 'sub channel createdBy');
    if (createdBy !== 'leader' && !known.has(createdBy)) {
      throw new Error(`sub channel "${channelId}" createdBy "${createdBy}" is not known`);
    }
    if (!participants.includes(createdBy)) {
      throw new Error(`sub channel "${channelId}" must include creator "${createdBy}"`);
    }
    if (channel.bubbledSummaryRef !== undefined) {
      const reference = channelRecord(channel.bubbledSummaryRef);
      const taskId = requiredSafeSegment(reference.taskId, 'bubbledSummaryRef taskId');
      const msgId = requiredNonEmptyString(reference.msgId, 'bubbledSummaryRef msgId');
      if (!channel.closed) {
        throw new Error(`sub channel "${channelId}" must be closed before summary is referenced`);
      }
      if (taskId !== subTaskId) {
        throw new Error(
          `sub channel "${channelId}" bubbledSummaryRef taskId must match channel taskId`,
        );
      }
      if (msgId !== `channel-bubble:${channelId}`) {
        throw new Error(`sub channel "${channelId}" bubbledSummaryRef msgId must be stable`);
      }
    }
  }

  if (mainCount !== 1) throw new Error('channel registry must contain exactly one main channel');
}

function rosterRoleIds(roster: readonly RoleId[] | readonly RosterEntry[]): RoleId[] {
  return roster.map((entry) => (typeof entry === 'string' ? entry : entry.spec.role));
}

function enabledRoleIds(roster: readonly RoleId[] | readonly RosterEntry[]): RoleId[] {
  return roster.flatMap((entry) =>
    typeof entry === 'string' || entry.status === 'enabled'
      ? [typeof entry === 'string' ? entry : entry.spec.role]
      : [],
  );
}

function assertValidEnabledRoster(enabledRoles: readonly RoleId[]): void {
  if (!enabledRoles.every((role) => typeof role === 'string' && role.length > 0)) {
    throw new Error('enabled roster roles must be non-empty strings');
  }
  if (new Set(enabledRoles).size !== enabledRoles.length) {
    throw new Error('enabled roster roles must be unique');
  }
  if ((enabledRoles as readonly string[]).includes('leader')) {
    throw new Error('enabled roster roles must not use reserved participant "leader"');
  }
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
