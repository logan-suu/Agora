import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Resolve `path` inside the worktree root and reject any path that escapes it.
 *
 * Enforces decision R7: file operations are confined to the sandbox directory.
 * Both the root and the resolved target are canonicalized with `realpath`
 * (falling back to the nearest existing ancestor for not-yet-written paths)
 * so a symlink inside the worktree cannot redirect access outside the root
 * (DEF-001 resolution; mirrors the 1.1 fs-service hardening).
 *
 * Shared by every sandbox implementation (`LocalTempSandbox`,
 * `DockerSandbox`) so path-confinement semantics never drift between them.
 */
export function assertInside(root: string, path: string): string {
  const canonicalRoot = realpathSync(resolve(root));
  const target = realpathNearestExisting(resolve(canonicalRoot, path));
  if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep)) {
    throw new Error(`path escapes sandbox root: ${path}`);
  }
  return target;
}

/**
 * Canonicalize `path`, walking up to the nearest existing ancestor when the
 * path does not exist yet (writes). Resolves every symlink above the nearest
 * existing component so an escaping symlink is surfaced to the caller.
 */
function realpathNearestExisting(path: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      const canonical = realpathSync(current);
      return tail.length === 0 ? canonical : join(canonical, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`cannot resolve path: ${path}`);
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}
