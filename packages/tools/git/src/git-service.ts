import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { WorktreeRegistry } from '@agora/tools-fs';
import {
  GitResponseError,
  type SimpleGit,
  type MergeResult as SimpleGitMergeResult,
  simpleGit,
} from 'simple-git';

/** A unified diff (working-tree vs HEAD, or vs an explicit ref). */
export type UnifiedDiff = string;

/** Outcome of a `merge(base, branch)` across branches in the main repo. */
export interface MergeResult {
  ok: boolean;
  /** Conflicting paths, or a human-readable reason when the merge could not run. */
  conflicts?: string[];
}

/**
 * Git operations over a main repository and its linked worktrees (spec §6
 * `git-server`). Kept free of MCP imports so it is unit-testable in isolation.
 */
export interface GitService {
  /** Apply a patch inside a registered worktree and commit it; returns the new commit id. */
  applyPatch(worktree: string, patch: string, signal?: AbortSignal): Promise<string>;
  /** Unified diff of a registered worktree: vs HEAD when `ref` is omitted, else vs `ref`. */
  diff(worktree: string, ref?: string): Promise<UnifiedDiff>;
  /** Create a linked worktree with a new branch from the main repo and register it. */
  createWorktree(
    taskId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; branch: string }>;
  /** Merge `branch` into `base` in the main repo; never throws on conflicts. */
  merge(base: string, branch: string, signal?: AbortSignal): Promise<MergeResult>;
}

/**
 * Characters that are illegal in a git ref name (decision: reject before use).
 * Covers `/`, whitespace, and the `~^:?*[\` set; `..` and `@{` are rejected
 * separately to close path-traversal / ref-ambiguity vectors.
 */
const INVALID_BRANCH_CHARS = /[~^:?*[\\\s/]/;

/**
 * Validate a branch name is git-ref-safe before it is used to create a worktree
 * branch. Rejects empty names, `.`/`..`, leading/trailing dots, `..`, `@{`, and
 * any character that would break a ref name or allow path traversal.
 */
export function validateBranchName(name: string): string {
  if (name.length === 0) {
    throw new Error(`invalid branch name: ${name}`);
  }
  if (name === '.' || name === '..' || name.startsWith('.') || name.endsWith('.')) {
    throw new Error(`invalid branch name: ${name}`);
  }
  if (name.includes('..') || name.includes('@{')) {
    throw new Error(`invalid branch name: ${name}`);
  }
  if (INVALID_BRANCH_CHARS.test(name)) {
    throw new Error(`invalid branch name: ${name}`);
  }
  return name;
}

/**
 * Validate a task id used to name a worktree directory (decision R7: file
 * operations stay confined to the sandbox area). The task id is interpolated
 * into the worktree path, so reject path separators, `..`, whitespace and
 * leading dots — closing the path-traversal vector that would otherwise let a
 * malicious id place a worktree outside `worktreesDir`.
 */
export function validateTaskId(taskId: string): string {
  if (
    taskId.length === 0 ||
    taskId.includes('/') ||
    taskId.includes('\\') ||
    taskId.includes('..') ||
    taskId.startsWith('.') ||
    /\s/.test(taskId)
  ) {
    throw new Error(`invalid task id: ${taskId}`);
  }
  return taskId;
}

/**
 * Validate a user-supplied git ref argument (`diff` `ref`, `merge` `base` /
 * `branch`). Rejects empty values, option-looking values (leading `-`) and
 * whitespace so a ref cannot be misparsed by git as an option — e.g.
 * `--output=...` would otherwise write a diff outside the worktree (R7).
 * Range syntax like `main..feature` and `HEAD~1` is still allowed.
 */
export function validateRefArg(ref: string, label: string): string {
  if (ref.length === 0 || ref.startsWith('-') || /\s/.test(ref)) {
    throw new Error(`invalid ${label}: ${ref}`);
  }
  return ref;
}

/**
 * Directory where disposed service-owned git trees are moved to (move, not
 * delete — the same file-protection stance as the sandbox teardown, spec §6).
 */
export const GIT_TEARDOWN_STAGING = join(tmpdir(), 'agora-git-trash');

/**
 * Prepare an existing SandboxManager worktree for the host-side git MCP tools.
 * Docker bind mounts expose the same directory on the host, so git metadata is
 * initialized here while file execution remains inside the container.
 */
export async function initializeRegisteredWorktree(
  registry: WorktreeRegistry,
  root: string,
): Promise<void> {
  const canonicalRoot = realpathSync(resolve(root));
  const git = simpleGit(canonicalRoot);
  if (!(await git.checkIsRepo())) {
    await git.init();
    await git.addConfig('user.name', 'Agora');
    await git.addConfig('user.email', 'agora@localhost');
    await git.commit('initial', [], { '--allow-empty': null });
  }
  registry.register(root);
}

/**
 * Worktree-scoped git service (spec §6 `git-server`).
 *
 * Holds ONE main repository (decision: mainRepo + linked worktree model).
 * `createWorktree` adds a linked worktree with a fresh branch from the main repo
 * and auto-registers its root on the {@link WorktreeRegistry} allowlist. Every
 * worktree-scoped operation re-resolves the root to its bound canonical path and
 * rejects unregistered or retargeted roots (mirrors fs-service's
 * assertRegistered hardening). simple-git is the only dependency and is imported
 * here exclusively (decision D5: simple-git is optional).
 */
export class WorktreeGitService implements GitService {
  private readonly registry: WorktreeRegistry;
  private readonly mainRepoPath: string;
  private readonly worktreesDir: string;
  /** Set when the main repo is service-owned (mainRepoPath omitted at construction). */
  private readonly ownedBase: string | undefined;
  private readonly createdWorktrees: string[] = [];
  private disposed = false;
  private mainRepo: SimpleGit | undefined;

  constructor(registry: WorktreeRegistry, mainRepoPath?: string) {
    this.registry = registry;
    if (mainRepoPath !== undefined) {
      this.mainRepoPath = mainRepoPath;
      // Namespace caller-owned worktrees by repository so sibling repositories
      // cannot race on the same task/branch directory.
      this.worktreesDir = join(dirname(mainRepoPath), `${basename(mainRepoPath)}-worktrees`);
    } else {
      // Lazily-created temp main repo: a base temp dir holds `main/` and `worktrees/`.
      const base = mkdtempSync(join(tmpdir(), 'agora-git-'));
      this.ownedBase = base;
      this.mainRepoPath = join(base, 'main');
      this.worktreesDir = join(base, 'worktrees');
    }
  }

  async applyPatch(worktree: string, patch: string, signal?: AbortSignal): Promise<string> {
    const canonicalRoot = this.assertRegistered(worktree);
    signal?.throwIfAborted();
    const git = simpleGit(canonicalRoot);
    // simple-git passes the patch as a command-line arg (a file path), so the
    // patch text is staged to a temp file outside the worktree before applying.
    const patchDir = mkdtempSync(join(tmpdir(), 'agora-patch-'));
    const patchFile = join(patchDir, 'patch.diff');
    writeFileSync(patchFile, patch, 'utf8');
    try {
      await git.applyPatch(patchFile, ['--whitespace=nowarn']);
    } finally {
      rmSync(patchDir, { recursive: true, force: true });
    }
    // Cooperative cancellation (task 1.5 timeout policy): never stage+commit
    // after the caller aborted — a late commit would land silently after the
    // model was told the tool timed out.
    signal?.throwIfAborted();
    await git.add(['-A']);
    signal?.throwIfAborted();
    await git.commit('apply patch');
    return (await git.revparse(['HEAD'])).trim();
  }

  async diff(worktree: string, ref?: string): Promise<UnifiedDiff> {
    const canonicalRoot = this.assertRegistered(worktree);
    const git = simpleGit(canonicalRoot);
    return ref === undefined ? git.diff(['HEAD']) : git.diff([validateRefArg(ref, 'ref')]);
  }

  async createWorktree(
    taskId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; branch: string }> {
    const safeTaskId = validateTaskId(taskId);
    const branch = validateBranchName(name);
    const main = await this.getMainRepo();
    const path = join(this.worktreesDir, `${safeTaskId}-${branch}`);
    signal?.throwIfAborted();
    // simple-git 3.x has no typed worktree task; drive `git worktree add` via raw.
    await main.raw(['worktree', 'add', path, '-b', branch]);
    signal?.throwIfAborted();
    this.registry.register(path);
    this.createdWorktrees.push(path);
    return { path, branch };
  }

  /**
   * Release service-owned git trees at end of life: the temp base (main repo +
   * linked worktrees) when the main repo is service-owned, or each created
   * linked worktree when the caller owns the main repo — the caller's own
   * repository is never touched. Trees are MOVED to {@link GIT_TEARDOWN_STAGING}
   * (never silently deleted, spec §6 file protection). Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    mkdirSync(GIT_TEARDOWN_STAGING, { recursive: true });
    if (this.ownedBase !== undefined) {
      if (existsSync(this.ownedBase)) {
        this.moveToStaging(this.ownedBase);
      }
      return;
    }
    for (const path of this.createdWorktrees) {
      if (existsSync(path)) {
        this.moveToStaging(path);
      }
    }
    this.createdWorktrees.length = 0;
  }

  /** Move one tree into a unique staging slot (deterministic names must not collide across runs). */
  private moveToStaging(path: string): void {
    const slot = mkdtempSync(join(GIT_TEARDOWN_STAGING, 'dispose-'));
    renameSync(path, join(slot, basename(path)));
  }

  async merge(base: string, branch: string, signal?: AbortSignal): Promise<MergeResult> {
    const main = await this.getMainRepo();
    const baseRef = validateRefArg(base, 'base branch');
    const branchRef = validateRefArg(branch, 'branch');
    try {
      signal?.throwIfAborted();
      await main.checkout(baseRef);
    } catch (err) {
      return {
        ok: false,
        conflicts: [humanMessage(err, `cannot checkout base branch: ${baseRef}`)],
      };
    }
    try {
      signal?.throwIfAborted();
      const res = await main.merge([branchRef]);
      if (res.result.includes('CONFLICT')) {
        return { ok: false, conflicts: conflictPaths(res) };
      }
      return { ok: true };
    } catch (err) {
      // A conflicting merge rejects with a GitResponseError carrying the MergeResult.
      if (err instanceof GitResponseError) {
        const mergeResult = err.git as SimpleGitMergeResult;
        if (mergeResult.conflicts.length > 0) {
          return { ok: false, conflicts: conflictPaths(mergeResult) };
        }
      }
      // e.g. the target branch is checked out by a linked worktree (git worktree lock)
      return { ok: false, conflicts: [humanMessage(err, `cannot merge branch: ${branchRef}`)] };
    }
  }

  /** Lazily init the main repo (git init + an initial empty commit) on first use. */
  private async getMainRepo(): Promise<SimpleGit> {
    if (this.mainRepo !== undefined) {
      return this.mainRepo;
    }
    mkdirSync(this.mainRepoPath, { recursive: true });
    const git = simpleGit(this.mainRepoPath);
    await git.init();
    await git.addConfig('user.name', 'Agora');
    await git.addConfig('user.email', 'agora@localhost');
    await git.commit('initial', [], { '--allow-empty': null });
    this.mainRepo = git;
    return git;
  }

  /** Resolve the root to its bound canonical path, rejecting unregistered/retargeted roots. */
  private assertRegistered(root: string): string {
    const lexical = resolve(root);
    const bound = this.registry.canonicalOf(root);
    if (bound === undefined) {
      throw new Error(`worktree not registered: ${root}`);
    }
    const canonicalRoot = realpathSync(lexical);
    if (canonicalRoot !== bound) {
      throw new Error(`worktree root retargeted: ${root}`);
    }
    accessSync(canonicalRoot, fsConstants.R_OK);
    return canonicalRoot;
  }
}

/** Human-readable message for a thrown git error, with a fallback prefix. */
function humanMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 0 ? message : fallback;
}

function conflictPaths(result: SimpleGitMergeResult): string[] {
  return result.conflicts.map((c) => c.file).filter((file): file is string => file !== null);
}
