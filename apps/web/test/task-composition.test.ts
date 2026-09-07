// Mock reason (R11): the first test injects only the SandboxManager port to force
// deterministic setup failure. Recovery cleanup uses the real LocalTempSandbox.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyMutations, createInitialAppState, mergeByIdMutation } from '@agora/core-domain';
import type {
  IntegrationResult,
  RunResult,
  SandboxManager,
  Worktree,
} from '@agora/runtime-sandbox';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { describe, expect, it } from 'vitest';

import {
  buildArtifactArchivePlan,
  createWebTaskCompositionFactory,
  materializeArtifactArchive,
  readArtifactArchiveReceipt,
} from '../src/server/task-composition';

class MissingWorktreeSandbox implements SandboxManager {
  teardownCalls = 0;

  async createWorktree(taskId: string, role: string): Promise<Worktree> {
    return { branch: `${taskId}-${role}`, path: `/missing/${taskId}` };
  }

  async read(): Promise<string> {
    throw new Error('not used');
  }

  async write(): Promise<void> {
    throw new Error('not used');
  }

  async run(): Promise<RunResult> {
    throw new Error('not used');
  }

  async integrate(): Promise<IntegrationResult> {
    throw new Error('not used');
  }

  async teardown(): Promise<void> {
    this.teardownCalls += 1;
  }
}

class RecordingLocalSandbox extends LocalTempSandbox {
  suspendCalls = 0;

  override async suspend(taskId: string): Promise<void> {
    this.suspendCalls += 1;
    await super.suspend(taskId);
  }
}

class RetryableSuspendSandbox extends LocalTempSandbox {
  suspendCalls = 0;

  override async suspend(taskId: string): Promise<void> {
    this.suspendCalls += 1;
    if (this.suspendCalls === 1) throw new Error('injected first suspend failure');
    await super.suspend(taskId);
  }
}

describe('createWebTaskCompositionFactory', () => {
  it('tears down an allocated sandbox worktree when setup fails', async () => {
    const sandbox = new MissingWorktreeSandbox();
    const createComposition = createWebTaskCompositionFactory({ sandbox });

    await expect(
      createComposition({
        scope: { projectId: 'project-a', taskId: 'task-a' },
        goal: 'Build safely',
        loadState: async () => undefined,
        transition: async (state) => state,
        handleOutput: async () => {},
        buildChannelContext: async () => [],
      }),
    ).rejects.toThrow();
    expect(sandbox.teardownCalls).toBe(1);
  });

  it('releases a resumed sandbox when safe-point restoration fails', async () => {
    const sandbox = new RecordingLocalSandbox();
    const scope = { projectId: 'project-a', taskId: 'task-resume-cleanup' };
    const worktree = await sandbox.createWorktree(scope.taskId, 'shared');
    const state = applyMutations(
      createInitialAppState(scope.taskId, 'Resume safely', scope.projectId),
      [
        mergeByIdMutation('subtasks', 'resume-subtask', {
          title: 'Resume safely',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
          worktree: worktree.path,
        }),
      ],
    );
    const createComposition = createWebTaskCompositionFactory({ sandbox });

    await expect(
      createComposition({
        scope,
        goal: state.goal,
        loadState: async () => state,
        transition: async (current) => current,
        handleOutput: async () => {},
        buildChannelContext: async () => [],
        resume: {
          state,
          actionId: 'restore-failure',
          receipt: {
            gateId: 'human-gate:restore-failure',
            option: 'retry',
            safePointRefs: ['not-a-safe-point'],
            resumeSessionId: 'human-gate-resume:restore-failure',
          },
        },
      }),
    ).rejects.toThrow(/safe point/i);
    expect(sandbox.suspendCalls).toBe(1);
    await sandbox.teardown(scope.taskId);
  });

  it('retries composition resource release after a transient suspend failure', async () => {
    const sandbox = new RetryableSuspendSandbox();
    const scope = { projectId: 'project-a', taskId: 'task-retry-suspend' };
    const composition = await createWebTaskCompositionFactory({ sandbox })({
      scope,
      goal: 'Retry cleanup',
      loadState: async () => undefined,
      transition: async (state) => state,
      handleOutput: async () => {},
      buildChannelContext: async () => [],
    });

    await expect(composition.suspend()).rejects.toThrow('injected first suspend failure');
    await expect(composition.suspend()).resolves.toBeUndefined();
    expect(sandbox.suspendCalls).toBe(2);
    await sandbox.teardown(scope.taskId);
  });
});

describe('buildArtifactArchivePlan', () => {
  it('preserves every distinct parallel worktree in a stable bundle', () => {
    const makeState = (ids: readonly string[]) =>
      applyMutations(
        createInitialAppState('task-a', 'Archive all outputs', 'project-a'),
        ids.map((id) =>
          mergeByIdMutation('subtasks', id, {
            title: id,
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'done',
            worktree: {
              path: `/worktrees/${id}`,
              branch: id,
              baseCommit: 'a'.repeat(40),
              headCommit: id === 'worker-a' ? 'b'.repeat(40) : 'c'.repeat(40),
            },
          }),
        ),
      );

    const forward = buildArtifactArchivePlan(
      makeState(['worker-a', 'worker-b']),
      '/canonical',
      '/artifacts/worktree',
    );
    const reversed = buildArtifactArchivePlan(
      makeState(['worker-b', 'worker-a']),
      '/canonical',
      '/artifacts/worktree',
    );

    expect(forward).toEqual(reversed);
    expect(forward.bundled).toBe(true);
    expect(forward.entries.map((entry) => entry.sourcePath)).toEqual([
      '/worktrees/worker-a',
      '/worktrees/worker-b',
    ]);
    expect(new Set(forward.entries.map((entry) => entry.archivedPath)).size).toBe(2);
  });

  it('archives only the canonical integration worktree after a completed merge', () => {
    const integrated = {
      path: '/worktrees/integration',
      branch: 'integration-wave-1',
      baseCommit: 'a'.repeat(40),
      headCommit: 'd'.repeat(40),
    };
    const state = {
      ...createInitialAppState('task-a', 'Archive integration', 'project-a'),
      integration: {
        integrationId: 'integration-1',
        waveId: 'wave-1',
        base: { branch: 'dev-1.0.0', commit: 'a'.repeat(40) },
        integrationWorktree: integrated,
        pendingBranches: [],
        mergedBranches: [],
        conflicts: [],
        resultCommit: 'd'.repeat(40),
        status: 'done' as const,
      },
    };

    const plan = buildArtifactArchivePlan(state, '/canonical', '/artifacts/worktree');

    expect(plan.bundled).toBe(false);
    expect(plan.entries).toEqual([
      {
        id: 'integration:integration-1',
        sourcePath: integrated.path,
        archivedPath: '/artifacts/worktree',
        relativePath: '',
        worktree: integrated,
      },
    ]);
  });

  it('materializes every bundled worktree and a stable manifest with real filesystem I/O', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-artifact-plan-'));
    try {
      const sourceA = join(root, 'source-a');
      const sourceB = join(root, 'source-b');
      await Promise.all([mkdir(sourceA, { recursive: true }), mkdir(sourceB, { recursive: true })]);
      await Promise.all([
        writeFile(join(sourceA, 'a.txt'), 'alpha', 'utf8'),
        writeFile(join(sourceB, 'b.txt'), 'beta', 'utf8'),
      ]);
      const state = applyMutations(createInitialAppState('task-a', 'Archive', 'project-a'), [
        mergeByIdMutation('subtasks', 'a', {
          title: 'a',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'done',
          worktree: sourceA,
        }),
        mergeByIdMutation('subtasks', 'b', {
          title: 'b',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'done',
          worktree: sourceB,
        }),
      ]);
      const plan = buildArtifactArchivePlan(
        state,
        join(root, 'canonical'),
        join(root, 'artifacts', 'worktree'),
      );

      const archived = await materializeArtifactArchive(plan);

      const [entryA, entryB] = plan.entries;
      if (entryA === undefined || entryB === undefined) throw new Error('bundle entries missing');
      await expect(readFile(join(entryA.archivedPath, 'a.txt'), 'utf8')).resolves.toBe('alpha');
      await expect(readFile(join(entryB.archivedPath, 'b.txt'), 'utf8')).resolves.toBe('beta');
      await expect(
        readFile(join(plan.destination, 'artifact-manifest.json'), 'utf8'),
      ).resolves.toContain('parallel-worktree-bundle');
      await expect(readArtifactArchiveReceipt(plan.destination)).resolves.toEqual(archived);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays the immutable first archive mapping instead of rebuilding it from later State', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-artifact-receipt-'));
    try {
      const firstSource = join(root, 'first');
      const laterSource = join(root, 'later');
      await Promise.all([
        mkdir(firstSource, { recursive: true }),
        mkdir(laterSource, { recursive: true }),
      ]);
      await writeFile(join(firstSource, 'result.txt'), 'first', 'utf8');
      const destination = join(root, 'artifacts', 'worktree');
      const firstPlan = buildArtifactArchivePlan(undefined, firstSource, destination);
      const first = await materializeArtifactArchive(firstPlan);
      const laterPlan = buildArtifactArchivePlan(undefined, laterSource, destination);

      expect(laterPlan.entries[0]?.sourcePath).toBe(laterSource);
      await expect(readArtifactArchiveReceipt(destination)).resolves.toEqual(first);
      await expect(readFile(join(destination, 'result.txt'), 'utf8')).resolves.toBe('first');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an existing archive has no valid receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-artifact-missing-receipt-'));
    try {
      const destination = join(root, 'artifacts', 'worktree');
      await mkdir(destination, { recursive: true });

      await expect(readArtifactArchiveReceipt(destination)).rejects.toThrow('missing');
      await writeFile(`${destination}.receipt.json`, '{broken', 'utf8');
      await expect(readArtifactArchiveReceipt(destination)).rejects.toThrow('valid JSON');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('orders archive candidates by direct code units without locale dependence', () => {
    const state = applyMutations(createInitialAppState('task-a', 'Archive', 'project-a'), [
      mergeByIdMutation('subtasks', 'Z', {
        title: 'uppercase',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'done',
        worktree: '/worktrees/uppercase',
      }),
      mergeByIdMutation('subtasks', 'a', {
        title: 'lowercase',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'done',
        worktree: '/worktrees/lowercase',
      }),
    ]);

    expect(
      buildArtifactArchivePlan(state, '/canonical', '/artifacts/worktree').entries.map(
        (entry) => entry.sourcePath,
      ),
    ).toEqual(['/worktrees/uppercase', '/worktrees/lowercase']);
  });
});
