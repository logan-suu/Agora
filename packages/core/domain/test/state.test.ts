import { describe, expect, it } from 'vitest';
import type { AppState, Integration, WorktreeRef } from '../src/index';
import { createInitialAppState, isIntegration, isWorktreeRef } from '../src/index';

const WORKTREE: WorktreeRef = {
  path: '/data/tasks/task-2/worktrees/worker-a',
  branch: 'worker-a-abc123',
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
};

describe('createInitialAppState', () => {
  it('seeds the Phase 0 slice with defaults and omits optional keys entirely', () => {
    const state = createInitialAppState('task-1', '实现带 TTL 的 LRU 缓存');
    expect(state.projectId).toBe('default');
    expect(state.taskId).toBe('task-1');
    expect(state.goal).toBe('实现带 TTL 的 LRU 缓存');
    expect(state.phase).toBe('clarifying');
    expect(state.iterationCount).toBe(0);
    expect(state.subtasks).toEqual([]);
    expect(state.workers).toEqual([]);
    expect(state.messages).toEqual([]);
    expect('integration' in state).toBe(false);
    expect('conventions' in state).toBe(false);
    expect('testResults' in state).toBe(false);
    expect('nextRole' in state).toBe(false);
  });

  it('accepts a minimal valid AppState shaped for the Phase 0 slice', () => {
    const state: AppState = {
      projectId: 'project-a',
      taskId: 'task-2',
      goal: 'goal',
      phase: 'coding',
      iterationCount: 1,
      workers: [],
      subtasks: [
        { id: 'st-1', title: 'lru', ownerRole: 'CODER', dependsOn: [], status: 'in_progress' },
      ],
      messages: [],
      objections: [],
      requirements: [],
      reviewComments: [],
      handoffPackets: [],
      decisionLedger: [],
      nextRole: 'TESTER',
    };
    expect(state.subtasks[0]?.ownerRole).toBe('CODER');
    expect(state.nextRole).toBe('TESTER');
  });

  it('accepts an explicit project scope', () => {
    expect(createInitialAppState('task-3', 'goal', 'project-b').projectId).toBe('project-b');
  });

  it('validates structured worktree and recoverable integration identities', () => {
    const integration: Integration = {
      integrationId: 'integration-1',
      waveId: 'wave-1',
      base: { branch: 'base', commit: 'a'.repeat(40) },
      integrationWorktree: {
        path: WORKTREE.path,
        branch: 'integration-1',
        baseCommit: WORKTREE.baseCommit,
        headCommit: WORKTREE.baseCommit,
      },
      pendingBranches: [
        {
          workerId: 'worker:dispatch:0',
          subtaskId: 'st-1',
          worktree: WORKTREE,
          topologicalRank: 0,
        },
      ],
      mergedBranches: [],
      conflicts: [],
      status: 'merging',
    };

    expect(isWorktreeRef(WORKTREE)).toBe(true);
    expect(isIntegration(integration)).toBe(true);
    expect(isWorktreeRef({ ...WORKTREE, branch: 'worker:bad' })).toBe(false);
    expect(isWorktreeRef({ ...WORKTREE, branch: 'worker.lock' })).toBe(false);
    expect(isWorktreeRef({ ...WORKTREE, branch: '@' })).toBe(false);
    expect(
      isIntegration({
        ...integration,
        pendingBranches: [...integration.pendingBranches, integration.pendingBranches[0]],
      }),
    ).toBe(false);
  });

  it('rejects cross-paired, out-of-order, conflicted, and incomplete Integration progress', () => {
    const secondWorktree: WorktreeRef = {
      ...WORKTREE,
      path: '/data/tasks/task-2/worktrees/worker-b',
      branch: 'worker-b-abc123',
      headCommit: 'c'.repeat(40),
    };
    const pendingBranches = [
      {
        workerId: 'worker:dispatch:0',
        subtaskId: 'st-1',
        worktree: WORKTREE,
        topologicalRank: 0,
      },
      {
        workerId: 'worker:dispatch:1',
        subtaskId: 'st-2',
        worktree: secondWorktree,
        topologicalRank: 0,
      },
    ];
    const base: Integration = {
      integrationId: 'integration-1',
      waveId: 'wave-1',
      base: { branch: 'main', commit: WORKTREE.baseCommit },
      integrationWorktree: {
        path: '/data/tasks/task-2/worktrees/integration',
        branch: 'integration-1',
        baseCommit: WORKTREE.baseCommit,
        headCommit: WORKTREE.baseCommit,
      },
      pendingBranches,
      mergedBranches: [],
      conflicts: [],
      status: 'merging',
    };
    const firstPending = pendingBranches[0];
    const secondPending = pendingBranches[1];
    if (firstPending === undefined || secondPending === undefined) {
      throw new Error('expected two pending branches');
    }
    const mergedFirst = {
      workerId: firstPending.workerId,
      subtaskId: firstPending.subtaskId,
      branch: WORKTREE.branch,
      headCommit: WORKTREE.headCommit as string,
      mergeCommit: 'd'.repeat(40),
    };

    expect(
      isIntegration({
        ...base,
        integrationWorktree: { ...base.integrationWorktree, headCommit: mergedFirst.mergeCommit },
        mergedBranches: [{ ...mergedFirst, subtaskId: 'st-2' }],
      }),
    ).toBe(false);
    expect(
      isIntegration({
        ...base,
        integrationWorktree: { ...base.integrationWorktree, headCommit: 'e'.repeat(40) },
        mergedBranches: [
          {
            workerId: secondPending.workerId,
            subtaskId: secondPending.subtaskId,
            branch: secondWorktree.branch,
            headCommit: secondWorktree.headCommit as string,
            mergeCommit: 'e'.repeat(40),
          },
        ],
      }),
    ).toBe(false);
    expect(
      isIntegration({
        ...base,
        conflicts: [
          {
            workerId: secondPending.workerId,
            subtaskId: firstPending.subtaskId,
            branch: secondWorktree.branch,
            headCommit: secondWorktree.headCommit as string,
            files: ['same.ts'],
          },
        ],
        status: 'conflict',
      }),
    ).toBe(false);
    expect(isIntegration({ ...base, status: 'done', resultCommit: WORKTREE.baseCommit })).toBe(
      false,
    );
  });
});
