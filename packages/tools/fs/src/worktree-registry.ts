import { resolve } from 'node:path';

/**
 * Allowlist of worktree roots an fs-server may touch.
 *
 * Tool calls name a `worktree` root; that root must have been registered here
 * (by the composition root, from real SandboxManager worktrees) before any read,
 * write, or list is allowed. This is the defense-in-depth layer behind R7: paths
 * are confined to the worktree, AND the worktree itself must be a known sandbox
 * root — so an agent cannot pass `/etc` and read arbitrary files.
 *
 * Signature mirrors the spec §6 `fs-server` tools, where `worktree` is an input
 * argument (decision R9: interface-first).
 */
export class WorktreeRegistry {
  private readonly roots = new Set<string>();

  /** Register a worktree root (normalized to an absolute path). */
  register(root: string): void {
    this.roots.add(resolve(root));
  }

  /** Remove a worktree root from the allowlist. */
  unregister(root: string): void {
    this.roots.delete(resolve(root));
  }

  /** True when `root` is a registered, reachable worktree. */
  isRegistered(root: string): boolean {
    return this.roots.has(resolve(root));
  }
}
