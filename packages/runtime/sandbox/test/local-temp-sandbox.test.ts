import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Worktree } from '../src/index';
import { LocalTempSandbox } from '../src/index';

// Real-execution tests (R11/G5): genuine temp dirs + genuine subprocesses, no mocks.

const sandbox = new LocalTempSandbox();

const createdTaskIds: string[] = [];

afterEach(() => {
  // Best-effort cleanup of any worktrees not torn down by the test itself.
  for (const taskId of createdTaskIds) {
    sandbox.teardown(taskId);
  }
  createdTaskIds.length = 0;
});

async function makeWorktree(taskId = 'task-1', role = 'CODER'): Promise<Worktree> {
  const wt = await sandbox.createWorktree(taskId, role);
  createdTaskIds.push(taskId);
  return wt;
}

describe('LocalTempSandbox', () => {
  it('createWorktree returns a real isolated temp directory under the OS temp dir', async () => {
    const wt = await makeWorktree('task-a', 'CODER');
    expect(wt.path.startsWith(tmpdir())).toBe(true);
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.branch).toBe('task-a-CODER');
  });

  it('createWorktree gives each worker an isolated directory', async () => {
    const a = await makeWorktree('task-b', 'CODER');
    const b = await makeWorktree('task-b', 'TESTER');
    expect(a.path).not.toBe(b.path);
  });

  it('write then read round-trips content including nested paths', async () => {
    const wt = await makeWorktree();
    await sandbox.write(wt, 'src/lru.ts', 'export const cache = 1;');
    const content = await sandbox.read(wt, 'src/lru.ts');
    expect(content).toBe('export const cache = 1;');
  });

  it('write overwrites existing content', async () => {
    const wt = await makeWorktree();
    await sandbox.write(wt, 'a.txt', 'first');
    await sandbox.write(wt, 'a.txt', 'second');
    expect(await sandbox.read(wt, 'a.txt')).toBe('second');
  });

  it('read rejects a missing file', async () => {
    const wt = await makeWorktree();
    await expect(sandbox.read(wt, 'nope.txt')).rejects.toThrow();
  });

  it('read rejects paths escaping the sandbox root (R7 path confinement)', async () => {
    const wt = await makeWorktree();
    await expect(sandbox.read(wt, '../../etc/passwd')).rejects.toThrow(/escapes sandbox root/);
  });

  it('write rejects paths escaping the sandbox root (R7 path confinement)', async () => {
    const wt = await makeWorktree();
    await expect(sandbox.write(wt, '../../evil.txt', 'x')).rejects.toThrow(/escapes sandbox root/);
  });

  it('run executes a real command and captures stdout and exit code', async () => {
    const wt = await makeWorktree();
    const result = await sandbox.run(wt, 'echo hello-sandbox');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello-sandbox');
    expect(result.timedOut).toBe(false);
  });

  it('run reports a non-zero exit code for a failing command', async () => {
    const wt = await makeWorktree();
    const result = await sandbox.run(wt, 'node -e "process.exit(3)"');
    expect(result.exitCode).toBe(3);
  });

  it('run captures stderr', async () => {
    const wt = await makeWorktree();
    const result = await sandbox.run(wt, 'node -e "console.error(\'boom\')"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('boom');
  });

  it('run enforces a timeout and kills the process (R7 30s default, overridable)', async () => {
    const wt = await makeWorktree();
    const startedAt = Date.now();
    const result = await sandbox.run(wt, 'sleep 5', 200);
    const elapsed = Date.now() - startedAt;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });

  it('integrate is explicitly not implemented in Phase 0 (decision D5)', async () => {
    await expect(sandbox.integrate('base', ['b1', 'b2'])).rejects.toThrow(
      /not implemented in Phase 0/,
    );
  });

  it('teardown moves the sandbox dir to the staging area and is idempotent', async () => {
    const taskId = 'task-teardown';
    const wt = await sandbox.createWorktree(taskId, 'CODER');
    const original = wt.path;
    await sandbox.write(wt, 'keep.txt', 'data');
    await sandbox.teardown(taskId);

    // Original dir is gone (moved, not deleted in place).
    expect(existsSync(original)).toBe(false);
    // The file survives in the staging/trash area (file protection, move not delete).
    expect(existsSync(join(tmpdir(), 'agora-sandbox-trash', basename(original), 'keep.txt'))).toBe(
      true,
    );

    // Second teardown of an unknown task is a no-op.
    await expect(sandbox.teardown('never-created')).resolves.toBeUndefined();
  });
});
