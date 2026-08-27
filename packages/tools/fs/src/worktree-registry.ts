import { realpathSync } from 'node:fs';
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
 * Each root is bound to its **canonical** path at registration. Operations
 * re-resolve the current root and reject it if it no longer matches the bound
 * canonical path (e.g. a registered symlink retargeted elsewhere), closing the
 * CWE-59 path-traversal via symlink retargeting.
 *
 * Signature mirrors the spec §6 `fs-server` tools, where `worktree` is an input
 * argument (decision R9: interface-first).
 */
export class WorktreeRegistry {
  private readonly canonicalRoots = new Map<string, string>();

  /** Register a worktree root, binding its canonical (symlink-resolved) path. */
  register(root: string): void {
    const lexical = resolve(root);
    this.canonicalRoots.set(lexical, realpathSync(lexical));
  }

  /** Remove a worktree root from the allowlist. */
  unregister(root: string): void {
    this.canonicalRoots.delete(resolve(root));
  }

  /**
   * The canonical path a root was bound to at registration, or `undefined` when
   * the root is not registered.
   */
  canonicalOf(root: string): string | undefined {
    return this.canonicalRoots.get(resolve(root));
  }
}
