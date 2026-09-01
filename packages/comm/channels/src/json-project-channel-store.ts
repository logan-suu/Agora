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
    const migration = migrateLegacySubChannels(snapshot.channels);
    let normalizedChannels: Channel[];
    try {
      this.#validateChannels(migration.channels);
      normalizedChannels = normalizeChannelParticipants(migration.channels, this.#enabledRoles);
    } catch (error) {
      throw new Error(`invalid project channel JSON at "${path}": invalid channel registry`, {
        cause: error,
      });
    }
    if (
      migration.changed ||
      canonicalJson(snapshot.channels) !== canonicalJson(normalizedChannels)
    ) {
      snapshot = {
        projectId,
        revision: snapshot.revision + 1,
        channels: normalizedChannels,
      };
      await this.#writeSnapshot(snapshot);
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

function migrateLegacySubChannels(channels: unknown): { channels: unknown; changed: boolean } {
  if (!Array.isArray(channels)) return { channels, changed: false };

  let changed = false;
  const migrated = structuredClone(channels) as unknown[];
  for (const value of migrated) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const channel = value as Record<string, unknown>;
    if (channel.kind !== 'sub') continue;

    const fields = ['threadId', 'topic', 'createdBy'] as const;
    const presentCount = fields.filter((field) => field in channel).length;
    if (presentCount === 0) {
      if (typeof channel.channelId !== 'string') continue;
      channel.threadId = `legacy-${channel.channelId}`;
      channel.topic = `Legacy channel ${channel.channelId}`;
      channel.createdBy = 'leader';
      changed = true;
      continue;
    }
    if (presentCount !== fields.length) {
      throw new Error('partial sub-channel lifecycle metadata');
    }
  }

  return { channels: migrated, changed };
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
