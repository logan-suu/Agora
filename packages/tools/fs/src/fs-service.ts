import {
  accessSync,
  type Dirent,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { WorktreeRegistry } from './worktree-registry';

/** Optional 0-based character range for a read (`[start, end)`). */
export interface ReadRange {
  start: number;
  /** Exclusive end offset; when omitted, reads to the end of the file. */
  end?: number | undefined;
}

/** Pure file operations over a registered worktree (no MCP dependency). */
export interface FsService {
  read(root: string, path: string, range?: ReadRange): string;
  write(root: string, path: string, content: string): void;
  list(root: string, glob: string): string[];
}

/** Directories never surfaced by `list` (VCS / dependency noise). */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.data']);

/**
 * Worktree-scoped file service (spec §6 `fs-server`).
 *
 * Every operation confines paths to a *registered* worktree root (decision R7 /
 * R9): the root must be on the {@link WorktreeRegistry} allowlist, and the
 * resolved target must not escape it. Kept free of MCP imports so it is
 * unit-testable in isolation.
 */
export class WorktreeFsService implements FsService {
  constructor(private readonly registry: WorktreeRegistry) {}

  read(root: string, path: string, range?: ReadRange): string {
    const target = this.assertInside(root, path);
    const content = readFileSync(target, 'utf8');
    return range === undefined ? content : sliceContent(content, range);
  }

  write(root: string, path: string, content: string): void {
    const target = this.assertInside(root, path);
    mkdirSync(dirnameOf(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  list(root: string, glob: string): string[] {
    const rootResolved = this.assertRegistered(root);
    const matcher = globToRegExp(glob);
    const matches: string[] = [];
    walk(rootResolved, rootResolved, '', matches);
    return matches.filter((rel) => matcher.test(rel)).sort();
  }

  private assertRegistered(root: string): string {
    const rootResolved = resolve(root);
    if (!this.registry.isRegistered(root)) {
      throw new Error(`worktree not registered: ${root}`);
    }
    return rootResolved;
  }

  /**
   * Resolve `path` inside the worktree and reject any path that escapes it.
   * Enforces decision R7: file operations are confined to the sandbox dir.
   */
  private assertInside(root: string, path: string): string {
    const rootResolved = this.assertRegistered(root);
    const target = resolve(rootResolved, path);
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      throw new Error(`path escapes worktree root: ${path}`);
    }
    accessSync(rootResolved, fsConstants.R_OK);
    return target;
  }
}

function sliceContent(content: string, range: ReadRange): string {
  const start = Math.max(0, range.start);
  const end = range.end === undefined ? content.length : Math.min(content.length, range.end);
  if (start > end) {
    throw new Error(`range start (${start}) exceeds end (${end})`);
  }
  return content.slice(start, end);
}

/** Recursively collect file paths (relative to `base`, `/`-separated). */
function walk(base: string, dir: string, rel: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir -> best-effort, skip silently
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      walk(base, join(dir, entry.name), childRel, out);
    } else if (entry.isFile()) {
      out.push(rel === '' ? entry.name : `${rel}/${entry.name}`);
    }
  }
}

/**
 * Translate a small glob dialect to a RegExp:
 *  - `*`  matches any characters within one path segment
 *  - `?`  matches a single non-`/` character
 *  - `**` matches zero or more path segments
 */
function globToRegExp(glob: string): RegExp {
  const segments = glob.split('/');
  let out = '';
  let i = 0;
  for (const seg of segments) {
    const isLast = i === segments.length - 1;
    if (seg === '**') {
      out += isLast ? '.*' : '(?:[^/]+(?:/|$))*';
    } else {
      out += segmentToRegExp(seg);
      if (!isLast) out += '/';
    }
    i++;
  }
  return new RegExp(`^${out}$`);
}

function segmentToRegExp(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeRegExpChar(ch);
  }
  return out;
}

function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function dirnameOf(path: string): string {
  const last = path.lastIndexOf(sep);
  return last > 0 ? path.slice(0, last) : path;
}
