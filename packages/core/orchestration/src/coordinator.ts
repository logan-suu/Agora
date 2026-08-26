import type { AppState, Message, Mutation, RoleId, Subtask } from '@agora/core-domain';
import { appendMutation, mergeByIdMutation, setMutation } from '@agora/core-domain';

export const MAX_ITERATIONS = 8;

export interface Assignment {
  role: RoleId;
  subtaskId?: string;
}

export type Route =
  | { kind: 'worker'; batch: readonly [Assignment]; parallel: false }
  | { kind: 'integrate' }
  | { kind: 'human_gate' }
  | { kind: 'finalize' };

export interface CoordinatorDecision {
  route: Route;
  mutations: Mutation[];
}

export class IterationLimitError extends Error {
  constructor(
    public readonly iterationCount: number,
    public readonly limit: number = MAX_ITERATIONS,
  ) {
    super(
      `iteration limit exceeded (${iterationCount} >= ${limit}); escalate to the leader instead of looping silently`,
    );
    this.name = 'IterationLimitError';
  }
}

export interface DecideOptions {
  newId?: () => string;
  now?: () => number;
}

export function decide(state: AppState, options?: DecideOptions): CoordinatorDecision {
  const newId = options?.newId ?? (() => crypto.randomUUID());
  const now = options?.now ?? (() => Date.now());
  switch (state.phase) {
    case 'clarifying':
      return initialDispatch(state, { newId, now });
    case 'coding':
      return advanceToTesting(state);
    case 'testing':
      return evaluateTestResults(state, { newId, now });
    case 'done':
      return { route: { kind: 'finalize' }, mutations: [] };
    default:
      throw new Error(
        `phase "${String(state.phase)}" is not routable by the Phase 0 fixed coordinator`,
      );
  }
}

function initialDispatch(
  state: AppState,
  clock: Required<Pick<DecideOptions, 'newId' | 'now'>>,
): CoordinatorDecision {
  const subtaskId = `${state.taskId}-sub-0`;
  const subtask: Subtask = {
    id: subtaskId,
    title: state.goal,
    ownerRole: 'CODER',
    dependsOn: [],
    status: 'in_progress',
  };
  const announce: Message = {
    msgId: clock.newId(),
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    payload: { nextRole: 'CODER', subtaskId },
    display: `Coordinator 派发任务给 CODER：${state.goal}`,
    ts: clock.now(),
  };
  return {
    route: { kind: 'worker', batch: [{ role: 'CODER', subtaskId }], parallel: false },
    mutations: [
      mergeByIdMutation('subtasks', subtaskId, { ...subtask }),
      appendMutation('messages', announce),
      setMutation('nextRole', 'CODER'),
      setMutation('phase', 'coding'),
    ],
  };
}

function assignedCoderSubtaskId(state: AppState): string {
  const subtask = state.subtasks.find((entry) => entry.ownerRole === 'CODER');
  if (subtask === undefined) {
    throw new Error('no CODER-owned subtask in state; the Phase 0 fixed sequence requires one');
  }
  return subtask.id;
}

function advanceToTesting(state: AppState): CoordinatorDecision {
  const subtaskId = assignedCoderSubtaskId(state);
  return {
    route: { kind: 'worker', batch: [{ role: 'TESTER', subtaskId }], parallel: false },
    mutations: [setMutation('nextRole', 'TESTER'), setMutation('phase', 'testing')],
  };
}

function evaluateTestResults(
  state: AppState,
  clock: Required<Pick<DecideOptions, 'newId' | 'now'>>,
): CoordinatorDecision {
  if (state.testResults === undefined) {
    throw new Error('phase "testing" requires testResults written by TESTER via mutations');
  }
  if (state.testResults.passed) {
    return { route: { kind: 'finalize' }, mutations: [] };
  }
  if (state.iterationCount >= MAX_ITERATIONS) {
    throw new IterationLimitError(state.iterationCount);
  }
  const feedback: Message = {
    msgId: clock.newId(),
    channelId: 'main',
    fromRole: 'COORDINATOR',
    to: ['CODER'],
    type: 'feedback',
    payload: {
      reason: 'tests_failed',
      failed: state.testResults.failed,
      total: state.testResults.total,
    },
    display: `测试未通过（${state.testResults.failed}/${state.testResults.total}），退回 CODER 第 ${state.iterationCount + 1} 轮`,
    ts: clock.now(),
  };
  return {
    route: {
      kind: 'worker',
      batch: [{ role: 'CODER', subtaskId: assignedCoderSubtaskId(state) }],
      parallel: false,
    },
    mutations: [
      setMutation('iterationCount', state.iterationCount + 1),
      setMutation('nextRole', 'CODER'),
      setMutation('phase', 'coding'),
      appendMutation('messages', feedback),
    ],
  };
}
