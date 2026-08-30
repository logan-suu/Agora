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
  // Spec §3 Tier 0: 直接 CODER→TESTER 小环，跳过 PM/ARCH — even when rostered;
  // REVIEWER stays roster-gated downstream (task 4.2 ruling ①).
  if (tierOf(state) === 0) {
    return dispatchCoder(state, clock, `Tier 0 小环：跳过 PM/ARCH，直接派发 CODER：${state.goal}`);
  }
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

function dispatchCoder(
  state: AppState,
  clock: Clock,
  display: string,
  announceExtra: Record<string, unknown> = {},
): CoordinatorDecision {
  const subtaskId = subtaskIdAt(state, 0);
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
      appendMutation(
        'messages',
        announce(clock, { nextRole: 'CODER', subtaskId, ...announceExtra }, display),
      ),
      setMutation('nextRole', 'CODER'),
      setMutation('phase', 'coding'),
    ],
  };
}

function tierOf(state: AppState): 0 | 1 | 2 {
  return state.complexity?.tier ?? 1;
}

function subtaskIdAt(state: AppState, index: number): string {
  return `${state.taskId}-sub-${String(index)}`;
}

function modulesOf(state: AppState): string[] {
  const modules = state.architecture?.modules;
  if (!Array.isArray(modules)) return [];
  return modules.filter(
    (module): module is string => typeof module === 'string' && module.length > 0,
  );
}

function dispatchTier2Coder(state: AppState, clock: Clock): CoordinatorDecision {
  const modules = modulesOf(state);
  if (modules.length < 2) {
    return dispatchCoder(state, clock, `Tier 2 无多模块拆分依据，退化为单 subtask：${state.goal}`, {
      tier: 2,
      degraded: true,
      reason: 'architecture.modules missing or single',
    });
  }
  const subtasks: Subtask[] = modules.map((title, index) => ({
    id: subtaskIdAt(state, index),
    title,
    ownerRole: 'CODER',
    dependsOn: [],
    status: index === 0 ? 'in_progress' : 'todo',
  }));
  const first = subtasks[0];
  if (first === undefined) {
    throw new Error('unreachable: modules.length >= 2 guarantees at least two subtasks');
  }
  return {
    route: { kind: 'worker', batch: [{ role: 'CODER', subtaskId: first.id }], parallel: false },
    mutations: [
      ...subtasks.map((subtask) => mergeByIdMutation('subtasks', subtask.id, { ...subtask })),
      appendMutation(
        'messages',
        announce(
          clock,
          {
            nextRole: 'CODER',
            subtaskId: first.id,
            tier: 2,
            subtaskCount: subtasks.length,
            degraded: false,
          },
          `设计完成（Tier 2，拆分 ${subtasks.length} 个 subtask），按依赖序派发首个 CODER：${first.title}`,
        ),
      ),
      setMutation('nextRole', 'CODER'),
      setMutation('phase', 'coding'),
    ],
  };
}

function dispatchAfterPlanning(state: AppState, clock: Clock): CoordinatorDecision {
  if (!evaluateRouteWhen(state, 'designReady')) {
    throw new Error('phase "planning" requires architecture written by ARCHITECT via mutations');
  }
  if (tierOf(state) === 2) return dispatchTier2Coder(state, clock);
  return dispatchCoder(state, clock, `设计完成，派发 CODER 实现：${state.goal}`);
}

function activeCoderSubtaskId(state: AppState): string {
  const active = state.subtasks.filter(
    (entry) => entry.ownerRole === 'CODER' && entry.status === 'in_progress',
  );
  const subtask = active[0];
  if (active.length !== 1 || subtask === undefined) {
    throw new Error(
      `sequential routing requires exactly one in_progress CODER subtask, found ${active.length}`,
    );
  }
  return subtask.id;
}

function advanceToTesting(state: AppState): CoordinatorDecision {
  const subtaskId = activeCoderSubtaskId(state);
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
    // Sequential activation (task 4.2): close the active subtask, then
    // activate the next todo subtask whose dependsOn are all done — Phase 9
    // swaps this pick-one step for the parallel batch (spec §0 退化实现原则).
    const activeId = activeCoderSubtaskId(state);
    const doneIds = new Set(
      state.subtasks.filter((entry) => entry.status === 'done').map((entry) => entry.id),
    );
    doneIds.add(activeId);
    const closeActive: Mutation[] = [mergeByIdMutation('subtasks', activeId, { status: 'done' })];
    const next = state.subtasks.find(
      (entry) =>
        entry.ownerRole === 'CODER' &&
        entry.status === 'todo' &&
        entry.dependsOn.every((id) => doneIds.has(id)),
    );
    if (next !== undefined) {
      return {
        route: { kind: 'worker', batch: [{ role: 'CODER', subtaskId: next.id }], parallel: false },
        mutations: [
          ...closeActive,
          mergeByIdMutation('subtasks', next.id, { status: 'in_progress' }),
          setMutation('nextRole', 'CODER'),
          setMutation('phase', 'coding'),
          appendMutation(
            'messages',
            announce(
              clock,
              { nextRole: 'CODER', subtaskId: next.id, tier: tierOf(state) },
              `subtask 完成（${activeId}），按依赖序激活下一个：${next.title}`,
            ),
          ),
        ],
      };
    }
    if (hasRole(roster, 'REVIEWER')) {
      return {
        route: { kind: 'worker', batch: [{ role: 'REVIEWER' }], parallel: false },
        mutations: [
          ...closeActive,
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
    return { route: { kind: 'finalize' }, mutations: closeActive };
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
      batch: [{ role: 'CODER', subtaskId: activeCoderSubtaskId(state) }],
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

function reopenForRework(state: AppState): { mutations: Mutation[]; subtaskId: string } {
  const coderSubtasks = state.subtasks.filter((entry) => entry.ownerRole === 'CODER');
  const first = coderSubtasks[0];
  if (first === undefined) {
    throw new Error('review rework requires at least one CODER subtask in state');
  }
  // Task 4.2 ruling ③: changes_requested targets the integrated whole, so every
  // subtask reopens and the first re-activates — conservative superset. Phase 9
  // refinement (DEF-013): target subtasks via reviewComments references.
  return {
    mutations: coderSubtasks.map((entry) =>
      mergeByIdMutation('subtasks', entry.id, {
        status: entry.id === first.id ? 'in_progress' : 'todo',
      }),
    ),
    subtaskId: first.id,
  };
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
    const reopen = reopenForRework(state);
    return {
      route: {
        kind: 'worker',
        batch: [{ role: 'CODER', subtaskId: reopen.subtaskId }],
        parallel: false,
      },
      mutations: [
        ...reopen.mutations,
        setMutation('iterationCount', state.iterationCount + 1),
        setMutation('nextRole', 'CODER'),
        setMutation('phase', 'coding'),
        appendMutation('messages', feedback),
      ],
    };
  }
  throw new Error(`unknown review verdict "${String(verdict)}" in reviewComments`);
}
