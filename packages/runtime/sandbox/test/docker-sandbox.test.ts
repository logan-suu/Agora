import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Dockerode from 'dockerode';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerSandbox } from '../src/docker-sandbox';
import type { Worktree } from '../src/types';

// G5 real-execution tests: genuine Docker containers (create/exec/stop/remove),
// no mocks (R11). Skipped when the daemon is unreachable, mirroring the
// DEEPSEEK_API_KEY skip pattern for environment-gated live-LLM tests.

const DOCKER_SOCKETS = [
  process.env.DOCKER_HOST,
  '/var/run/docker.sock',
  join(process.env.HOME ?? '', '.docker/run/docker.sock'),
].filter((p): p is string => Boolean(p));

function connectDocker(): Dockerode | null {
  for (const socket of DOCKER_SOCKETS) {
    if (socket.startsWith('unix://') || socket.startsWith('http://')) {
      // DOCKER_HOST style: dockerode reads it directly.
      return new Dockerode();
    }
    if (existsSync(socket)) {
      return new Dockerode({ socketPath: socket });
    }
  }
  return null;
}

const docker = connectDocker();
const describeDocker = docker === null ? describe.skip : describe;

describeDocker('DockerSandbox (G5 real Docker execution)', () => {
  const sandbox = new DockerSandbox(docker === null ? {} : { docker });
  const createdTaskIds: string[] = [];

  afterEach(async () => {
    for (const taskId of createdTaskIds.splice(0)) {
      await sandbox.teardown(taskId);
    }
  });

  async function makeWorktree(taskId: string, role = 'CODER'): Promise<Worktree> {
    const wt = await sandbox.createWorktree(taskId, role);
    createdTaskIds.push(taskId);
    return wt;
  }

  it('createWorktree creates a real host dir inside a running container task root', async () => {
    const wt = await makeWorktree('docker-task-a', 'CODER');
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.path.startsWith(tmpdir())).toBe(true);
    expect(wt.branch).toBe('docker-task-a-CODER');
  });

  it('reuses ONE container per task and isolates roles into separate dirs', async () => {
    const a = await makeWorktree('docker-task-b', 'CODER');
    const b = await makeWorktree('docker-task-b', 'TESTER');
    expect(a.path).not.toBe(b.path);
    expect(a.path.startsWith(join(tmpdir(), 'agora-docker-docker-task-b'))).toBe(true);
  });

  it('write then read round-trips content including nested paths', async () => {
    const wt = await makeWorktree('docker-task-c', 'CODER');
    await sandbox.write(wt, 'src/lru.ts', 'export const cache = 1;');
    const content = await sandbox.read(wt, 'src/lru.ts');
    expect(content).toBe('export const cache = 1;');
  });

  it('write overwrites existing content', async () => {
    const wt = await makeWorktree('docker-task-d', 'CODER');
    await sandbox.write(wt, 'a.txt', 'first');
    await sandbox.write(wt, 'a.txt', 'second');
    expect(await sandbox.read(wt, 'a.txt')).toBe('second');
  });

  it('read rejects paths escaping the sandbox root (R7 path confinement)', async () => {
    const wt = await makeWorktree('docker-task-e', 'CODER');
    await expect(sandbox.read(wt, '../../etc/passwd')).rejects.toThrow(/escapes sandbox root/);
  });

  it('run executes a real command inside the container and captures stdout', async () => {
    const wt = await makeWorktree('docker-task-f', 'CODER');
    const result = await sandbox.run(wt, 'echo hello-docker-sandbox');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello-docker-sandbox');
    expect(result.timedOut).toBe(false);
  });

  it('run sees the node runtime of the container image (node:20-slim)', async () => {
    const wt = await makeWorktree('docker-task-g', 'CODER');
    const result = await sandbox.run(wt, 'node --version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^v20\./);
  });

  it('run reports a non-zero exit code for a failing command', async () => {
    const wt = await makeWorktree('docker-task-h', 'CODER');
    const result = await sandbox.run(wt, 'node -e "process.exit(3)"');
    expect(result.exitCode).toBe(3);
  });

  it('run captures stderr', async () => {
    const wt = await makeWorktree('docker-task-i', 'CODER');
    const result = await sandbox.run(wt, 'node -e "console.error(\'boom\')"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('boom');
  });

  it('run can see files written via write (bind-mount shared truth)', async () => {
    const wt = await makeWorktree('docker-task-j', 'CODER');
    await sandbox.write(wt, 'greet.js', 'console.log("hi from bind mount");');
    const result = await sandbox.run(wt, 'node greet.js');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi from bind mount');
  });

  it('run enforces a timeout and kills only the exec, container stays usable (R7)', async () => {
    const wt = await makeWorktree('docker-task-k', 'CODER');
    const startedAt = Date.now();
    const result = await sandbox.run(wt, 'sleep 5', 1000);
    const elapsed = Date.now() - startedAt;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(elapsed).toBeLessThan(5000);
    // Regression (CodeRabbit PR#17): the timeout must kill only the exec process
    // group, NOT the whole container — later runs on the same task must work.
    const after = await sandbox.run(wt, 'echo container-alive');
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain('container-alive');
    expect(after.timedOut).toBe(false);
  }, 15_000);

  it('concurrent createWorktree for the same new task shares ONE container', async () => {
    const taskId = 'docker-task-concurrent';
    const [a, b] = await Promise.all([
      sandbox.createWorktree(taskId, 'CODER'),
      sandbox.createWorktree(taskId, 'TESTER'),
    ]);
    createdTaskIds.push(taskId);
    expect(a.path).not.toBe(b.path);
    // Both roles live under the SAME host root → a single per-task container.
    expect(dirname(a.path)).toBe(dirname(b.path));
    // Both worktrees resolve to the one record (recordFor must not throw).
    await sandbox.write(a, 'shared.txt', 'one-container');
    expect(await sandbox.read(a, 'shared.txt')).toBe('one-container');
  }, 15_000);

  it('integrate is explicitly not implemented in Phase 1 (git semantics in tools/git)', async () => {
    await expect(sandbox.integrate('base', ['b1', 'b2'])).rejects.toThrow(
      /not implemented in Phase 1/,
    );
  });

  it('teardown stops and removes the container and is idempotent', async () => {
    const taskId = 'docker-task-teardown';
    const wt = await sandbox.createWorktree(taskId, 'CODER');
    const original = wt.path;
    await sandbox.write(wt, 'keep.txt', 'data');
    await sandbox.teardown(taskId);
    expect(existsSync(original)).toBe(false);
    await expect(sandbox.teardown('never-created')).resolves.toBeUndefined();
  });
});
