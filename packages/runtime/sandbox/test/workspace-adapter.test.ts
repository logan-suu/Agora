// Mock 原因（R11）：本文件只替换 Docker execution backend，以隔离验证复合 adapter
// 的所有权/绑定协议；Git 使用真实 WorktreeGitService + 真实 git 二进制。
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { WorktreeRegistry } from '@agora/tools-fs';
import { encodeGitIsolationKey, WorktreeGitService } from '@agora/tools-git';
import { afterEach, describe, expect, it } from 'vitest';

import type { WorkspaceExecutionBackend } from '../src/workspace-adapter';
import { WorkspaceAdapter } from '../src/workspace-adapter';

const execFileAsync = promisify(execFile);

async function gitCommand(path: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', path, ...args])).stdout;
}

class HostExecutionBackend implements WorkspaceExecutionBackend {
  readonly bindings = new Map<string, string>();

  async bindWorktree(_taskId: string, key: string, worktree: { path: string }, _taskRoot: string) {
    this.bindings.set(key, worktree.path);
  }
  read(worktree: { path: string }, path: string) {
    return readFile(join(worktree.path, path), 'utf8');
  }
  async write(worktree: { path: string }, path: string, content: string) {
    await writeFile(join(worktree.path, path), content, 'utf8');
  }
  async run() {
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
  async suspend() {}
  async teardown() {}
}

class FailOnceExecutionBackend extends HostExecutionBackend {
  #failed = false;

  override async bindWorktree(
    taskId: string,
    key: string,
    worktree: { path: string },
    taskRoot: string,
  ) {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error('injected bind failure');
    }
    await super.bindWorktree(taskId, key, worktree, taskRoot);
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agora-workspace-adapter-'));
  roots.push(dataRoot);
  const taskRoot = join(dataRoot, 'projects/project-a/tasks/task-a');
  await mkdir(taskRoot, { recursive: true });
  const registry = new WorktreeRegistry();
  const git = new WorktreeGitService(
    registry,
    join(taskRoot, 'repository'),
    join(taskRoot, 'worktrees'),
  );
  const execution = new HostExecutionBackend();
  const adapter = new WorkspaceAdapter({
    projectId: 'project-a',
    taskId: 'task-a',
    taskRoot,
    git,
    execution,
    encodeIsolationKey: encodeGitIsolationKey,
  });
  return { adapter, execution, git, taskRoot };
}

async function fixtureWithExecution(execution: WorkspaceExecutionBackend) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agora-workspace-adapter-'));
  roots.push(dataRoot);
  const taskRoot = join(dataRoot, 'projects/project-a/tasks/task-a');
  await mkdir(taskRoot, { recursive: true });
  const git = new WorktreeGitService(
    new WorktreeRegistry(),
    join(taskRoot, 'repository'),
    join(taskRoot, 'worktrees'),
  );
  const adapter = new WorkspaceAdapter({
    projectId: 'project-a',
    taskId: 'task-a',
    taskRoot,
    git,
    execution,
    encodeIsolationKey: encodeGitIsolationKey,
  });
  return { adapter, git };
}

describe('WorkspaceAdapter', () => {
  it('creates distinct deterministic linked worktrees for same-role workers and binds those exact paths', async () => {
    const { adapter, execution, taskRoot } = await fixture();
    const first = await adapter.createWorktree('task-a', 'worker:dispatch:0');
    const second = await adapter.createWorktree('task-a', 'worker:dispatch:1');
    const replay = await adapter.createWorktree('task-a', 'worker:dispatch:0');

    expect(first).toEqual(replay);
    expect(first.path).not.toBe(second.path);
    expect(first.branch).not.toBe(second.branch);
    expect(first.path.startsWith(join(taskRoot, 'worktrees'))).toBe(true);
    expect(execution.bindings.get('worker:dispatch:0')).toBe(first.path);
    await adapter.write(first, 'proof.txt', 'worker zero');
    await expect(adapter.read(first, 'proof.txt')).resolves.toBe('worker zero');
  });

  it('compensates a linked worktree when execution binding fails so the same worker can retry', async () => {
    const execution = new FailOnceExecutionBackend();
    const { adapter } = await fixtureWithExecution(execution);

    await expect(adapter.createWorktree('task-a', 'worker:dispatch:0')).rejects.toThrow(
      'injected bind failure',
    );
    const retried = await adapter.createWorktree('task-a', 'worker:dispatch:0');
    expect(execution.bindings.get('worker:dispatch:0')).toBe(retried.path);
  });

  it('merges only in its dedicated integration worktree and aborts on the first conflict', async () => {
    const { adapter, git } = await fixture();
    const first = await adapter.createWorktree('task-a', 'worker:dispatch:0');
    const second = await adapter.createWorktree('task-a', 'worker:dispatch:1');
    const baseCommit = await git.canonicalHead();
    const integration = await adapter.createIntegrationWorktree(
      'wave-1',
      'integration-1',
      baseCommit,
    );

    await writeFile(join(first.path, 'same.txt'), 'first\n');
    await gitCommand(first.path, 'add', '-A');
    await gitCommand(first.path, 'commit', '-m', 'first');
    await writeFile(join(second.path, 'same.txt'), 'second\n');
    await gitCommand(second.path, 'add', '-A');
    await gitCommand(second.path, 'commit', '-m', 'second');

    await expect(adapter.integrate(integration.branch, [first.branch])).resolves.toEqual({
      merged: true,
      conflicts: [],
    });
    await expect(adapter.integrate(integration.branch, [second.branch])).resolves.toEqual({
      merged: false,
      conflicts: ['same.txt'],
    });
    expect(await gitCommand(integration.path, 'status', '--porcelain')).toBe('');
  });
});
