import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  applyPatch(worktree: string, patch: string): Promise<string>;
  /** Unified diff of a registered worktree: vs HEAD when `ref` is omitted, else vs `ref`. */
  diff(worktree: string, ref?: string): Promise<UnifiedDiff>;
  /** Create a linked worktree with a new branch from the main repo and register it. */
  createWorktree(taskId: string, name: string): Promise<{ path: string; branch: string }>;
  /** Merge `branch` into `base` in the main repo; never throws on conflicts. */
  merge(base: string, branch: string): Promise<MergeResult>;
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
  private mainRepo: SimpleGit | undefined;

  constructor(registry: WorktreeRegistry, mainRepoPath?: string) {
    this.registry = registry;
    if (mainRepoPath !== undefined) {
      this.mainRepoPath = mainRepoPath;
      this.worktreesDir = join(dirname(mainRepoPath), 'worktrees');
    } else {
      // Lazily-created temp main repo: a base temp dir holds `main/` and `worktrees/`.
      const base = mkdtempSync(join(tmpdir(), 'agora-git-'));
      this.mainRepoPath = join(base, 'main');
      this.worktreesDir = join(base, 'worktrees');
    }
  }

  async applyPatch(worktree: string, patch: string): Promise<string> {
    const canonicalRoot = this.assertRegistered(worktree);
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
    await git.add(['-A']);
    await git.commit('apply patch');
    return (await git.revparse(['HEAD'])).trim();
  }

  async diff(worktree: string, ref?: string): Promise<UnifiedDiff> {
    const canonicalRoot = this.assertRegistered(worktree);
    const git = simpleGit(canonicalRoot);
    return ref === undefined ? git.diff(['HEAD']) : git.diff([ref]);
  }

  async createWorktree(taskId: string, name: string): Promise<{ path: string; branch: string }> {
    const branch = validateBranchName(name);
    const main = await this.getMainRepo();
    const path = join(this.worktreesDir, `${taskId}-${name}`);
    // simple-git 3.x has no typed worktree task; drive `git worktree add` via raw.
    await main.raw(['worktree', 'add', path, '-b', branch]);
    this.registry.register(path);
    return { path, branch };
  }

  async merge(base: string, branch: string): Promise<MergeResult> {
    const main = await this.getMainRepo();
    try {
      await main.checkout(base);
    } catch (err) {
      return { ok: false, conflicts: [humanMessage(err, `cannot checkout base branch: ${base}`)] };
    }
    try {
      const res = await main.merge([branch]);
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
      return { ok: false, conflicts: [humanMessage(err, `cannot merge branch: ${branch}`)] };
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
