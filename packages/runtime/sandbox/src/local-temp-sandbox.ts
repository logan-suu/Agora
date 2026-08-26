import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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
 */
export class LocalTempSandbox implements SandboxManager {
  /** Tracks the temp dir created per taskId so teardown can locate it. */
  private readonly roots = new Map<string, string>();

  createWorktree(taskId: string, role: string): Promise<Worktree> {
    const prefix = `agora-${taskId}-${role}-`;
    const path = mkdtempSync(join(tmpdir(), prefix));
    this.roots.set(taskId, path);
    // Phase 0 has no real Git branches (decision D5); branch is a placeholder.
    return Promise.resolve({ path, branch: `${taskId}-${role}` });
  }

  async read(worktree: Worktree, path: string): Promise<string> {
    const target = this.assertInside(worktree, path);
    return readFileSync(target, 'utf8');
  }

  async write(worktree: Worktree, path: string, content: string): Promise<void> {
    const target = this.assertInside(worktree, path);
    mkdirSync(dirnameOf(target), { recursive: true });
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
    const name = basenameOf(root);
    const destination = join(TEARDOWN_STAGING, name);
    renameSync(root, destination);
    return Promise.resolve();
  }

  /**
   * Resolve `path` inside the worktree and reject any path that escapes it.
   * Enforces decision R7: file operations are confined to the sandbox dir.
   */
  private assertInside(worktree: Worktree, path: string): string {
    const root = resolve(worktree.path);
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`path escapes sandbox root: ${path}`);
    }
    accessSync(root, fsConstants.R_OK);
    return target;
  }
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

function dirnameOf(path: string): string {
  const last = path.lastIndexOf(sep);
  return last > 0 ? path.slice(0, last) : path;
}

function basenameOf(path: string): string {
  const last = path.lastIndexOf(sep);
  return last >= 0 ? path.slice(last + 1) : path;
}
