import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  assertValidChannelRegistry,
  assertValidRoster,
  type Channel,
  normalizeChannelParticipants,
  type RosterEntry,
} from '@agora/core-domain';

import type {
  ProjectCollaborationCommit,
  ProjectCollaborationSnapshot,
  ProjectCollaborationStore,
} from './base';
import { type LegacyBubbledSummary, migrateLegacySubChannels } from './legacy-channel-migration';

const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface LegacyProjectChannelSnapshot {
  projectId: string;
  revision: number;
  channels: Channel[];
  legacySummaries: LegacyBubbledSummary[];
  changed: boolean;
}

export class JsonProjectCollaborationStore implements ProjectCollaborationStore {
  readonly #root: string;
  readonly #queues = new Map<string, Promise<void>>();
  #temporaryFileSequence = 0;

  constructor(root: string) {
    this.#root = root;
  }

  async initialize(
    projectId: string,
    initialRoster: readonly RosterEntry[],
    initialChannels: readonly Channel[],
  ): Promise<ProjectCollaborationSnapshot> {
    this.#validateProjectId(projectId);
    const normalized = normalizeSnapshot(projectId, 0, initialRoster, initialChannels);
    return this.#enqueue(projectId, async () => {
      const existing = await this.#loadSnapshot(projectId);
      if (existing !== undefined) return cloneSnapshot(existing);

      const legacy = await this.#readLegacySnapshot(projectId);
      const snapshot =
        legacy === undefined
          ? normalized
          : normalizeSnapshot(
              projectId,
              legacy.revision + (legacy.changed ? 1 : 0),
              initialRoster,
              legacy.channels,
            );
      await this.#writeSnapshot(snapshot);
      const verified = await this.#readSnapshot(projectId);
      if (verified === undefined || canonicalJson(verified) !== canonicalJson(snapshot)) {
        throw new Error(
          `project collaboration write verification failed for project "${projectId}"`,
        );
      }
      if (legacy !== undefined) {
        if (legacy.legacySummaries.length > 0) {
          await this.#writeLegacySummaries(projectId, legacy.legacySummaries);
        }
        await rm(this.#legacyPath(projectId));
      }
      return cloneSnapshot(snapshot);
    });
  }

  async legacyBubbledSummaries(projectId: string): Promise<LegacyBubbledSummary[]> {
    this.#validateProjectId(projectId);
    return this.#enqueue(projectId, async () => {
      const persisted = await readJson(this.#legacySummariesPath(projectId), 'legacy summary');
      if (persisted !== undefined) return structuredClone(persisted as LegacyBubbledSummary[]);
      const legacy = await this.#readLegacySnapshot(projectId);
      return structuredClone(legacy?.legacySummaries ?? []);
    });
  }

  async acknowledgeLegacyBubbledSummary(projectId: string, channelId: string): Promise<void> {
    this.#validateProjectId(projectId);
    await this.#enqueue(projectId, async () => {
      const path = this.#legacySummariesPath(projectId);
      const persisted = await readJson(path, 'legacy summary');
      if (persisted === undefined) return;
      if (!Array.isArray(persisted)) throw new Error(`invalid legacy summary JSON at "${path}"`);
      const remaining = (persisted as LegacyBubbledSummary[]).filter(
        (entry) => entry.channelId !== channelId,
      );
      if (remaining.length === persisted.length) return;
      if (remaining.length === 0) {
        await rm(path);
      } else {
        await this.#writeLegacySummaries(projectId, remaining);
      }
    });
  }

  async load(projectId: string): Promise<ProjectCollaborationSnapshot | undefined> {
    this.#validateProjectId(projectId);
    return this.#enqueue(projectId, async () => {
      const snapshot = await this.#loadSnapshot(projectId);
      return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
    });
  }

  async commit(
    projectId: string,
    expectedRevision: number,
    next: { roster: readonly RosterEntry[]; channels: readonly Channel[] },
  ): Promise<ProjectCollaborationCommit> {
    this.#validateProjectId(projectId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative integer');
    }
    const normalizedNext = normalizeSnapshot(
      projectId,
      expectedRevision,
      next.roster,
      next.channels,
    );

    return this.#enqueue(projectId, async () => {
      const current = await this.#loadSnapshot(projectId);
      if (current === undefined) {
        throw new Error(
          `project collaboration store is not initialized for projectId "${projectId}"`,
        );
      }
      if (current.revision !== expectedRevision) {
        throw new Error(
          `project collaboration commit expected revision ${expectedRevision} but found ${current.revision}`,
        );
      }
      if (
        canonicalJson(current.roster) === canonicalJson(normalizedNext.roster) &&
        canonicalJson(current.channels) === canonicalJson(normalizedNext.channels)
      ) {
        return { snapshot: cloneSnapshot(current), changed: false };
      }

      const snapshot = { ...normalizedNext, revision: current.revision + 1 };
      await this.#writeSnapshot(snapshot);
      return { snapshot: cloneSnapshot(snapshot), changed: true };
    });
  }

  async #loadSnapshot(projectId: string): Promise<ProjectCollaborationSnapshot | undefined> {
    const collaboration = await this.#readSnapshot(projectId);
    if (collaboration === undefined) return undefined;
    const legacy = await this.#readLegacySnapshot(projectId);
    if (legacy !== undefined) {
      const same =
        legacy.revision + (legacy.changed ? 1 : 0) === collaboration.revision &&
        canonicalJson(legacy.channels) === canonicalJson(collaboration.channels);
      if (!same) {
        throw new Error(
          `conflicting collaboration.json and channels.json for project "${projectId}"`,
        );
      }
      if (legacy.legacySummaries.length > 0) {
        await this.#writeLegacySummaries(projectId, legacy.legacySummaries);
      }
      await rm(this.#legacyPath(projectId));
    }
    return collaboration;
  }

  async #readSnapshot(projectId: string): Promise<ProjectCollaborationSnapshot | undefined> {
    const path = this.#snapshotPath(projectId);
    const value = await readJson(path, 'project collaboration');
    if (value === undefined) return undefined;
    const record = assertSnapshotIdentity(value, projectId, path, 'project collaboration');
    if (!Object.hasOwn(record, 'roster') || !Object.hasOwn(record, 'channels')) {
      throw new Error(
        `invalid project collaboration JSON at "${path}": missing roster or channels`,
      );
    }
    try {
      return normalizeSnapshot(
        projectId,
        record.revision as number,
        record.roster as RosterEntry[],
        record.channels as Channel[],
      );
    } catch (error) {
      throw new Error(`invalid project collaboration JSON at "${path}": invariant failure`, {
        cause: error,
      });
    }
  }

  async #readLegacySnapshot(projectId: string): Promise<LegacyProjectChannelSnapshot | undefined> {
    const path = this.#legacyPath(projectId);
    const value = await readJson(path, 'project channel');
    if (value === undefined) return undefined;
    const record = assertSnapshotIdentity(value, projectId, path, 'project channel');
    if (!Object.hasOwn(record, 'channels')) {
      throw new Error(`invalid project channel JSON at "${path}": missing channels`);
    }
    const migration = migrateLegacySubChannels(record.channels);
    return {
      projectId,
      revision: record.revision as number,
      channels: structuredClone(migration.channels as Channel[]),
      legacySummaries: migration.legacySummaries,
      changed: migration.changed,
    };
  }

  async #writeLegacySummaries(
    projectId: string,
    summaries: readonly LegacyBubbledSummary[],
  ): Promise<void> {
    const path = this.#legacySummariesPath(projectId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(summaries, null, 2)}\n`, 'utf8');
  }

  async #writeSnapshot(snapshot: ProjectCollaborationSnapshot): Promise<void> {
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
    return join(this.#root, 'projects', projectId, 'collaboration.json');
  }

  #legacyPath(projectId: string): string {
    return join(this.#root, 'projects', projectId, 'channels.json');
  }

  #legacySummariesPath(projectId: string): string {
    return join(this.#root, 'projects', projectId, 'legacy-channel-summaries.json');
  }

  #validateProjectId(projectId: string): void {
    if (!SAFE_PROJECT_ID.test(projectId)) {
      throw new Error('projectId must be a safe non-empty path segment');
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

function normalizeSnapshot(
  projectId: string,
  revision: number,
  roster: readonly RosterEntry[],
  channels: readonly Channel[],
): ProjectCollaborationSnapshot {
  if (!Number.isInteger(revision) || revision < 0) throw new Error('revision must be non-negative');
  assertValidRoster(roster);
  assertValidChannelRegistry(channels, roster);
  return {
    projectId,
    revision,
    roster: structuredClone([...roster]),
    channels: normalizeChannelParticipants(channels, roster),
  };
}

async function readJson(path: string, label: string): Promise<unknown | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`invalid ${label} JSON at "${path}"`, { cause: error });
  }
}

function assertSnapshotIdentity(
  value: unknown,
  projectId: string,
  path: string,
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label} JSON at "${path}": expected an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.projectId !== projectId) {
    throw new Error(`${label} snapshot identity mismatch: expected "${projectId}"`);
  }
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) {
    throw new Error(`invalid ${label} JSON at "${path}": invalid revision`);
  }
  return record;
}

function cloneSnapshot(snapshot: ProjectCollaborationSnapshot): ProjectCollaborationSnapshot {
  return structuredClone(snapshot);
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
