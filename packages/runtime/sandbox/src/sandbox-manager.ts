import type { IntegrationResult, RunResult, Worktree } from './types';

/**
 * Port interface for the sandbox (L3, decision R9: interface-first).
 *
 * Signatures locked verbatim from 《详细设计方案》§6 and 《技术选型文档》§7.1.
 * Phase degradation only swaps the implementation body (LocalTempSandbox →
 * Docker/worktree), never this signature.
 */
export interface SandboxManager {
  /** One isolated directory per worker (Phase 0 = temp dir, Phase 1+ = git worktree). */
  createWorktree(taskId: string, role: string): Promise<Worktree>;
  /** Pull-on-read: the file truth lives in the sandbox, never cached in State. */
  read(worktree: Worktree, path: string): Promise<string>;
  /** Writes confined to inside the worktree directory. */
  write(worktree: Worktree, path: string, content: string): Promise<void>;
  /** Run a command; default timeout 30s (decision R7). */
  run(worktree: Worktree, cmd: string, timeout?: number): Promise<RunResult>;
  /** Sequential merge in dependency order; conflicts escalate (not implemented in Phase 0). */
  integrate(base: string, branches: string[]): Promise<IntegrationResult>;
  /** Cleanup (move rather than delete, honoring file protection). */
  teardown(taskId: string): Promise<void>;
}
