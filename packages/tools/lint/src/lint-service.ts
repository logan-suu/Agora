import { spawn } from 'node:child_process';
import { accessSync, existsSync, constants as fsConstants, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorktreeRegistry } from '@agora/tools-fs';

/** Default per-command timeout (decision R7: 30s). */
export const DEFAULT_LINT_TIMEOUT_MS = 30_000;

/**
 * One lint diagnostic (spec §6 `lint-server`: `check(worktree, paths) ->
 * issues[ ]`). `line` is 1-based; `rule` is the biome rule id (e.g.
 * `lint/suspicious/noDoubleEquals`); `(timeout)` marks a timed-out run.
 */
export interface LintIssue {
  file: string;
  line: number;
  message: string;
  rule: string;
  severity: string;
}

/**
 * Lints files inside a registered worktree and returns the issue list
 * (spec §6 `lint-server`). An empty result means no findings.
 */
export interface LintService {
  check(root: string, paths: readonly string[], timeoutMs?: number): Promise<LintIssue[]>;
}

export interface WorktreeLintServiceOptions {
  /**
   * Path to the biome JS launcher (`bin/biome`). Defaults to the nearest
   * `node_modules/@biomejs/biome/bin/biome` found walking up from this module.
   */
  biomeBin?: string;
}

/**
 * Worktree-scoped lint service (spec §6 `lint-server`), wrapping the Biome CLI.
 *
 * The root must be on the {@link WorktreeRegistry} allowlist and re-resolved to
 * its canonical path (mirrors fs/test-service's assertRegistered hardening).
 * Biome runs via `node <bin> lint <paths> --reporter=json` with cwd = the
 * worktree root — no shell, so path arguments cannot inject commands; each path
 * is additionally validated worktree-relative (R7). Diagnostics are returned
 * verbatim; a biome crash (exit ≥ 2) throws loudly instead of degrading (§12).
 */
export class WorktreeLintService implements LintService {
  private readonly biomeBin: string;

  constructor(
    private readonly registry: WorktreeRegistry,
    options: WorktreeLintServiceOptions = {},
  ) {
    this.biomeBin = options.biomeBin ?? resolveBiomeBin();
  }

  async check(
    root: string,
    paths: readonly string[],
    timeoutMs = DEFAULT_LINT_TIMEOUT_MS,
  ): Promise<LintIssue[]> {
    const canonicalRoot = this.assertRegistered(root);
    const validated = paths.map(validatePathArg);
    const args = ['lint', ...validated, '--reporter=json'];
    const outcome = await runNodeInDir(canonicalRoot, this.biomeBin, args, timeoutMs);
    if (outcome.timedOut) {
      return [timeoutIssue(timeoutMs)];
    }
    // Biome exits 0 for a clean run and 1 when diagnostics were found; any
    // other exit is a biome failure (bad paths, bad config, missing binary).
    if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
      const tail = (outcome.stderr + outcome.stdout).trim().split('\n').slice(-8).join('\n');
      throw new Error(`biome lint failed (exit ${outcome.exitCode}): ${tail || 'no output'}`);
    }
    return parseDiagnostics(outcome.stdout);
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

/** Reject path arguments that could escape the worktree or inject CLI flags (R7). */
function validatePathArg(path: string): string {
  if (path.length === 0) {
    throw new Error('lint path must be a non-empty worktree-relative path');
  }
  if (path.startsWith('-')) {
    throw new Error(`lint path must not start with "-": ${path}`);
  }
  if (path.startsWith('/') || path.includes('\\')) {
    throw new Error(`lint path must be worktree-relative: ${path}`);
  }
  if (path.split('/').includes('..')) {
    throw new Error(`lint path must not traverse outside the worktree: ${path}`);
  }
  return path;
}

interface BiomeDiagnostic {
  severity?: unknown;
  message?: unknown;
  category?: unknown;
  location?: {
    path?: unknown;
    start?: { line?: unknown; column?: unknown };
  };
}

/** Parse the `--reporter=json` payload into {@link LintIssue} entries. */
function parseDiagnostics(stdout: string): LintIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (err) {
    throw new Error(`biome lint produced non-JSON output: ${String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !('diagnostics' in parsed)) {
    throw new Error('biome lint JSON output is missing the diagnostics array');
  }
  const diagnostics = (parsed as { diagnostics: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) {
    throw new Error('biome lint JSON output is missing the diagnostics array');
  }
  const issues: LintIssue[] = [];
  for (const diagnostic of diagnostics as BiomeDiagnostic[]) {
    const path = diagnostic.location?.path;
    const start = diagnostic.location?.start;
    issues.push({
      file: typeof path === 'string' ? path : '',
      line: typeof start?.line === 'number' ? start.line : 0,
      message: typeof diagnostic.message === 'string' ? diagnostic.message : '',
      rule: typeof diagnostic.category === 'string' ? diagnostic.category : '',
      severity: typeof diagnostic.severity === 'string' ? diagnostic.severity : '',
    });
  }
  return issues;
}

function timeoutIssue(timeoutMs: number): LintIssue {
  return {
    file: '',
    line: 0,
    message: `biome lint timed out after ${timeoutMs}ms`,
    rule: '(timeout)',
    severity: 'error',
  };
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn `node <biomeBin> <args>` in the worktree root (no shell, no quoting). */
function runNodeInDir(
  cwd: string,
  biomeBin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [biomeBin, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Locate the biome JS launcher by walking up from this module until a
 * `node_modules/@biomejs/biome/bin/biome` exists (the pnpm symlink provided by
 * the declared dependency). Falls back to bare `biome` on PATH.
 */
function resolveBiomeBin(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return 'biome';
    }
    dir = parent;
  }
}
