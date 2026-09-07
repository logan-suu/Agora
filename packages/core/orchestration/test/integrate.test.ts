// Mock 原因（R11）：单元测试替换 workspace I/O 端口，以精确模拟“Git 已成功但 State
// 响应丢失”和冲突；真实 Git/worktree/abort 链由 Phase 9 集成测试覆盖。
import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import { IntegrationService, type IntegrationWorkspacePort } from '../src/integrate';

const BASE = 'a'.repeat(40);
const HEAD_A = 'b'.repeat(40);
const HEAD_B = 'c'.repeat(40);
const MERGE_A = 'd'.repeat(40);
const MERGE_B = 'e'.repeat(40);

function worktree(worker: string, headCommit: string) {
  return { path: `/data/task/worktrees/${worker}`, branch: worker, baseCommit: BASE, headCommit };
}

function state() {
  return applyMutations(createInitialAppState('task-a', 'parallel', 'project-a'), [
    mergeByIdMutation('subtasks', 'st-b', {
      title: 'b',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'in_progress',
      worktree: worktree('worker-b', HEAD_B),
    }),
    mergeByIdMutation('subtasks', 'st-a', {
      title: 'a',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'in_progress',
      worktree: worktree('worker-a', HEAD_A),
    }),
    mergeByIdMutation('workers', 'worker-b', {
      workerId: 'worker-b',
      role: 'CODER',
      executor: 'harness',
      status: 'done',
      subtaskId: 'st-b',
      worktree: worktree('worker-b', HEAD_B),
      startedTs: 2,
    }),
    mergeByIdMutation('workers', 'worker-a', {
      workerId: 'worker-a',
      role: 'CODER',
      executor: 'harness',
      status: 'done',
      subtaskId: 'st-a',
      worktree: worktree('worker-a', HEAD_A),
      startedTs: 1,
    }),
  ]);
}

class FakeWorkspace implements IntegrationWorkspacePort {
  head = BASE;
  readonly merged: string[] = [];
  conflictBranch?: string;

  async createIntegrationWorktree(_waveId: string, _integrationId: string, baseCommit: string) {
    this.head = baseCommit;
    return { path: '/data/task/worktrees/integration', branch: 'integration-wave', baseCommit };
  }
  async refreshWorktree(ref: ReturnType<typeof worktree>) {
    if (ref.branch === 'integration-wave') return { ...ref, headCommit: this.head };
    return { ...ref };
  }
  async integrate(_base: string, branches: string[]) {
    const branch = branches[0] as string;
    this.merged.push(branch);
    if (branch === this.conflictBranch) return { merged: false, conflicts: ['same.ts'] };
    this.head = branch === 'worker-a' ? MERGE_A : MERGE_B;
    return { merged: true, conflicts: [] };
  }
  async isAncestor(ancestor: string, descendant: string) {
    return (
      ancestor === descendant ||
      (ancestor === BASE && [MERGE_A, MERGE_B].includes(descendant)) ||
      (ancestor === HEAD_A && [MERGE_A, MERGE_B].includes(descendant)) ||
      (ancestor === HEAD_B && descendant === MERGE_B)
    );
  }
  async parentsOf(commit: string) {
    if (commit === MERGE_A) return [BASE, HEAD_A];
    if (commit === MERGE_B) return [MERGE_A, HEAD_B];
    return [];
  }
  async resetIntegration(ref: ReturnType<typeof worktree>, baseCommit: string) {
    this.head = baseCommit;
    return { ...ref, baseCommit, headCommit: baseCommit };
  }
}

describe('IntegrationService', () => {
  it('sorts a wave stably and persists progress after each successful merge', async () => {
    const workspace = new FakeWorkspace();
    const commits: string[][] = [];
    const service = new IntegrationService(workspace, async (current, mutations) => {
      commits.push(mutations.map((mutation) => `${mutation.op}:${mutation.field}`));
      return applyMutations(current, mutations);
    });

    const result = await service.integrateWave(state(), {
      waveId: 'wave-1',
      workerIds: ['worker-b', 'worker-a'],
    });

    expect(workspace.merged).toEqual(['worker-a', 'worker-b']);
    expect(result.gateRequest).toBeUndefined();
    expect(result.state.integration).toMatchObject({ status: 'done', resultCommit: MERGE_B });
    expect(result.state.integration?.mergedBranches.map((entry) => entry.workerId)).toEqual([
      'worker-a',
      'worker-b',
    ]);
    expect(commits).toHaveLength(4); // initialize + each merge + done
  });

  it('persists conflict metadata and returns a deterministic Leader gate request', async () => {
    const workspace = new FakeWorkspace();
    workspace.conflictBranch = 'worker-b';
    const service = new IntegrationService(workspace, async (current, mutations) =>
      applyMutations(current, mutations),
    );

    const result = await service.integrateWave(state(), {
      waveId: 'wave-1',
      workerIds: ['worker-a', 'worker-b'],
      now: 123,
    });

    expect(result.state.integration).toMatchObject({
      status: 'conflict',
      conflicts: [{ workerId: 'worker-b', subtaskId: 'st-b', files: ['same.ts'] }],
    });
    expect(result.gateRequest).toEqual({
      triggerMsgId: result.state.integration?.integrationId,
      triggerTs: 123,
      reason: `integration_conflict:${result.state.integration?.integrationId}`,
      options: ['request_rework'],
      phase: 'integrating',
    });
  });

  it('replaces an idle conflicted plan with a new integration identity while preserving its base', async () => {
    const workspace = new FakeWorkspace();
    let current = state();
    const service = new IntegrationService(workspace, async (_state, mutations) => {
      current = applyMutations(current, mutations);
      return current;
    });
    const first = await service.integrateWave(current, {
      waveId: 'wave-1',
      workerIds: ['worker-a'],
    });
    const original = first.state.integration;
    if (original === undefined) throw new Error('expected original integration');
    current = applyMutations(first.state, [
      setMutation('integration', {
        ...original,
        status: 'idle',
        resultCommit: undefined,
        mergedBranches: [],
      }),
    ]);

    const replanned = await service.integrateWave(current, {
      waveId: 'wave-1-rework',
      workerIds: ['worker-a', 'worker-b'],
    });

    expect(replanned.state.integration?.integrationId).not.toBe(original.integrationId);
    expect(replanned.state.integration).toMatchObject({
      status: 'done',
      base: { commit: BASE },
    });
  });

  it('recovers exactly one merge whose State response was lost', async () => {
    const initialWorkspace = new FakeWorkspace();
    const initialService = new IntegrationService(initialWorkspace, async (current, mutations) =>
      applyMutations(current, mutations),
    );
    const completed = await initialService.integrateWave(state(), {
      waveId: 'wave-1',
      workerIds: ['worker-a', 'worker-b'],
    });
    const integration = completed.state.integration;
    if (integration === undefined) throw new Error('expected Integration');
    const { resultCommit: _resultCommit, ...inProgress } = integration;
    const stale = {
      ...completed.state,
      integration: {
        ...inProgress,
        integrationWorktree: { ...integration.integrationWorktree, headCommit: BASE },
        mergedBranches: [],
        conflicts: [],
        status: 'merging' as const,
      },
    };
    const workspace = new FakeWorkspace();
    workspace.head = MERGE_A;
    const service = new IntegrationService(workspace, async (current, mutations) =>
      applyMutations(current, mutations),
    );

    const recovered = await service.integrateWave(stale, {
      waveId: 'wave-1',
      workerIds: ['worker-a', 'worker-b'],
    });

    expect(workspace.merged).toEqual(['worker-b']);
    expect(recovered.state.integration).toMatchObject({ status: 'done', resultCommit: MERGE_B });
  });

  it('fails closed when the actual integration HEAD already contains a later pending branch', async () => {
    const initialWorkspace = new FakeWorkspace();
    const initialService = new IntegrationService(initialWorkspace, async (current, mutations) =>
      applyMutations(current, mutations),
    );
    const completed = await initialService.integrateWave(state(), {
      waveId: 'wave-1',
      workerIds: ['worker-a', 'worker-b'],
    });
    const integration = completed.state.integration;
    if (integration === undefined) throw new Error('expected Integration');
    const { resultCommit: _resultCommit, ...inProgress } = integration;
    const stale = {
      ...completed.state,
      integration: {
        ...inProgress,
        integrationWorktree: { ...integration.integrationWorktree, headCommit: BASE },
        mergedBranches: [],
        conflicts: [],
        status: 'merging' as const,
      },
    };
    const workspace = new FakeWorkspace();
    workspace.head = MERGE_B;
    const service = new IntegrationService(workspace, async (current, mutations) =>
      applyMutations(current, mutations),
    );

    await expect(
      service.integrateWave(stale, {
        waveId: 'wave-1',
        workerIds: ['worker-a', 'worker-b'],
      }),
    ).rejects.toThrow('drifted');
  });
});
