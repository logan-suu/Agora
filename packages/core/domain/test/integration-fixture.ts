// Pure State fixture shared by integration control tests.
import { type AppState, createInitialAppState } from '../src/state';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('missing fixture value');
  return value;
}

export const base = { branch: 'initial', commit: 'a'.repeat(40) };
export function fixture(ids = ['A', 'B']): AppState {
  const state = createInitialAppState('task', 'Integrate current wave', 'project');
  state.phase = 'integrating';
  state.subtasks = ids.map((id) => ({
    id,
    title: id,
    ownerRole: 'CODER',
    dependsOn: [],
    status: 'in_progress',
    worktree: {
      path: `/owned/${id}`,
      branch: id,
      baseCommit: base.commit,
      headCommit: id.toLowerCase().repeat(40),
    },
  }));
  state.workers = state.subtasks.map((task) => ({
    workerId: `worker-${task.id}`,
    role: 'CODER',
    subtaskId: task.id,
    executor: 'harness',
    status: 'done',
    startedTs: 1,
    sessionId: `session-${task.id}`,
    worktree: structuredClone(required(task.worktree)),
  }));
  state.messages = [
    {
      msgId: 'plan',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 1,
      display: 'Plan',
      payload: {
        kind: 'execution_plan',
        plan: { version: 1, subtasks: ids.map((id) => ({ id, title: id, dependsOn: [] })) },
      },
    },
    {
      msgId: 'wave',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 2,
      display: 'Wave',
      payload: {
        kind: 'coding_wave',
        planId: 'plan',
        nextRole: 'CODER',
        attempt: 1,
        base,
        subtaskIds: ids,
        workerIds: state.workers.map((w) => w.workerId),
      },
    },
  ];
  state.parallelExecution = {
    version: 1,
    planId: 'plan',
    initialBase: base,
    activeWave: {
      waveId: 'wave',
      attempt: 1,
      base,
      subtaskIds: ids,
      coderWorkerIds: state.workers.map((w) => w.workerId),
    },
  };
  state.integration = {
    integrationId: 'integration',
    waveId: 'wave',
    base,
    integrationWorktree: {
      path: '/owned/initial',
      branch: 'initial',
      baseCommit: base.commit,
      headCommit: base.commit,
    },
    pendingBranches: state.workers.map((w) => ({
      workerId: w.workerId,
      subtaskId: w.subtaskId as string,
      worktree: structuredClone(w.worktree) as Exclude<typeof w.worktree, string | undefined>,
      topologicalRank: 0,
    })),
    mergedBranches: [],
    conflicts: [],
    status: 'merging',
  };
  return state;
}
