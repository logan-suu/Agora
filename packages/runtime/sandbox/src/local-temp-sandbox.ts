import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { assertInside } from './path-guard';
import type { RecoverableWorktreeBinding } from './recoverable-sandbox-manager';
import type { SandboxManager } from './sandbox-manager';
import type { IntegrationResult, RunResult, Worktree } from './types';

/** Default per-command timeout (decision R7: 30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Directory where torn-down sandboxes are moved to (move, not delete). */
const TEARDOWN_STAGING = join(tmpdir(), 'agora-sandbox-trash');

/**
 * Phase 0 sandbox implementation (decision D5 / R7).
 *
 * Uses Node.js native `fs.mkdtempSync` for an isolated temp directory and
 * `child_process.spawn` for command execution. No Docker, no Git worktrees
 * until Phase 1+; the interface signature stays identical (decision R9).
 * Path confinement delegates to the shared {@link assertInside} guard
 * (DEF-001: realpath-hardened against symlink escape).
 */
export class LocalTempSandbox implements SandboxManager {
  /** Tracks the temp dir created per taskId so teardown can locate it. */
  private readonly roots = new Map<string, string>();

  createWorktree(taskId: string, role: string): Promise<Worktree> {
    const prefix = localWorktreePrefix(taskId, role);
    const path = mkdtempSync(join(tmpdir(), prefix));
    this.roots.set(taskId, path);
    // Phase 0 has no real Git branches (decision D5); branch is a placeholder.
    return Promise.resolve({ path, branch: `${taskId}-${role}` });
  }

  async read(worktree: Worktree, path: string): Promise<string> {
    const target = assertInside(worktree.path, path);
    return readFileSync(target, 'utf8');
  }

  async write(worktree: Worktree, path: string, content: string): Promise<void> {
    const target = assertInside(worktree.path, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  run(worktree: Worktree, cmd: string, timeout = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
    return runInDir(worktree.path, cmd, timeout);
  }

  integrate(_base: string, _branches: string[]): Promise<IntegrationResult> {
    // Phase 0: no Git merge semantics (decision D5). Explicit not-implemented,
    // never silent — mirrors how reducer treats disabled fields.
    return Promise.reject(
      new Error(
        'LocalTempSandbox.integrate is not implemented in Phase 0 (decision D5: no Git until Phase 1+)',
      ),
    );
  }

  teardown(taskId: string): Promise<void> {
    const root = this.roots.get(taskId);
    if (root === undefined) {
      return Promise.resolve();
    }
    this.roots.delete(taskId);
    // Move (not delete) to honor file protection (spec §6 teardown comment).
    mkdirSync(TEARDOWN_STAGING, { recursive: true });
    const destination = join(TEARDOWN_STAGING, basename(root));
    renameSync(root, destination);
    return Promise.resolve();
  }

  /** Local mode has no container; keep the directory registered and untouched. */
  suspend(_taskId: string): Promise<void> {
    return Promise.resolve();
  }

  /** Re-register a persisted local worktree after composition/process reconstruction. */
  resume(taskId: string, bindings: readonly RecoverableWorktreeBinding[]): Promise<void> {
    if (bindings.length !== 1) {
      return Promise.reject(new Error('LocalTempSandbox resume requires exactly one worktree'));
    }
    const binding = bindings[0];
    const path = binding?.worktree.path;
    if (path === undefined || !statSync(path).isDirectory()) {
      return Promise.reject(new Error('persisted local worktree is not an existing directory'));
    }
    const canonical = realpathSync(path);
    if (
      binding === undefined ||
      !basename(canonical).startsWith(localWorktreePrefix(taskId, binding.role))
    ) {
      return Promise.reject(
        new Error(`persisted local worktree does not belong to task "${taskId}"`),
      );
    }
    this.roots.set(taskId, canonical);
    return Promise.resolve();
  }
}

function localWorktreePrefix(taskId: string, role: string): string {
  return `agora-${safeSegment(taskId)}-${identityHash(taskId)}-${safeSegment(role)}-`;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length === 0 ? 'worktree' : safe;
}

function identityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Run a command in a directory with spawn, capturing output and enforcing timeout. */
function runInDir(cwd: string, cmd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise, reject) => {
    const child = spawn(cmd, { cwd, shell: true });
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
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}
