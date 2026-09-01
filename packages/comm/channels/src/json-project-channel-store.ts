import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { assertValidChannelRegistry, type Channel, type RoleId } from '@agora/core-domain';

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

    return this.#enqueue(projectId, async () => {
      const existing = await this.#loadSnapshot(projectId);
      if (existing !== undefined) return cloneSnapshot(existing);

      const snapshot: ProjectChannelSnapshot = {
        projectId,
        revision: 0,
        channels: cloneChannels(initial),
      };
      await this.#writeSnapshot(snapshot);
      return cloneSnapshot(snapshot);
    });
  }

  async load(projectId: string): Promise<ProjectChannelSnapshot | undefined> {
    this.#validateProjectId(projectId);
    const pending = this.#queues.get(projectId);
    if (pending !== undefined) await pending;
    const snapshot = await this.#loadSnapshot(projectId);
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
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

      if (JSON.stringify(current.channels) === JSON.stringify(channels)) {
        return { snapshot: cloneSnapshot(current), changed: false };
      }

      const snapshot: ProjectChannelSnapshot = {
        projectId,
        revision: current.revision + 1,
        channels: cloneChannels(channels),
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
    try {
      this.#validateChannels(snapshot.channels);
    } catch (error) {
      throw new Error(`invalid project channel JSON at "${path}": invalid channel registry`, {
        cause: error,
      });
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
