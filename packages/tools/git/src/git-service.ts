import { createHash } from 'node:crypto';
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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { SecureFiles } from '@agora/runtime-sandbox/secure-files';
import type { WorktreeRegistry } from '@agora/tools-fs';
import {
  CheckRepoActions,
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
  /** Target worktree HEAD after a successful merge. */
  headCommit?: string;
}

export function encodeGitIsolationKey(
  projectId: string,
  taskId: string,
  isolationKey: string,
): string {
  if (projectId.length === 0 || taskId.length === 0 || isolationKey.length === 0) {
    throw new Error('Git isolation identity parts must be non-empty');
  }
  const readable = isolationKey.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  const digest = createHash('sha256')
    .update(`${projectId}\u0000${taskId}\u0000${isolationKey}`)
    .digest('hex')
    .slice(0, 16);
  return validateBranchName(`worker-${(readable || 'isolated').slice(0, 48)}-${digest}`);
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
const INVALID_BRANCH_CHARS = /[~^:?*[\\/]/;

function hasInvalidBranchControlChar(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
}

/**
 * Validate a branch name is git-ref-safe before it is used to create a worktree
 * branch. Rejects empty names, `.`/`..`, leading/trailing dots, `..`, `@{`, and
 * any character that would break a ref name or allow path traversal.
 */
export function validateBranchName(name: string): string {
  if (name.length === 0) {
    throw new Error(`invalid branch name: ${name}`);
  }
  if (
    name === '.' ||
    name === '..' ||
    name === '@' ||
    name.startsWith('.') ||
    name.startsWith('-') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    throw new Error(`invalid branch name: ${name}`);
  }
  if (name.includes('..') || name.includes('@{')) {
    throw new Error(`invalid branch name: ${name}`);
  }
  if (hasInvalidBranchControlChar(name) || INVALID_BRANCH_CHARS.test(name)) {
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
  const git = trustedGit(canonicalRoot);
  if (!(await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Agora');
    await git.addConfig('user.email', 'agora@localhost');
    await git.commit('initial', [], { '--allow-empty': null });
  }
  registry.register(root);
  pinMetadata(registry, canonicalRoot, (await git.revparse(['--absolute-git-dir'])).trim());
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
  private readonly createdWorktrees = new Map<string, string>();
  private disposed = false;
  private mainRepo: SimpleGit | undefined;

  constructor(
    registry: WorktreeRegistry,
    mainRepoPath?: string,
    worktreesDir?: string,
    private readonly protection?: {
      withWorktree<T>(path: string, operation: () => Promise<T>): Promise<T>;
    },
  ) {
    this.registry = registry;
    if (mainRepoPath !== undefined) {
      this.mainRepoPath = mainRepoPath;
      // Namespace caller-owned worktrees by repository so sibling repositories
      // cannot race on the same task/branch directory.
      this.worktreesDir =
        worktreesDir ?? join(dirname(mainRepoPath), `${basename(mainRepoPath)}-worktrees`);
    } else {
      // Lazily-created temp main repo: a base temp dir holds `main/` and `worktrees/`.
      const base = mkdtempSync(join(tmpdir(), 'agora-git-'));
      this.ownedBase = base;
      this.mainRepoPath = join(base, 'main');
      this.worktreesDir = join(base, 'worktrees');
    }
  }

  async applyPatch(worktree: string, patch: string, signal?: AbortSignal): Promise<string> {
    this.assertRegistered(worktree);
    const operation = async () => {
      const canonicalRoot = this.assertRegistered(worktree);
      signal?.throwIfAborted();
      const git = this.worktreeGit(canonicalRoot);
      // simple-git passes the patch as a command-line arg (a file path), so the
      // patch text is staged to a temp file outside the worktree before applying.
      const patchDir = mkdtempSync(join(tmpdir(), 'agora-patch-'));
      const patchFile = join(patchDir, 'patch.diff');
      writeFileSync(patchFile, patch, 'utf8');
      try {
        if (patch.trim().length > 0) await git.applyPatch(patchFile, ['--whitespace=nowarn']);
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
    };
    return this.protection === undefined
      ? operation()
      : this.protection.withWorktree(worktree, operation);
  }

  async diff(worktree: string, ref?: string): Promise<UnifiedDiff> {
    this.assertRegistered(worktree);
    const operation = async () => {
      const canonicalRoot = this.assertRegistered(worktree);
      const git = this.worktreeGit(canonicalRoot);
      return ref === undefined ? git.diff(['HEAD']) : git.diff([validateRefArg(ref, 'ref')]);
    };
    return this.protection === undefined
      ? operation()
      : this.protection.withWorktree(worktree, operation);
  }

  async createWorktree(
    taskId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; branch: string }> {
    const main = await this.getMainRepo();
    const baseCommit = (await main.revparse(['HEAD'])).trim();
    return this.createWorktreeFrom(taskId, name, baseCommit, signal);
  }

  async createWorktreeFrom(
    taskId: string,
    name: string,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; branch: string }> {
    const safeTaskId = validateTaskId(taskId);
    const branch = validateBranchName(name);
    const main = await this.getMainRepo();
    const baseRef = validateRefArg(baseCommit, 'base commit');
    const path = resolve(this.worktreesDir, `${safeTaskId}-${branch}`);
    signal?.throwIfAborted();
    // simple-git 3.x has no typed worktree task; drive `git worktree add` via raw.
    await main.raw(['worktree', 'add', path, '-b', branch, baseRef]);
    this.createdWorktrees.set(path, branch);
    try {
      signal?.throwIfAborted();
    } catch (error) {
      await this.retireWorktree(path, branch).catch((cleanupError) => {
        throw new AggregateError(
          [error, cleanupError],
          'worktree creation cancellation compensation failed',
        );
      });
      throw error;
    }
    this.registry.register(path);
    pinMetadata(
      this.registry,
      realpathSync(path),
      (await trustedGit(path).revparse(['--absolute-git-dir'])).trim(),
    );
    return { path, branch };
  }

  async headOf(worktree: string): Promise<string> {
    this.assertRegistered(worktree);
    const operation = async () => {
      const canonicalRoot = this.assertRegistered(worktree);
      return (await this.worktreeGit(canonicalRoot).revparse(['HEAD'])).trim();
    };
    return this.protection === undefined
      ? operation()
      : this.protection.withWorktree(worktree, operation);
  }

  /** Trusted verification companion; never exposed as a model mutation tool. */
  async inspectValidationWorktree(
    worktree: string,
    inputCommit: string,
  ): Promise<{
    headCommit: string;
    dirty: boolean;
    uncommittedChanges: boolean;
    removedPaths: string[];
    changedPaths: string[];
    trackedFiles: string[];
  }> {
    this.assertRegistered(worktree);
    const operation = async () => {
      const root = this.assertRegistered(worktree);
      const git = this.worktreeGit(root);
      const base = validateRefArg(inputCommit, 'validation input commit');
      const [head, status, ignored, changed, tracked, baseTracked] = await Promise.all([
        git.revparse(['HEAD']),
        git.raw(['status', '--porcelain=v1', '--untracked-files=all']),
        git.raw(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
        git.raw(['diff', '--name-only', '-z', base, 'HEAD']),
        git.raw(['ls-files', '-z']),
        git.raw(['ls-tree', '-r', '--name-only', '-z', base]),
      ]);
      const trackedFiles = tracked.split('\0').filter(Boolean);
      const present = new Set(trackedFiles);
      return {
        headCommit: head.trim(),
        dirty: status.length > 0 || ignored.length > 0,
        uncommittedChanges: status.length > 0,
        removedPaths: baseTracked.split('\0').filter((path) => path !== '' && !present.has(path)),
        changedPaths: changed.split('\0').filter(Boolean),
        trackedFiles,
      };
    };
    return this.protection === undefined
      ? operation()
      : this.protection.withWorktree(worktree, operation);
  }

  async branchOf(worktree: string): Promise<string> {
    this.assertRegistered(worktree);
    const operation = async () => {
      const canonicalRoot = this.assertRegistered(worktree);
      return (await this.worktreeGit(canonicalRoot).revparse(['--abbrev-ref', 'HEAD'])).trim();
    };
    return this.protection === undefined
      ? operation()
      : this.protection.withWorktree(worktree, operation);
  }

  async canonicalHead(): Promise<string> {
    return (await (await this.getMainRepo()).revparse(['HEAD'])).trim();
  }

  async canonicalBranch(): Promise<string> {
    return (await (await this.getMainRepo()).revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  async registerExistingWorktree(
    worktree: string,
    expectedBranch?: string,
  ): Promise<{ path: string; branch: string; headCommit: string }> {
    const main = await this.getMainRepo();
    const lexical = resolve(worktree);
    let registered = false;
    try {
      const candidatePath = realpathSync(lexical);
      const canonicalPath = realpathSync(resolve(this.mainRepoPath));
      if (candidatePath === canonicalPath) {
        throw new Error('persisted worktree cannot be the canonical main worktree');
      }
      const common = gitPath(this.mainRepoPath, await main.revparse(['--git-common-dir']));
      let marker: string;
      try {
        marker = new SecureFiles(lexical).read('.git').trim();
      } catch (cause) {
        throw new Error(
          'persisted worktree does not belong to the configured canonical repository',
          { cause },
        );
      }
      if (!marker.startsWith('gitdir: ') || marker.includes('\n'))
        throw new Error('invalid linked worktree metadata');
      const metadata = realpathSync(resolve(lexical, marker.slice(8)));
      if (dirname(metadata) !== join(common, 'worktrees'))
        throw new Error(
          'persisted worktree does not belong to the configured canonical repository',
        );
      const candidate = trustedGit(lexical, metadata);
      const branch = (await candidate.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (expectedBranch !== undefined && branch !== expectedBranch) {
        throw new Error(
          `persisted worktree branch mismatch: expected ${expectedBranch}, received ${branch}`,
        );
      }
      validateBranchName(branch);
      const [headCommit, canonicalCommonDir, candidateCommonDir, worktreeList] = await Promise.all([
        candidate.revparse(['HEAD']).then((value) => value.trim()),
        main.revparse(['--git-common-dir']).then((value) => gitPath(this.mainRepoPath, value)),
        candidate.revparse(['--git-common-dir']).then((value) => gitPath(lexical, value)),
        main.raw(['worktree', 'list', '--porcelain', '-z']),
      ]);
      if (candidateCommonDir !== canonicalCommonDir) {
        throw new Error(
          'persisted worktree does not belong to the configured canonical repository',
        );
      }
      const matches = parseGitWorktreeList(worktreeList).filter(
        (entry) => realpathSync(resolve(entry.path)) === candidatePath,
      );
      if (
        matches.length !== 1 ||
        matches[0]?.headCommit !== headCommit ||
        matches[0]?.branchRef !== `refs/heads/${branch}`
      ) {
        throw new Error(
          'persisted worktree does not exactly match canonical worktree path, branch, and HEAD metadata',
        );
      }
      this.registry.register(lexical);
      pinMetadata(this.registry, candidatePath, metadata);
      registered = true;
      if (!this.createdWorktrees.has(candidatePath))
        this.createdWorktrees.set(candidatePath, branch);
      return { path: realpathSync(lexical), branch, headCommit };
    } catch (error) {
      if (registered) this.registry.unregister(lexical);
      throw error;
    }
  }

  async retireWorktree(worktree: string, branch: string): Promise<void> {
    const lexical = resolve(worktree);
    const safeBranch = validateBranchName(branch);
    if (this.createdWorktrees.get(lexical) !== safeBranch) {
      throw new Error(`worktree is not owned by this Git service: ${worktree}`);
    }
    const main = await this.getMainRepo();
    if (existsSync(lexical)) this.moveToStaging(lexical);
    await main.raw(['worktree', 'prune']);
    if (await hasLocalBranch(main, safeBranch)) await main.raw(['branch', '-D', safeBranch]);
    this.registry.unregister(lexical);
    this.createdWorktrees.delete(lexical);
  }

  async inspectLegacyWorktree(
    worktree: string,
    expectedBranch: string,
  ): Promise<{ path: string; branch: string; baseCommit: string; headCommit: string }> {
    const registered = await this.registerExistingWorktree(worktree, expectedBranch);
    const mainHead = await this.canonicalHead();
    const baseCommit = (
      await this.worktreeGit(registered.path).raw(['merge-base', registered.headCommit, mainHead])
    ).trim();
    return { ...registered, baseCommit };
  }

  async resetWorktree(worktree: string, commit: string): Promise<void> {
    this.assertRegistered(worktree);
    const operation = async () => {
      const target = this.assertRegistered(worktree);
      await this.worktreeGit(target).reset(['--hard', validateRefArg(commit, 'reset commit')]);
    };
    return this.protection === undefined
      ? operation()
      : this.protection.withWorktree(worktree, operation);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const main = await this.getMainRepo();
    const ancestorRef = validateRefArg(ancestor, 'ancestor');
    const descendantRef = validateRefArg(descendant, 'descendant');
    try {
      await main.raw(['merge-base', '--is-ancestor', ancestorRef, descendantRef]);
      return true;
    } catch {
      return false;
    }
  }

  async parentsOf(commit: string): Promise<readonly string[]> {
    const main = await this.getMainRepo();
    const ref = validateRefArg(commit, 'commit');
    const fields = (await main.raw(['rev-list', '--parents', '-n', '1', ref])).trim().split(/\s+/);
    if (fields[0] !== commit)
      throw new Error(`Git did not resolve the requested commit: ${commit}`);
    return fields.slice(1);
  }

  async mergeInWorktree(
    targetWorktree: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<MergeResult> {
    this.assertRegistered(targetWorktree);
    const operation = async () => {
      const target = this.assertRegistered(targetWorktree);
      const branchRef = validateRefArg(branch, 'branch');
      const git = this.worktreeGit(target);
      try {
        signal?.throwIfAborted();
        const result = await git.merge([branchRef]);
        if (result.result.includes('CONFLICT')) {
          const conflicts = conflictPaths(result);
          await abortMerge(git, target);
          return { ok: false, conflicts };
        }
        return { ok: true, headCommit: (await git.revparse(['HEAD'])).trim() };
      } catch (error) {
        const conflicts =
          error instanceof GitResponseError && error.git.conflicts.length > 0
            ? conflictPaths(error.git as SimpleGitMergeResult)
            : [humanMessage(error, `cannot merge branch: ${branchRef}`)];
        if (await hasMergeHead(git, target)) await abortMerge(git, target);
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return { ok: false, conflicts };
      }
    };
    return this.protection === undefined
      ? operation()
      : this.protection.withWorktree(targetWorktree, operation);
  }

  /** Reclaim ownership of prior-process trees only within this task's configured namespace. */
  async recoverTaskWorktreesForDisposal(taskId: string): Promise<void> {
    const safeTaskId = validateTaskId(taskId);
    if (!existsSync(this.worktreesDir)) return;
    const lexicalRoot = resolve(this.worktreesDir);
    const canonicalRoot = realpathSync(lexicalRoot);
    const main = await this.getMainRepo();
    const entries = parseGitWorktreeList(await main.raw(['worktree', 'list', '--porcelain', '-z']));
    for (const entry of entries) {
      const path = resolve(entry.path);
      if (
        (dirname(path) !== lexicalRoot && dirname(path) !== canonicalRoot) ||
        !basename(path).startsWith(`${safeTaskId}-`)
      )
        continue;
      const branch = entry.branchRef?.startsWith('refs/heads/')
        ? entry.branchRef.slice(11)
        : undefined;
      if (
        branch === undefined ||
        basename(path) !== `${safeTaskId}-${branch}` ||
        dirname(realpathSync(path)) !== canonicalRoot
      ) {
        throw new Error('task cleanup worktree does not match its owned namespace');
      }
      const alreadyOwned = [...this.createdWorktrees].some(
        ([ownedPath, ownedBranch]) =>
          ownedBranch === branch && realpathSync(ownedPath) === realpathSync(path),
      );
      if (alreadyOwned) continue;
      await this.registerExistingWorktree(path, branch);
    }
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
    mkdirSync(GIT_TEARDOWN_STAGING, { recursive: true });
    if (this.ownedBase !== undefined) {
      if (existsSync(this.ownedBase)) {
        this.moveToStaging(this.ownedBase);
      }
      this.disposed = true;
      return;
    }
    for (const [path, branch] of [...this.createdWorktrees]) {
      await this.retireWorktree(path, branch);
    }
    this.disposed = true;
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
    const git = trustedGit(this.mainRepoPath);
    // A task may live inside another checkout's ignored .data directory.
    // An ancestor repository must never become this task's canonical repo.
    if (!(await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
      await git.init(['--initial-branch=main']);
      await git.addConfig('user.name', 'Agora');
      await git.addConfig('user.email', 'agora@localhost');
      await git.add(['-A']);
      await git.commit('initial', [], { '--allow-empty': null });
    }
    this.mainRepo = git;
    return git;
  }

  private worktreeGit(root: string): SimpleGit {
    const metadata = metadataBindings.get(this.registry)?.get(realpathSync(root));
    if (metadata === undefined) throw new Error('worktree Git metadata not registered');
    return trustedGit(root, metadata);
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
    this.registry.filesFor(root).verifyRoot();
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

function gitPath(worktree: string, output: string): string {
  const path = output.trim();
  return realpathSync(isAbsolute(path) ? path : resolve(worktree, path));
}

interface GitWorktreeListEntry {
  path: string;
  headCommit: string;
  branchRef?: string;
}

function parseGitWorktreeList(raw: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  for (const record of raw.split('\0\0')) {
    if (record.length === 0) continue;
    let path: string | undefined;
    let headCommit: string | undefined;
    let branchRef: string | undefined;
    for (const field of record.split('\0')) {
      if (field.startsWith('worktree ')) path = uniqueGitField(path, field.slice(9), 'worktree');
      else if (field.startsWith('HEAD '))
        headCommit = uniqueGitField(headCommit, field.slice(5), 'HEAD');
      else if (field.startsWith('branch '))
        branchRef = uniqueGitField(branchRef, field.slice(7), 'branch');
    }
    if (path === undefined || headCommit === undefined) {
      throw new Error('canonical git worktree list contains an incomplete record');
    }
    entries.push({ path, headCommit, ...(branchRef === undefined ? {} : { branchRef }) });
  }
  return entries;
}

function uniqueGitField(existing: string | undefined, value: string, label: string): string {
  if (existing !== undefined || value.length === 0) {
    throw new Error(`canonical git worktree list contains an invalid ${label} field`);
  }
  return value;
}

async function hasLocalBranch(git: SimpleGit, branch: string): Promise<boolean> {
  try {
    await git.raw(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function mergeHeadPath(git: SimpleGit, worktree: string): Promise<string> {
  const output = (await git.revparse(['--git-path', 'MERGE_HEAD'])).trim();
  return isAbsolute(output) ? output : resolve(worktree, output);
}

async function hasMergeHead(git: SimpleGit, worktree: string): Promise<boolean> {
  return existsSync(await mergeHeadPath(git, worktree));
}

async function abortMerge(git: SimpleGit, worktree: string): Promise<void> {
  await git.raw(['merge', '--abort']);
  if (await hasMergeHead(git, worktree)) {
    throw new Error('git merge --abort left MERGE_HEAD behind');
  }
}

// Pinned during trusted creation/recovery, before any model can edit the worktree.
const metadataBindings = new WeakMap<WorktreeRegistry, Map<string, string>>();
function pinMetadata(registry: WorktreeRegistry, root: string, metadata: string): void {
  let bindings = metadataBindings.get(registry);
  if (bindings === undefined) {
    bindings = new Map();
    metadataBindings.set(registry, bindings);
  }
  bindings.set(root, realpathSync(metadata));
}

function trustedGit(root: string, metadata?: string): SimpleGit {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot'].includes(key),
    ),
  );
  return simpleGit({
    baseDir: root,
    // Fixed values disable hooks and fsmonitor; callers cannot supply this configuration.
    unsafe: {
      allowUnsafeHooksPath: true,
      allowUnsafeFsMonitor: true,
      allowUnsafeProtocolOverride: true,
      allowUnsafeConfigPaths: true,
    },
    config: [
      'core.hooksPath=/dev/null',
      'core.fsmonitor=false',
      'core.attributesFile=/dev/null',
      'protocol.file.allow=never',
    ],
  }).env({
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...(metadata === undefined ? {} : { GIT_DIR: metadata, GIT_WORK_TREE: root }),
  });
}
