import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type AppState, applyMutations, type Mutation } from '@agora/core-domain';

import type { TaskScope, TaskStateCommit, TaskStateStore } from './base';

const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class JsonTaskStateStore implements TaskStateStore {
  readonly #root: string;
  readonly #queues = new Map<string, Promise<void>>();
  #temporaryFileSequence = 0;

  constructor(root: string) {
    this.#root = root;
  }

  async initialize(scope: TaskScope, initial: AppState): Promise<AppState> {
    this.#validateScope(scope);
    this.#assertStateMatchesScope(scope, initial);

    return this.#enqueue(scope, async () => {
      const existing = await this.#loadSnapshot(scope);
      if (existing !== undefined) return existing;
      await this.#writeSnapshot(scope, initial);
      return initial;
    });
  }

  async load(scope: TaskScope): Promise<AppState | undefined> {
    this.#validateScope(scope);
    const pending = this.#queues.get(this.#scopeKey(scope));
    if (pending !== undefined) await pending;
    return this.#loadSnapshot(scope);
  }

  async commit(scope: TaskScope, mutations: readonly Mutation[]): Promise<TaskStateCommit> {
    this.#validateScope(scope);

    return this.#enqueue(scope, async () => {
      const current = await this.#loadSnapshot(scope);
      if (current === undefined) {
        throw new Error(
          `task state is not initialized for projectId "${scope.projectId}" and taskId "${scope.taskId}"`,
        );
      }

      const state = applyMutations(current, mutations);
      const changed = JSON.stringify(state) !== JSON.stringify(current);
      if (changed) await this.#writeSnapshot(scope, state);
      return { state, changed };
    });
  }

  async #enqueue<T>(scope: TaskScope, operation: () => Promise<T>): Promise<T> {
    const key = this.#scopeKey(scope);
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

  async #loadSnapshot(scope: TaskScope): Promise<AppState | undefined> {
    const path = this.#snapshotPath(scope);
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new Error(`invalid task state JSON at "${path}"`, { cause: error });
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`invalid task state JSON at "${path}": expected an object`);
    }
    const record = parsed as Record<string, unknown>;
    const hasObjections = Object.hasOwn(record, 'objections');
    const hasWorkers = Object.hasOwn(record, 'workers');
    if (hasObjections && !Array.isArray(record.objections)) {
      throw new Error(`invalid task state JSON at "${path}": objections must be an array`);
    }
    if (hasWorkers && !Array.isArray(record.workers)) {
      throw new Error(`invalid task state JSON at "${path}": workers must be an array`);
    }
    const state = {
      ...record,
      ...(hasObjections ? {} : { objections: [] }),
      ...(hasWorkers ? {} : { workers: [] }),
    } as unknown as AppState;
    this.#assertStateMatchesScope(scope, state);
    return state;
  }

  async #writeSnapshot(scope: TaskScope, state: AppState): Promise<void> {
    this.#assertStateMatchesScope(scope, state);
    const path = this.#snapshotPath(scope);
    await mkdir(dirname(path), { recursive: true });
    this.#temporaryFileSequence += 1;
    const temporaryPath = `${path}.${process.pid}.${this.#temporaryFileSequence}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #snapshotPath(scope: TaskScope): string {
    return join(this.#root, 'projects', scope.projectId, 'tasks', scope.taskId, 'state.json');
  }

  #scopeKey(scope: TaskScope): string {
    return `${scope.projectId}\u0000${scope.taskId}`;
  }

  #validateScope(scope: TaskScope): void {
    assertSafeScopeSegment('projectId', scope.projectId);
    assertSafeScopeSegment('taskId', scope.taskId);
  }

  #assertStateMatchesScope(scope: TaskScope, state: AppState): void {
    if (state.projectId !== scope.projectId || state.taskId !== scope.taskId) {
      throw new Error(
        `task state identity does not match scope: expected ${scope.projectId}/${scope.taskId}, received ${state.projectId}/${state.taskId}`,
      );
    }
  }
}

function assertSafeScopeSegment(field: keyof TaskScope, value: string): void {
  if (!SAFE_SCOPE_SEGMENT.test(value)) {
    throw new Error(`${field} must be a safe non-empty path segment`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
