import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  assertValidChannelRegistry,
  type Channel,
  normalizeChannelParticipants,
  type RoleId,
} from '@agora/core-domain';

import type { ProjectChannelCommit, ProjectChannelSnapshot, ProjectChannelStore } from './base';

const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class JsonProjectChannelStore implements ProjectChannelStore {
  readonly #root: string;
  readonly #enabledRoles: readonly RoleId[];
  readonly #queues = new Map<string, Promise<void>>();
  #temporaryFileSequence = 0;

  constructor(root: string, enabledRoles: readonly RoleId[]) {
    this.#root = root;
    this.#enabledRoles = [...enabledRoles];
  }

  async initialize(
    projectId: string,
    initial: readonly Channel[],
  ): Promise<ProjectChannelSnapshot> {
    this.#validateProjectId(projectId);
    this.#validateChannels(initial);
    const normalizedInitial = normalizeChannelParticipants(initial, this.#enabledRoles);

    return this.#enqueue(projectId, async () => {
      const existing = await this.#loadSnapshot(projectId);
      if (existing !== undefined) return cloneSnapshot(existing);

      const snapshot: ProjectChannelSnapshot = {
        projectId,
        revision: 0,
        channels: cloneChannels(normalizedInitial),
      };
      await this.#writeSnapshot(snapshot);
      return cloneSnapshot(snapshot);
    });
  }

  async load(projectId: string): Promise<ProjectChannelSnapshot | undefined> {
    this.#validateProjectId(projectId);
    return this.#enqueue(projectId, async () => {
      const snapshot = await this.#loadSnapshot(projectId);
      return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
    });
  }

  /** Read-only bridge for the 6.3 cross-store legacy-summary migration. */
  async legacyBubbledSummaries(projectId: string): Promise<LegacyBubbledSummary[]> {
    this.#validateProjectId(projectId);
    return this.#enqueue(projectId, async () => {
      const snapshot = await this.#readSnapshot(projectId);
      if (snapshot === undefined) return [];
      const migration = migrateLegacySubChannels(snapshot.channels);
      this.#validateChannels(migration.channels);
      return structuredClone(migration.legacySummaries);
    });
  }

  async commit(
    projectId: string,
    expectedRevision: number,
    channels: readonly Channel[],
  ): Promise<ProjectChannelCommit> {
    this.#validateProjectId(projectId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative integer');
    }
    this.#validateChannels(channels);
    const normalizedChannels = normalizeChannelParticipants(channels, this.#enabledRoles);

    return this.#enqueue(projectId, async () => {
      const current = await this.#loadSnapshot(projectId);
      if (current === undefined) {
        throw new Error(`project channel store is not initialized for projectId "${projectId}"`);
      }
      if (current.revision !== expectedRevision) {
        throw new Error(
          `project channel commit expected revision ${expectedRevision} but found ${current.revision}`,
        );
      }

      const raw = await this.#readSnapshot(projectId);
      const legacySummaries = migrateLegacySubChannels(raw?.channels).legacySummaries;
      for (const legacy of legacySummaries) {
        const candidate = normalizedChannels.find(
          (channel) => channel.kind === 'sub' && channel.channelId === legacy.channelId,
        );
        if (
          candidate?.kind !== 'sub' ||
          candidate.bubbledSummaryRef?.taskId !== legacy.taskId ||
          candidate.bubbledSummaryRef.msgId !== `channel-bubble:${legacy.channelId}`
        ) {
          throw new Error(
            `legacy bubbledSummary for channel "${legacy.channelId}" must be migrated before commit`,
          );
        }
      }

      if (canonicalJson(current.channels) === canonicalJson(normalizedChannels)) {
        return { snapshot: cloneSnapshot(current), changed: false };
      }

      const snapshot: ProjectChannelSnapshot = {
        projectId,
        revision: current.revision + 1,
        channels: cloneChannels(normalizedChannels),
      };
      await this.#writeSnapshot(snapshot);
      return { snapshot: cloneSnapshot(snapshot), changed: true };
    });
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

  async #loadSnapshot(projectId: string): Promise<ProjectChannelSnapshot | undefined> {
    const parsed = await this.#readSnapshot(projectId);
    if (parsed === undefined) return undefined;
    let snapshot = parsed;
    const migration = migrateLegacySubChannels(snapshot.channels);
    let normalizedChannels: Channel[];
    try {
      this.#validateChannels(migration.channels);
      normalizedChannels = normalizeChannelParticipants(migration.channels, this.#enabledRoles);
    } catch (error) {
      throw new Error(
        `invalid project channel JSON at "${this.#snapshotPath(projectId)}": invalid channel registry`,
        { cause: error },
      );
    }
    if (
      migration.legacySummaries.length === 0 &&
      (migration.changed || canonicalJson(snapshot.channels) !== canonicalJson(normalizedChannels))
    ) {
      snapshot = {
        projectId,
        revision: snapshot.revision + 1,
        channels: normalizedChannels,
      };
      await this.#writeSnapshot(snapshot);
    } else {
      snapshot = { projectId, revision: snapshot.revision, channels: normalizedChannels };
    }
    return snapshot;
  }

  async #readSnapshot(projectId: string): Promise<ProjectChannelSnapshot | undefined> {
    const path = this.#snapshotPath(projectId);
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }

    let snapshot: ProjectChannelSnapshot;
    try {
      snapshot = JSON.parse(contents) as ProjectChannelSnapshot;
    } catch (error) {
      throw new Error(`invalid project channel JSON at "${path}"`, { cause: error });
    }

    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      throw new Error(`invalid project channel JSON at "${path}": expected an object`);
    }
    if (snapshot.projectId !== projectId) {
      throw new Error(
        `project channel snapshot identity mismatch: expected "${projectId}", received "${snapshot.projectId}"`,
      );
    }
    if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new Error(`invalid project channel JSON at "${path}": invalid revision`);
    }
    return snapshot;
  }

  async #writeSnapshot(snapshot: ProjectChannelSnapshot): Promise<void> {
    const path = this.#snapshotPath(snapshot.projectId);
    await mkdir(dirname(path), { recursive: true });
    this.#temporaryFileSequence += 1;
    const temporaryPath = `${path}.${process.pid}.${this.#temporaryFileSequence}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #snapshotPath(projectId: string): string {
    return join(this.#root, 'projects', projectId, 'channels.json');
  }

  #validateProjectId(projectId: string): void {
    if (!SAFE_PROJECT_ID.test(projectId)) {
      throw new Error('projectId must be a safe non-empty path segment');
    }
  }

  #validateChannels(channels: unknown): asserts channels is readonly Channel[] {
    assertValidChannelRegistry(channels, this.#enabledRoles);
  }
}

function migrateLegacySubChannels(channels: unknown): {
  channels: unknown;
  changed: boolean;
  legacySummaries: LegacyBubbledSummary[];
} {
  if (!Array.isArray(channels)) return { channels, changed: false, legacySummaries: [] };

  let changed = false;
  const legacySummaries: LegacyBubbledSummary[] = [];
  const migrated = structuredClone(channels) as unknown[];
  for (const value of migrated) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const channel = value as Record<string, unknown>;
    if (channel.localContext !== undefined) {
      validateLegacyLocalContext(channel);
      delete channel.localContext;
      changed = true;
    }
    if (channel.kind !== 'sub') {
      if (channel.bubbledSummary !== undefined) {
        throw new Error('main channel must not declare bubbledSummary');
      }
      continue;
    }
    if (channel.bubbledSummary !== undefined && typeof channel.bubbledSummary !== 'string') {
      throw new Error(`channel "${String(channel.channelId)}" bubbledSummary must be a string`);
    }

    const fields = ['threadId', 'topic', 'createdBy'] as const;
    const presentCount = fields.filter((field) => field in channel).length;
    if (presentCount === 0) {
      if (typeof channel.channelId !== 'string') continue;
      channel.threadId = `legacy-${channel.channelId}`;
      channel.topic = `Legacy channel ${channel.channelId}`;
      channel.createdBy = 'leader';
      changed = true;
    } else if (presentCount !== fields.length) {
      throw new Error('partial sub-channel lifecycle metadata');
    }
    if (typeof channel.bubbledSummary === 'string') {
      if (
        typeof channel.channelId !== 'string' ||
        typeof channel.taskId !== 'string' ||
        typeof channel.threadId !== 'string'
      ) {
        throw new Error('legacy bubbledSummary requires complete channel identity');
      }
      if (channel.closed !== true) {
        throw new Error('legacy bubbledSummary requires a closed sub-channel');
      }
      legacySummaries.push({
        channelId: channel.channelId,
        taskId: channel.taskId,
        threadId: channel.threadId,
        summary: channel.bubbledSummary,
      });
      delete channel.bubbledSummary;
      changed = true;
    }
  }

  return { channels: migrated, changed, legacySummaries };
}

function validateLegacyLocalContext(channel: Record<string, unknown>): void {
  if (!Array.isArray(channel.localContext)) {
    throw new Error('legacy localContext must be an array');
  }
  for (const value of channel.localContext) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('legacy localContext entries must be objects');
    }
    const reference = value as Record<string, unknown>;
    if (
      Object.keys(reference).length !== 2 ||
      !Object.hasOwn(reference, 'taskId') ||
      !Object.hasOwn(reference, 'msgId')
    ) {
      throw new Error('legacy localContext entries must contain only taskId and msgId');
    }
    if (typeof reference.taskId !== 'string' || !SAFE_PROJECT_ID.test(reference.taskId)) {
      throw new Error('legacy localContext taskId must be a safe non-empty segment');
    }
    if (typeof reference.msgId !== 'string' || reference.msgId.length === 0) {
      throw new Error('legacy localContext msgId must be a non-empty string');
    }
    if (
      channel.kind === 'sub' &&
      typeof channel.taskId === 'string' &&
      reference.taskId !== channel.taskId
    ) {
      throw new Error('legacy sub channel localContext taskId must match channel taskId');
    }
  }
}

export interface LegacyBubbledSummary {
  channelId: string;
  taskId: string;
  threadId: string;
  summary: string;
}

function cloneSnapshot(snapshot: ProjectChannelSnapshot): ProjectChannelSnapshot {
  return {
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    channels: cloneChannels(snapshot.channels),
  };
}

function cloneChannels(channels: readonly Channel[]): Channel[] {
  return structuredClone([...channels]);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
