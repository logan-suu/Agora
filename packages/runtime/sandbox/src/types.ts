/**
 * Sandbox type definitions (Phase 0 skeleton).
 *
 * Interface shapes locked per 《详细设计方案》§6 and 《技术选型文档》§7.1 (decision D5).
 * Phase 0 = LocalTempSandbox; Phase 1+ swaps the implementation body without
 * touching these signatures (decision R9).
 */

/**
 * A worker's isolated workspace handle.
 *
 * Phase 0 returns a local temporary directory; Phase 1+ returns a git worktree.
 * `branch` is a placeholder for Phase 0 (no real Git branches yet, decision D5).
 */
export interface Worktree {
  /** Absolute path to the isolated directory. */
  path: string;
  /** Placeholder branch name; real Git branch only from Phase 1+. */
  branch: string;
}

/** Outcome of running a command inside a worktree. */
export interface RunResult {
  /** Process exit code; `null` when killed by timeout. */
  exitCode: number | null;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** True when the command was killed by the timeout, not by normal exit. */
  timedOut: boolean;
}

/** Outcome of merging parallel branches at the integrate checkpoint. */
export interface IntegrationResult {
  /** True when all branches merged cleanly in dependency order. */
  merged: boolean;
  /** Conflicting file paths that blocked the merge (empty when clean). */
  conflicts: string[];
}
