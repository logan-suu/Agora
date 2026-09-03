import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { WorktreeRegistry } from '@agora/tools-fs';
import { parseTap, type TapFailure } from './tap';

/** Default per-command timeout (decision R7: 30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Structured test-run outcome, matching `State.testResults`
 * (`{ passed, total, failed, failures[], coverage? }`).
 */
export interface TestRunResult {
  passed: boolean;
  total: number;
  failed: number;
  failures: TapFailure[];
  coverage?: number;
}

/** Runs a test command inside a registered worktree and returns a structured result. */
export interface TestService {
  run(root: string, cmd: string, timeoutMs?: number): Promise<TestRunResult>;
}

/**
 * Worktree-scoped test service (spec §6 `test-server`).
 *
 * The command is spawned with the *registered* worktree root as its cwd
 * (decision R7 / R9): the root must be on the {@link WorktreeRegistry}
 * allowlist and re-resolved to its canonical path so a retargeted symlink root
 * is rejected (mirrors fs-service's assertRegistered hardening). Output is
 * parsed as TAP; non-TAP output falls back to the exit code and is never
 * silently reported green.
 */
export class WorktreeTestService implements TestService {
  constructor(private readonly registry: WorktreeRegistry) {}

  async run(root: string, cmd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TestRunResult> {
    const canonicalRoot = this.assertRegistered(root);
    const { exitCode, stdout, stderr, timedOut } = await runInDir(canonicalRoot, cmd, timeoutMs);

    if (timedOut) {
      return timeoutResult(timeoutMs);
    }

    const summary = parseTap(stdout);
    if (summary.total > 0) {
      const passed = exitCode === 0 && summary.failed === 0;
      return {
        passed,
        total: summary.total,
        failed: summary.failed,
        failures: summary.failures.map((failure) => ({
          ...failure,
          file:
            failure.file === '' || isAbsolute(failure.file)
              ? failure.file
              : resolve(canonicalRoot, failure.file),
        })),
        ...(summary.coverage === undefined ? {} : { coverage: summary.coverage }),
      };
    }

    if (exitCode === 0) {
      return { passed: true, total: 0, failed: 0, failures: [] };
    }

    const tail = (stdout + stderr).trim().split('\n').slice(-8).join('\n');
    return {
      passed: false,
      total: 0,
      failed: 0,
      failures: [
        {
          test: `(exit ${exitCode})`,
          message: tail || `command exited with code ${exitCode}`,
          file: '',
          line: 0,
        },
      ],
    };
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

/** Structured non-passing result for a command that exceeded its timeout. */
function timeoutResult(timeoutMs: number): TestRunResult {
  return {
    passed: false,
    total: 0,
    failed: 0,
    failures: [
      {
        test: '(timeout)',
        message: `command timed out after ${timeoutMs}ms`,
        file: '',
        line: 0,
      },
    ],
  };
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runInDir(cwd: string, cmd: string, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolvePromise, reject) => {
    const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
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

/**
 * Terminate the child and its whole process tree. With `shell: true` the direct
 * child is a shell; `kill` alone would orphan the real test process and leak it
 * past the timeout. On POSIX the child is detached as a process-group leader, so
 * signaling the negative PID reaps the entire group. Windows has no
 * group-signal via `process.kill`, so it falls back to killing the shell only.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
