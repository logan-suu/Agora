import type { AppState, Message, Mutation, RoleId, RoleSpec, Subtask } from '@agora/core-domain';
import { appendMutation, mergeByIdMutation, setMutation } from '@agora/core-domain';
import { evaluateRouteWhen } from './route-conditions';

export const MAX_ITERATIONS = 8;

export const HUMAN_GATE_OPTIONS: readonly string[] = ['extend', 'take-over', 'abort'];

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

export interface DecideOptions {
  newId?: () => string;
  now?: () => number;
  /**
   * Team composition gating (task 2.2): conditional stages (PM/ARCHITECT/
   * REVIEWER) only dispatch when the role exists in the roster, so a 3-role
   * Phase 0/1 roster keeps the fixed CODER↔TESTER slice. Omit for the full
   * machine (spec §5.3 routing table verbatim).
   */
  roster?: readonly RoleSpec[];
}

interface Clock {
  newId: () => string;
  now: () => number;
}

export function decide(state: AppState, options?: DecideOptions): CoordinatorDecision {
  const clock: Clock = {
    newId: options?.newId ?? (() => crypto.randomUUID()),
    now: options?.now ?? (() => Date.now()),
  };
  switch (state.phase) {
    case 'clarifying':
      return dispatchFromClarifying(state, clock, options?.roster);
    case 'planning':
      return dispatchAfterPlanning(state, clock);
    case 'coding':
      return advanceToTesting(state);
    case 'testing':
      return evaluateTestResults(state, clock, options?.roster);
    case 'review':
      return evaluateReview(state, clock);
    case 'done':
      return { route: { kind: 'finalize' }, mutations: [] };
    default:
      throw new Error(`phase "${String(state.phase)}" is not routable by the coordinator`);
  }
}

function hasRole(roster: readonly RoleSpec[] | undefined, role: string): boolean {
  // Omitted roster = full machine (spec §5.3 verbatim); explicit roster gates on membership.
  if (roster === undefined) return true;
  return roster.some((spec) => spec.role === role);
}

function dispatchFromClarifying(
  state: AppState,
  clock: Clock,
  roster: readonly RoleSpec[] | undefined,
): CoordinatorDecision {
  const requirementsReady = evaluateRouteWhen(state, 'requirementsReady');
  if (!requirementsReady && hasRole(roster, 'PM')) {
    return dispatchPM(state, clock);
  }
  if (requirementsReady && hasRole(roster, 'ARCHITECT')) {
    return dispatchArchitect(state, clock);
  }
  return dispatchCoder(state, clock, `Coordinator 派发任务给 CODER：${state.goal}`);
}

function announce(clock: Clock, payload: Record<string, unknown>, display: string): Message {
  return {
    msgId: clock.newId(),
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    payload,
    display,
    ts: clock.now(),
  };
}

function dispatchPM(state: AppState, clock: Clock): CoordinatorDecision {
  const escalation = ifIterationLimit(state, clock);
  if (escalation !== undefined) return escalation;
  return {
    route: { kind: 'worker', batch: [{ role: 'PM' }], parallel: false },
    mutations: [
      setMutation('iterationCount', state.iterationCount + 1),
      setMutation('nextRole', 'PM'),
      appendMutation(
        'messages',
        announce(clock, { nextRole: 'PM' }, `Coordinator 派发 PM 提炼需求：${state.goal}`),
      ),
    ],
  };
}

function dispatchArchitect(state: AppState, clock: Clock): CoordinatorDecision {
  return {
    route: { kind: 'worker', batch: [{ role: 'ARCHITECT' }], parallel: false },
    mutations: [
      setMutation('nextRole', 'ARCHITECT'),
      setMutation('phase', 'planning'),
      appendMutation(
        'messages',
        announce(
          clock,
          { nextRole: 'ARCHITECT' },
          `需求已定，派发 ARCHITECT 出设计：${state.goal}`,
        ),
      ),
    ],
  };
}

function dispatchCoder(state: AppState, clock: Clock, display: string): CoordinatorDecision {
  const subtaskId = `${state.taskId}-sub-0`;
  const subtask: Subtask = {
    id: subtaskId,
    title: state.goal,
    ownerRole: 'CODER',
    dependsOn: [],
    status: 'in_progress',
  };
  return {
    route: { kind: 'worker', batch: [{ role: 'CODER', subtaskId }], parallel: false },
    mutations: [
      mergeByIdMutation('subtasks', subtaskId, { ...subtask }),
      appendMutation('messages', announce(clock, { nextRole: 'CODER', subtaskId }, display)),
      setMutation('nextRole', 'CODER'),
      setMutation('phase', 'coding'),
    ],
  };
}

function dispatchAfterPlanning(state: AppState, clock: Clock): CoordinatorDecision {
  if (!evaluateRouteWhen(state, 'designReady')) {
    throw new Error('phase "planning" requires architecture written by ARCHITECT via mutations');
  }
  return dispatchCoder(state, clock, `设计完成，派发 CODER 实现：${state.goal}`);
}

function assignedCoderSubtaskId(state: AppState): string {
  const subtask = state.subtasks.find((entry) => entry.ownerRole === 'CODER');
  if (subtask === undefined) {
    throw new Error('no CODER-owned subtask in state; the fixed sequence requires one');
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

function escalationMessage(state: AppState, clock: Clock): Message {
  return {
    msgId: clock.newId(),
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'escalation',
    payload: {
      reason: 'iteration_limit',
      iterationCount: state.iterationCount,
      limit: MAX_ITERATIONS,
    },
    display: `已达迭代上限（${state.iterationCount}/${MAX_ITERATIONS} 轮），升级 humanGate 由 Leader 裁决`,
    ts: clock.now(),
  };
}

function ifIterationLimit(state: AppState, clock: Clock): CoordinatorDecision | undefined {
  if (state.iterationCount < MAX_ITERATIONS) return undefined;
  return {
    route: { kind: 'human_gate' },
    mutations: [
      setMutation('humanGate', {
        reason: 'iteration_limit',
        options: [...HUMAN_GATE_OPTIONS],
        phase: state.phase,
      }),
      appendMutation('messages', escalationMessage(state, clock)),
    ],
  };
}

function evaluateTestResults(
  state: AppState,
  clock: Clock,
  roster: readonly RoleSpec[] | undefined,
): CoordinatorDecision {
  if (state.testResults === undefined) {
    throw new Error('phase "testing" requires testResults written by TESTER via mutations');
  }
  if (state.testResults.passed) {
    if (hasRole(roster, 'REVIEWER')) {
      return {
        route: { kind: 'worker', batch: [{ role: 'REVIEWER' }], parallel: false },
        mutations: [
          setMutation('nextRole', 'REVIEWER'),
          setMutation('phase', 'review'),
          appendMutation(
            'messages',
            announce(
              clock,
              { nextRole: 'REVIEWER' },
              `测试全过（${state.testResults.total}/${state.testResults.total}），派发 REVIEWER 评审`,
            ),
          ),
        ],
      };
    }
    return { route: { kind: 'finalize' }, mutations: [] };
  }
  const escalation = ifIterationLimit(state, clock);
  if (escalation !== undefined) return escalation;
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

function reviewVerdictEntry(state: AppState): Record<string, unknown> | undefined {
  for (let index = state.reviewComments.length - 1; index >= 0; index -= 1) {
    const entry = state.reviewComments[index];
    if (entry !== undefined && entry.kind === 'verdict') return entry;
  }
  return undefined;
}

function evaluateReview(state: AppState, clock: Clock): CoordinatorDecision {
  const verdictEntry = reviewVerdictEntry(state);
  if (verdictEntry === undefined) {
    throw new Error(
      'phase "review" requires a verdict entry in reviewComments written by REVIEWER via mutations',
    );
  }
  const verdict = verdictEntry.verdict;
  if (verdict === 'approved') {
    return { route: { kind: 'finalize' }, mutations: [] };
  }
  if (verdict === 'changes_requested') {
    const escalation = ifIterationLimit(state, clock);
    if (escalation !== undefined) return escalation;
    const feedback: Message = {
      msgId: clock.newId(),
      channelId: 'main',
      fromRole: 'COORDINATOR',
      to: ['CODER'],
      type: 'feedback',
      payload: {
        reason: 'review_changes_requested',
        summary: verdictEntry.summary ?? null,
        comments: state.reviewComments,
      },
      display: `评审退回（${state.reviewComments.length} 条意见），退回 CODER 第 ${state.iterationCount + 1} 轮`,
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
  throw new Error(`unknown review verdict "${String(verdict)}" in reviewComments`);
}
