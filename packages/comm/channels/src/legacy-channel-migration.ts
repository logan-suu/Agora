import type { Channel } from '@agora/core-domain';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface LegacyBubbledSummary {
  channelId: string;
  taskId: string;
  threadId: string;
  summary: string;
}

export function migrateLegacySubChannels(channels: unknown): {
  channels: unknown;
  changed: boolean;
  legacySummaries: LegacyBubbledSummary[];
} {
  if (!Array.isArray(channels)) return { channels, changed: false, legacySummaries: [] };
  let changed = false;
  const legacySummaries: LegacyBubbledSummary[] = [];
  const migrated = structuredClone(channels) as unknown[];
  for (const value of migrated) {
    if (!isRecord(value)) continue;
    if (value.localContext !== undefined) {
      validateLegacyLocalContext(value);
      delete value.localContext;
      changed = true;
    }
    if (value.kind !== 'sub') {
      if (value.bubbledSummary !== undefined) {
        throw new Error('main channel must not declare bubbledSummary');
      }
      continue;
    }
    if (value.bubbledSummary !== undefined && typeof value.bubbledSummary !== 'string') {
      throw new Error(`channel "${String(value.channelId)}" bubbledSummary must be a string`);
    }
    const fields = ['threadId', 'topic', 'createdBy'] as const;
    const present = fields.filter((field) => field in value).length;
    if (present === 0) {
      if (typeof value.channelId !== 'string') continue;
      value.threadId = `legacy-${value.channelId}`;
      value.topic = `Legacy channel ${value.channelId}`;
      value.createdBy = 'leader';
      changed = true;
    } else if (present !== fields.length) {
      throw new Error('partial sub-channel lifecycle metadata');
    }
    if (typeof value.bubbledSummary === 'string') {
      if (
        typeof value.channelId !== 'string' ||
        typeof value.taskId !== 'string' ||
        typeof value.threadId !== 'string' ||
        value.closed !== true
      ) {
        throw new Error('legacy bubbledSummary requires a closed channel with complete identity');
      }
      legacySummaries.push({
        channelId: value.channelId,
        taskId: value.taskId,
        threadId: value.threadId,
        summary: value.bubbledSummary,
      });
      delete value.bubbledSummary;
      changed = true;
    }
  }
  return { channels: migrated as Channel[], changed, legacySummaries };
}

function validateLegacyLocalContext(channel: Record<string, unknown>): void {
  if (!Array.isArray(channel.localContext)) throw new Error('legacy localContext must be an array');
  for (const value of channel.localContext) {
    if (!isRecord(value) || Object.keys(value).length !== 2) {
      throw new Error('legacy localContext entries must contain only taskId and msgId');
    }
    if (typeof value.taskId !== 'string' || !SAFE_SEGMENT.test(value.taskId)) {
      throw new Error('legacy localContext taskId must be a safe non-empty segment');
    }
    if (typeof value.msgId !== 'string' || value.msgId.length === 0) {
      throw new Error('legacy localContext msgId must be a non-empty string');
    }
    if (channel.kind === 'sub' && value.taskId !== channel.taskId) {
      throw new Error('legacy sub channel localContext taskId must match channel taskId');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
