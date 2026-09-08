import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { isGitObjectId, type WorktreeRef } from '@agora/core-domain';

import type {
  RecoverableSandboxManager,
  RecoverableWorktreeBinding,
} from './recoverable-sandbox-manager';
import type { IntegrationResult, RunResult, Worktree } from './types';

export interface WorkspaceGitCapability {
  canonicalHead(): Promise<string>;
  createWorktreeFrom(taskId: string, branch: string, baseCommit: string): Promise<Worktree>;
  registerExistingWorktree(
    path: string,
    expectedBranch?: string,
  ): Promise<{ path: string; branch: string; headCommit: string }>;
  headOf(path: string): Promise<string>;
  mergeInWorktree(
    path: string,
    branch: string,
  ): Promise<{ ok: boolean; conflicts?: string[]; headCommit?: string }>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  parentsOf(commit: string): Promise<readonly string[]>;
  retireWorktree(path: string, branch: string): Promise<void>;
  resetWorktree(path: string, commit: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkspaceExecutionBackend {
  bindWorktree(
    taskId: string,
    isolationKey: string,
    worktree: Worktree,
    taskRoot: string,
  ): Promise<void>;
  read(worktree: Worktree, path: string): Promise<string>;
  write(worktree: Worktree, path: string, content: string): Promise<void>;
  run(worktree: Worktree, cmd: string, timeout?: number): Promise<RunResult>;
  suspend(taskId: string): Promise<void>;
  teardown(taskId: string): Promise<void>;
}

export interface WorkspaceAdapterOptions {
  projectId: string;
  taskId: string;
  taskRoot: string;
  git: WorkspaceGitCapability;
  execution: WorkspaceExecutionBackend;
  encodeIsolationKey(projectId: string, taskId: string, isolationKey: string): string;
}

/** Single owner for task Git linked-worktrees and their matching execution mounts. */
export class WorkspaceAdapter implements RecoverableSandboxManager {
  readonly #projectId: string;
  readonly #taskId: string;
  readonly #taskRoot: string;
  readonly #git: WorkspaceGitCapability;
  readonly #execution: WorkspaceExecutionBackend;
  readonly #encodeIsolationKey: WorkspaceAdapterOptions['encodeIsolationKey'];
  readonly #byIsolationKey = new Map<string, WorktreeRef>();
  readonly #byBranch = new Map<string, WorktreeRef>();
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;
  #disposing: Promise<void> | undefined;

  constructor(options: WorkspaceAdapterOptions) {
    this.#projectId = options.projectId;
    this.#taskId = options.taskId;
    this.#taskRoot = resolve(options.taskRoot);
    this.#git = options.git;
    this.#execution = options.execution;
    this.#encodeIsolationKey = options.encodeIsolationKey;
  }

  async createWorktree(taskId: string, isolationKey: string): Promise<Worktree> {
    this.#assertTask(taskId);
    const ref = await this.createWorkerWorktree(isolationKey, await this.#git.canonicalHead());
    return { path: ref.path, branch: ref.branch };
  }

  /** Companion capability: bind an immutable worker identity to an explicit cumulative base. */
  async createWorkerWorktree(isolationKey: string, baseCommit: string): Promise<WorktreeRef> {
    if (!isGitObjectId(baseCommit)) throw new Error('worker base must be a full Git object id');
    return this.#enqueue(async () => {
      const existing = this.#byIsolationKey.get(isolationKey);
      if (existing !== undefined) {
        if (existing.baseCommit !== baseCommit)
          throw new Error('worker identity has a conflicting base commit');
        return this.refreshWorktree(existing);
      }
      const branch = this.#encodeIsolationKey(this.#projectId, this.#taskId, isolationKey);
      const worktree = await this.#git.createWorktreeFrom(this.#taskId, branch, baseCommit);
      try {
        this.#assertOwnedPath(worktree.path);
        const ref: WorktreeRef = { ...worktree, baseCommit, headCommit: baseCommit };
        await this.#execution.bindWorktree(this.#taskId, isolationKey, worktree, this.#taskRoot);
        this.#remember(isolationKey, ref);
        return structuredClone(ref);
      } catch (error) {
        await this.#git.retireWorktree(worktree.path, worktree.branch).catch((cleanupError) => {
          throw new AggregateError([error, cleanupError], 'worktree bind and compensation failed');
        });
        throw error;
      }
    });
  }

  async createIntegrationWorktree(
    waveId: string,
    integrationId: string,
    baseCommit: string,
  ): Promise<WorktreeRef> {
    const isolationKey = `integration:${integrationId}`;
    return this.#enqueue(async () => {
      const existing = this.#byIsolationKey.get(isolationKey);
      if (existing !== undefined) return structuredClone(existing);
      const digest = createHash('sha256')
        .update(`${this.#projectId}\u0000${this.#taskId}\u0000${waveId}\u0000${integrationId}`)
        .digest('hex')
        .slice(0, 16);
      const branch = `integration-${digest}`;
      const worktree = await this.#git.createWorktreeFrom(this.#taskId, branch, baseCommit);
      try {
        this.#assertOwnedPath(worktree.path);
        const ref: WorktreeRef = { ...worktree, baseCommit, headCommit: baseCommit };
        await this.#execution.bindWorktree(this.#taskId, isolationKey, worktree, this.#taskRoot);
        this.#remember(isolationKey, ref);
        return structuredClone(ref);
      } catch (error) {
        await this.#git.retireWorktree(worktree.path, worktree.branch).catch((cleanupError) => {
          throw new AggregateError(
            [error, cleanupError],
            'integration worktree bind and compensation failed',
          );
        });
        throw error;
      }
    });
  }

  async refreshWorktree(ref: WorktreeRef): Promise<WorktreeRef> {
    this.#assertKnown(ref);
    const headCommit = await this.#git.headOf(ref.path);
    return { ...ref, headCommit };
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.#git.isAncestor(ancestor, descendant);
  }

  async parentsOf(commit: string): Promise<readonly string[]> {
    return this.#git.parentsOf(commit);
  }

  async resetIntegration(ref: WorktreeRef, baseCommit: string): Promise<WorktreeRef> {
    this.#assertKnown(ref);
    await this.#git.resetWorktree(ref.path, baseCommit);
    return { ...ref, baseCommit, headCommit: baseCommit };
  }

  async read(worktree: Worktree, path: string): Promise<string> {
    this.#assertKnown(worktree);
    return this.#execution.read(worktree, path);
  }

  async write(worktree: Worktree, path: string, content: string): Promise<void> {
    this.#assertKnown(worktree);
    await this.#execution.write(worktree, path, content);
  }

  async run(worktree: Worktree, cmd: string, timeout?: number): Promise<RunResult> {
    this.#assertKnown(worktree);
    return this.#execution.run(worktree, cmd, timeout);
  }

  async integrate(base: string, branches: string[]): Promise<IntegrationResult> {
    const target = this.#byBranch.get(base);
    if (
      target === undefined ||
      ![...this.#byIsolationKey.keys()].some(
        (key) => key.startsWith('integration:') && this.#byIsolationKey.get(key)?.branch === base,
      )
    ) {
      throw new Error(`integration branch is not registered: ${base}`);
    }
    for (const branch of branches) {
      if (!this.#byBranch.has(branch))
        throw new Error(`worker branch is not registered: ${branch}`);
      const result = await this.#git.mergeInWorktree(target.path, branch);
      if (!result.ok) return { merged: false, conflicts: [...(result.conflicts ?? [])] };
    }
    return { merged: true, conflicts: [] };
  }

  async suspend(taskId: string): Promise<void> {
    this.#assertTask(taskId);
    await this.#execution.suspend(taskId);
  }

  async resume(taskId: string, bindings: readonly RecoverableWorktreeBinding[]): Promise<void> {
    this.#assertTask(taskId);
    if (bindings.length === 0) throw new Error('workspace resume requires worktree bindings');
    await this.#enqueue(async () => {
      for (const binding of bindings) {
        this.#assertOwnedPath(binding.worktree.path);
        const inspected = await this.#git.registerExistingWorktree(
          binding.worktree.path,
          binding.worktree.branch,
        );
        const ref: WorktreeRef = {
          path: inspected.path,
          branch: inspected.branch,
          baseCommit: inspected.headCommit,
          headCommit: inspected.headCommit,
        };
        await this.#execution.bindWorktree(taskId, binding.role, binding.worktree, this.#taskRoot);
        this.#remember(binding.role, ref);
      }
    });
  }

  async recoverWorktrees(
    bindings: readonly { isolationKey: string; worktree: WorktreeRef }[],
  ): Promise<void> {
    if (bindings.length === 0) throw new Error('workspace recovery requires worktree bindings');
    await this.#enqueue(async () => {
      for (const binding of bindings) {
        this.#assertOwnedPath(binding.worktree.path);
        const inspected = await this.#git.registerExistingWorktree(
          binding.worktree.path,
          binding.worktree.branch,
        );
        if (
          binding.worktree.headCommit !== undefined &&
          inspected.headCommit !== binding.worktree.headCommit
        ) {
          throw new Error(`persisted worktree HEAD mismatch for ${binding.isolationKey}`);
        }
        await this.#execution.bindWorktree(
          this.#taskId,
          binding.isolationKey,
          binding.worktree,
          this.#taskRoot,
        );
        this.#remember(binding.isolationKey, binding.worktree);
      }
    });
  }

  async teardown(taskId: string): Promise<void> {
    this.#assertTask(taskId);
    if (this.#disposed) return;
    if (this.#disposing !== undefined) return this.#disposing;
    // The execution backend only borrows the task-owned root. Terminal cleanup
    // must remove the container without moving the canonical repository,
    // persisted state, sessions, or archived artifact out of `.data`.
    const disposing = (async () => {
      await this.#execution.suspend(taskId);
      await this.#git.dispose();
      this.#disposed = true;
    })();
    this.#disposing = disposing;
    try {
      await disposing;
    } finally {
      this.#disposing = undefined;
    }
  }

  worktreeFor(isolationKey: string): WorktreeRef | undefined {
    const value = this.#byIsolationKey.get(isolationKey);
    return value === undefined ? undefined : structuredClone(value);
  }

  #remember(isolationKey: string, ref: WorktreeRef): void {
    const branchOwner = this.#byBranch.get(ref.branch);
    if (branchOwner !== undefined && branchOwner.path !== ref.path) {
      throw new Error(`Git branch collision for ${ref.branch}`);
    }
    this.#byIsolationKey.set(isolationKey, structuredClone(ref));
    this.#byBranch.set(ref.branch, structuredClone(ref));
  }

  #assertTask(taskId: string): void {
    if (taskId !== this.#taskId) throw new Error(`workspace task mismatch: ${taskId}`);
  }

  #assertOwnedPath(path: string): void {
    const canonicalRoot = realpathSync(this.#taskRoot);
    const canonicalPath = realpathSync(path);
    const rel = relative(canonicalRoot, canonicalPath);
    if (rel === '' || rel.startsWith('..'))
      throw new Error('worktree is outside the task-owned root');
  }

  #assertKnown(worktree: Pick<Worktree, 'path' | 'branch'>): void {
    const known = this.#byBranch.get(worktree.branch);
    if (known === undefined || realpathSync(known.path) !== realpathSync(worktree.path)) {
      throw new Error(`worktree is not registered to this task: ${worktree.path}`);
    }
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.catch(() => undefined).then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
