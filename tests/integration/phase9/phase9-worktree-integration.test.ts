// R11：仅外部 LLM 不在本验收范围；本文件不 mock Git、Docker、文件系统或
// IntegrationService。测试使用真实 linked worktree、真实 git merge/abort 与真实容器 bind mount。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  type WorktreeRef,
} from '@agora/core-domain';
import { IntegrationService } from '@agora/core-orchestration';
import { Dockerode, DockerSandbox, WorkspaceAdapter } from '@agora/runtime-sandbox';
import { WorktreeRegistry } from '@agora/tools-fs';
import { encodeGitIsolationKey, WorktreeGitService } from '@agora/tools-git';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const adapters: { adapter: WorkspaceAdapter; taskId: string }[] = [];

function connectDocker(): Dockerode | null {
  const candidates = [
    process.env.DOCKER_HOST,
    '/var/run/docker.sock',
    join(process.env.HOME ?? '', '.docker/run/docker.sock'),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (candidate.startsWith('unix://') || candidate.startsWith('http://')) return new Dockerode();
    if (existsSync(candidate)) return new Dockerode({ socketPath: candidate });
  }
  return null;
}

const docker = connectDocker();
const describeDocker = docker === null ? describe.skip : describe;

async function git(path: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', path, ...args])).stdout.trim();
}

async function commit(adapter: WorkspaceAdapter, ref: WorktreeRef, file: string, content: string) {
  await adapter.write(ref, file, content);
  await git(ref.path, 'add', '-A');
  await git(ref.path, 'commit', '-m', `Write ${file}`);
  return adapter.refreshWorktree(ref);
}

async function fixture(taskId: string) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agora-phase9-workspace-'));
  roots.push(dataRoot);
  const taskRoot = join(dataRoot, 'projects/project-a/tasks', taskId);
  await mkdir(taskRoot, { recursive: true });
  const registry = new WorktreeRegistry();
  const gitService = new WorktreeGitService(
    registry,
    join(taskRoot, 'repository'),
    join(taskRoot, 'worktrees'),
  );
  const adapter = new WorkspaceAdapter({
    projectId: 'project-a',
    taskId,
    taskRoot,
    git: gitService,
    execution: new DockerSandbox({ docker: docker as Dockerode, baseDir: dataRoot }),
    encodeIsolationKey: encodeGitIsolationKey,
  });
  adapters.push({ adapter, taskId });
  return { adapter, gitService, taskRoot };
}

async function allocate(adapter: WorkspaceAdapter, taskId: string, workerId: string) {
  await adapter.createWorktree(taskId, workerId);
  const ref = adapter.worktreeFor(workerId);
  if (ref === undefined) throw new Error(`worker worktree allocation failed: ${workerId}`);
  return ref;
}

function integrationState(
  taskId: string,
  workers: readonly { workerId: string; subtaskId: string; ref: WorktreeRef }[],
) {
  return applyMutations(
    createInitialAppState(taskId, 'parallel worktree integration', 'project-a'),
    [
      ...workers.map(({ subtaskId, ref }) =>
        mergeByIdMutation('subtasks', subtaskId, {
          title: subtaskId,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'done',
          worktree: ref,
        }),
      ),
      ...workers.map(({ workerId, subtaskId, ref }, index) =>
        mergeByIdMutation('workers', workerId, {
          workerId,
          role: 'CODER',
          executor: 'harness',
          status: 'done',
          subtaskId,
          worktree: ref,
          startedTs: index + 1,
        }),
      ),
    ],
  );
}

afterEach(async () => {
  for (const { adapter, taskId } of adapters.splice(0)) {
    await adapter.teardown(taskId).catch(() => undefined);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeDocker('Phase 9 task-owned worktree integration (G5)', () => {
  it('binds each worker Git path into Docker and persists a recoverable dedicated integration result', async () => {
    const { adapter, gitService, taskRoot } = await fixture('phase9-ok');
    const first = await allocate(adapter, 'phase9-ok', 'worker:dispatch:0');
    const second = await allocate(adapter, 'phase9-ok', 'worker:dispatch:1');

    expect((await adapter.run(first, 'pwd')).stdout.trim()).toBe(
      `/workspace/worktrees/${basename(first.path)}`,
    );
    const committedFirst = await commit(adapter, first, 'first.txt', 'first\n');
    const committedSecond = await commit(adapter, second, 'second.txt', 'second\n');
    let state = integrationState('phase9-ok', [
      { workerId: 'worker:dispatch:0', subtaskId: 'st-0', ref: committedFirst },
      { workerId: 'worker:dispatch:1', subtaskId: 'st-1', ref: committedSecond },
    ]);
    const persistedStatuses: string[] = [];
    const service = new IntegrationService(adapter, async (_current, mutations) => {
      state = applyMutations(state, mutations);
      persistedStatuses.push(state.integration?.status ?? 'missing');
      return state;
    });

    const result = await service.integrateWave(state, {
      waveId: 'wave-1',
      workerIds: ['worker:dispatch:1', 'worker:dispatch:0'],
      baseBranch: await gitService.canonicalBranch(),
    });

    expect(result.gateRequest).toBeUndefined();
    expect(result.state.integration).toMatchObject({ status: 'done', conflicts: [] });
    expect(result.state.integration?.mergedBranches.map((entry) => entry.workerId)).toEqual([
      'worker:dispatch:0',
      'worker:dispatch:1',
    ]);
    expect(persistedStatuses).toEqual(['merging', 'merging', 'merging', 'done']);
    const integrated = result.state.integration?.integrationWorktree;
    if (integrated === undefined) throw new Error('integration worktree is missing');
    await expect(adapter.read(integrated, 'first.txt')).resolves.toBe('first\n');
    await expect(adapter.read(integrated, 'second.txt')).resolves.toBe('second\n');
    await adapter.teardown('phase9-ok');
    adapters.splice(
      adapters.findIndex((entry) => entry.adapter === adapter),
      1,
    );
    expect(existsSync(join(taskRoot, 'repository'))).toBe(true);
  }, 30_000);

  it('aborts a real merge conflict and emits the deterministic request_rework gate', async () => {
    const { adapter } = await fixture('phase9-conflict');
    const first = await allocate(adapter, 'phase9-conflict', 'worker:dispatch:0');
    const second = await allocate(adapter, 'phase9-conflict', 'worker:dispatch:1');
    const committedFirst = await commit(adapter, first, 'same.txt', 'first\n');
    const committedSecond = await commit(adapter, second, 'same.txt', 'second\n');
    let state = integrationState('phase9-conflict', [
      { workerId: 'worker:dispatch:0', subtaskId: 'st-0', ref: committedFirst },
      { workerId: 'worker:dispatch:1', subtaskId: 'st-1', ref: committedSecond },
    ]);
    const service = new IntegrationService(adapter, async (_current, mutations) => {
      state = applyMutations(state, mutations);
      return state;
    });

    const result = await service.integrateWave(state, {
      waveId: 'wave-conflict',
      workerIds: ['worker:dispatch:0', 'worker:dispatch:1'],
      now: 123,
    });

    expect(result.state.integration).toMatchObject({
      status: 'conflict',
      conflicts: [{ workerId: 'worker:dispatch:1', files: ['same.txt'] }],
    });
    expect(result.gateRequest).toMatchObject({
      reason: `integration_conflict:${result.state.integration?.integrationId}`,
      options: ['request_rework'],
      triggerTs: 123,
    });
    const integrated = result.state.integration?.integrationWorktree;
    if (integrated === undefined) throw new Error('integration worktree is missing');
    expect(await git(integrated.path, 'status', '--porcelain')).toBe('');
  }, 30_000);
});
