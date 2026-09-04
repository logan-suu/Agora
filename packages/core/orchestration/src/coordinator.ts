import type {
  AppState,
  HandoffPacket,
  HumanGateRequest,
  Message,
  Mutation,
  RoleId,
  RoleSpec,
  Subtask,
} from '@agora/core-domain';
import { appendMutation, applyMutations, mergeByIdMutation, setMutation } from '@agora/core-domain';
import { buildCoordinationLedger, MAX_STALLS } from './progress-ledger';
import { evaluateRouteWhen } from './route-conditions';

export const MAX_ITERATIONS = 8;

export const TEST_FAILURE_REVIEW_THRESHOLD = 2;

export const HUMAN_GATE_OPTIONS: readonly string[] = ['continue'];

export interface Assignment {
  role: RoleId;
  subtaskId?: string;
}

export type Route =
  | { kind: 'worker'; batch: readonly [Assignment]; parallel: false }
  | { kind: 'integrate' }
  | { kind: 'human_gate'; request: HumanGateRequest }
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
  const leaderOverride = consumeLeaderAssignment(state, clock, options?.roster);
  let decision: CoordinatorDecision;
  if (leaderOverride !== undefined) {
    decision = leaderOverride;
  } else {
    switch (state.phase) {
      case 'clarifying':
        decision = dispatchFromClarifying(state, clock, options?.roster);
        break;
      case 'planning':
        decision = dispatchAfterPlanning(state, clock);
        break;
      case 'coding':
        decision = advanceToTesting(state);
        break;
      case 'testing':
        decision = evaluateTestResults(state, clock, options?.roster);
        break;
      case 'review':
        decision = evaluateReview(state, clock, options?.roster);
        break;
      case 'done':
        decision = { route: { kind: 'finalize' }, mutations: [] };
        break;
      default:
        throw new Error(`phase "${String(state.phase)}" is not routable by the coordinator`);
    }
  }
  if (
    decision.route.kind === 'worker' &&
    options?.roster !== undefined &&
    !hasRole(options.roster, decision.route.batch[0].role)
  ) {
    decision = unavailableRoleGate(state, clock, decision.route.batch[0].role);
  }
  return attachCoordinationArtifacts(state, decision, clock, options?.roster);
}

function unavailableRoleGate(state: AppState, clock: Clock, role: string): CoordinatorDecision {
  const message: Message = {
    msgId: clock.newId(),
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'escalation',
    payload: { reason: 'required_role_unavailable', role },
    display: `Required role ${role} is disabled or unavailable; Leader action is required`,
    ts: clock.now(),
  };
  return {
    route: {
      kind: 'human_gate',
      request: {
        triggerMsgId: message.msgId,
        triggerTs: message.ts,
        reason: `required_role_unavailable:${role}`,
        options: ['retry'],
        phase: state.phase,
      },
    },
    mutations: [appendMutation('messages', message)],
  };
}

interface AppliedLeaderAssignment {
  msgId: string;
  targetRole: string;
  instruction: string;
}

function latestAppliedLeaderAssignment(state: AppState): AppliedLeaderAssignment | undefined {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message?.fromRole !== 'leader' || message.payload.kind !== 'leader_intent') continue;
    const intent = message.payload.intent;
    const action = message.payload.action;
    if (
      typeof intent !== 'object' ||
      intent === null ||
      Array.isArray(intent) ||
      typeof action !== 'object' ||
      action === null ||
      Array.isArray(action)
    ) {
      continue;
    }
    const intentRecord = intent as Record<string, unknown>;
    const actionRecord = action as Record<string, unknown>;
    if (
      intentRecord.kind === 'assign' &&
      typeof intentRecord.targetRole === 'string' &&
      typeof intentRecord.instruction === 'string' &&
      actionRecord.status === 'applied'
    ) {
      return {
        msgId: message.msgId,
        targetRole: intentRecord.targetRole,
        instruction: intentRecord.instruction,
      };
    }
  }
  return undefined;
}

function assignmentWasConsumed(state: AppState, msgId: string): boolean {
  return state.messages.some(
    (message) =>
      message.fromRole === 'COORDINATOR' &&
      message.payload.reason === 'leader_assignment' &&
      message.payload.sourceMsgId === msgId,
  );
}

function consumeLeaderAssignment(
  state: AppState,
  clock: Clock,
  roster: readonly RoleSpec[] | undefined,
): CoordinatorDecision | undefined {
  if (state.phase === 'done' || state.humanGate !== undefined) return undefined;
  const assignment = latestAppliedLeaderAssignment(state);
  if (
    assignment === undefined ||
    assignmentWasConsumed(state, assignment.msgId) ||
    state.nextRole !== assignment.targetRole
  ) {
    return undefined;
  }

  const role = roster?.find((entry) => entry.role === assignment.targetRole);
  if (roster !== undefined && role === undefined) {
    return unavailableRoleGate(state, clock, assignment.targetRole);
  }

  const control = {
    reason: 'leader_assignment',
    sourceMsgId: assignment.msgId,
    nextRole: assignment.targetRole,
  };
  const instruction =
    assignment.instruction.length > 0
      ? assignment.instruction
      : `Leader activated ${assignment.targetRole}`;
  if (assignment.targetRole === 'CODER') {
    return dispatchCoder(state, clock, instruction, control);
  }
  return {
    route: {
      kind: 'worker',
      batch: [{ role: assignment.targetRole }],
      parallel: false,
    },
    mutations: [
      setMutation('nextRole', assignment.targetRole),
      appendMutation('messages', announce(clock, control, instruction)),
    ],
  };
}

function nextSpeakerFor(route: Route): string | null {
  switch (route.kind) {
    case 'worker':
      return route.batch[0].role;
    case 'human_gate':
      return 'LEADER';
    case 'finalize':
    case 'integrate':
      return null;
  }
}

function appendedMessages(mutations: readonly Mutation[]): Message[] {
  return mutations.flatMap((mutation) => {
    if (mutation.op !== 'append' || mutation.field !== 'messages') return [];
    const value = mutation.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    const candidate = value as Partial<Message>;
    return typeof candidate.display === 'string' && typeof candidate.type === 'string'
      ? [value as Message]
      : [];
  });
}

function instructionFor(decision: CoordinatorDecision): string {
  const messages = appendedMessages(decision.mutations);
  const latest = messages[messages.length - 1];
  if (latest !== undefined) return latest.display;
  const speaker = nextSpeakerFor(decision.route);
  if (speaker !== null) return `Continue with ${speaker}`;
  return decision.route.kind === 'finalize' ? 'Finalize the task result' : 'Integrate task outputs';
}

const LOOP_REASONS = new Set([
  'tests_failed',
  'repeated_test_failures',
  'review_changes_requested',
  'reviewer_architecture_issue',
]);

function loopReasonFor(decision: CoordinatorDecision): string | undefined {
  for (const message of appendedMessages(decision.mutations)) {
    const reason = message.payload.reason;
    if (typeof reason === 'string' && LOOP_REASONS.has(reason)) return reason;
  }
  return undefined;
}

function handoffForRoleSwitch(
  state: AppState,
  route: Route,
  clock: Clock,
): HandoffPacket | undefined {
  if (route.kind !== 'worker') return undefined;
  const fromRole = state.nextRole;
  const toRole = route.batch[0].role;
  if (fromRole === undefined || fromRole === toRole) return undefined;

  const openIssues = state.testResults?.failures.map(
    (failure) => `${failure.test}: ${failure.message}`,
  );
  const fileRefs = [
    ...new Set(
      state.testResults?.failures.map((failure) => `${failure.file}:${String(failure.line)}`) ?? [],
    ),
  ];
  return {
    fromRole,
    toRole,
    done: `${fromRole} stage completed; Coordinator routed the structured handoff to ${toRole}`,
    keyDecisions: state.decisionLedger
      .filter((decision) => decision.authority === 'leader')
      .map((decision) => decision.id),
    openIssues: openIssues ?? [],
    fileRefs,
    ts: clock.now(),
  };
}

function attachCoordinationArtifacts(
  state: AppState,
  decision: CoordinatorDecision,
  clock: Clock,
  roster: readonly RoleSpec[] | undefined,
): CoordinatorDecision {
  const handoff = handoffForRoleSwitch(state, decision.route, clock);
  const mutations = [
    ...decision.mutations,
    ...(handoff === undefined ? [] : [appendMutation('handoffPackets', handoff)]),
  ];
  const projectedNext = mutations.length === 0 ? state : applyMutations(state, mutations);
  const loopReason = loopReasonFor(decision);
  const ledger = buildCoordinationLedger(projectedNext, {
    nextSpeaker: nextSpeakerFor(decision.route),
    instruction: instructionFor(decision),
    completionCandidate: decision.route.kind === 'finalize',
    ...(roster === undefined ? {} : { availableRoles: roster.map((spec) => spec.role) }),
    ...(loopReason === undefined ? {} : { loopReason }),
  });
  const ledgerMessage: Message = {
    msgId: clock.newId(),
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'chat',
    payload: ledger,
    display: `Coordinator Ledger r${ledger.revision}: stall=${ledger.stallCount}/${MAX_STALLS}`,
    ts: clock.now(),
  };
  return {
    route: decision.route,
    mutations: [...mutations, appendMutation('messages', ledgerMessage)],
  };
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
  const message = escalationMessage(state, clock);
  return {
    route: {
      kind: 'human_gate',
      request: {
        triggerMsgId: message.msgId,
        triggerTs: message.ts,
        reason: 'iteration_limit',
        options: [...HUMAN_GATE_OPTIONS],
        phase: state.phase,
      },
    },
    mutations: [appendMutation('messages', message)],
  };
}

function latestCoordinatorControlMessage(state: AppState): Message | undefined {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (
      message !== undefined &&
      message.fromRole === 'COORDINATOR' &&
      (message.type === 'announce' || message.type === 'feedback' || message.type === 'escalation')
    ) {
      return message;
    }
  }
  return undefined;
}

function currentTestFailureStreak(state: AppState): number {
  const latest = latestCoordinatorControlMessage(state);
  if (latest?.payload.reason !== 'tests_failed') return 0;
  const recorded = latest.payload.failureStreak;
  return typeof recorded === 'number' && Number.isInteger(recorded) && recorded > 0 ? recorded : 1;
}

function isRootCauseReview(state: AppState): boolean {
  return latestCoordinatorControlMessage(state)?.payload.reason === 'repeated_test_failures';
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
              { nextRole: 'REVIEWER', reviewCommentCursor: state.reviewComments.length },
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
  const failureStreak = currentTestFailureStreak(state) + 1;
  if (failureStreak >= TEST_FAILURE_REVIEW_THRESHOLD && hasRole(roster, 'REVIEWER')) {
    return {
      route: { kind: 'worker', batch: [{ role: 'REVIEWER' }], parallel: false },
      mutations: [
        setMutation('iterationCount', state.iterationCount + 1),
        setMutation('nextRole', 'REVIEWER'),
        setMutation('phase', 'review'),
        appendMutation(
          'messages',
          announce(
            clock,
            {
              nextRole: 'REVIEWER',
              reason: 'repeated_test_failures',
              reviewCommentCursor: state.reviewComments.length,
              failureStreak,
              failed: state.testResults.failed,
              total: state.testResults.total,
            },
            `测试连续失败 ${failureStreak} 轮，派发 REVIEWER 审查根因`,
          ),
        ),
      ],
    };
  }
  const reviewerUnavailable =
    failureStreak >= TEST_FAILURE_REVIEW_THRESHOLD && !hasRole(roster, 'REVIEWER');
  const feedback: Message = {
    msgId: clock.newId(),
    channelId: 'main',
    fromRole: 'COORDINATOR',
    to: ['CODER'],
    type: 'feedback',
    payload: {
      reason: 'tests_failed',
      failureStreak,
      failed: state.testResults.failed,
      total: state.testResults.total,
      ...(reviewerUnavailable ? { degraded: true, degradedReason: 'reviewer_not_rostered' } : {}),
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

function currentReviewEntries(state: AppState): Record<string, unknown>[] {
  let cursor: number | undefined;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (
      message?.fromRole === 'COORDINATOR' &&
      message.type === 'announce' &&
      message.payload.nextRole === 'REVIEWER'
    ) {
      const recorded = message.payload.reviewCommentCursor;
      if (
        typeof recorded !== 'number' ||
        !Number.isInteger(recorded) ||
        recorded < 0 ||
        recorded > state.reviewComments.length
      ) {
        throw new Error('REVIEWER dispatch requires a valid reviewCommentCursor');
      }
      cursor = recorded;
      break;
    }
  }
  if (cursor === undefined) {
    throw new Error('phase "review" requires a current REVIEWER dispatch cursor');
  }
  return state.reviewComments.slice(cursor);
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

function upgradedComplexity(state: AppState, verdictEntry: Record<string, unknown>) {
  const previousTier = tierOf(state);
  return {
    tier: Math.min(2, previousTier + 1) as 0 | 1 | 2,
    signals: {
      ...(state.complexity?.signals ?? {}),
      escalation: {
        reason: 'reviewer_architecture_issue',
        previousTier,
        reviewCommentId: typeof verdictEntry.id === 'string' ? verdictEntry.id : null,
      },
    },
  };
}

function evaluateReview(
  state: AppState,
  clock: Clock,
  roster: readonly RoleSpec[] | undefined,
): CoordinatorDecision {
  const reviewEntries = currentReviewEntries(state);
  const verdictEntries = reviewEntries.filter((entry) => entry.kind === 'verdict');
  if (verdictEntries.length !== 1) {
    throw new Error(
      `current review turn must contain exactly one verdict; got ${verdictEntries.length}`,
    );
  }
  const verdictEntry = verdictEntries[0];
  if (verdictEntry === undefined) throw new Error('unreachable: verdict count is exactly one');
  const verdict = verdictEntry.verdict;
  if (verdict === 'approved') {
    if (isRootCauseReview(state)) {
      throw new Error(
        'repeated-test-failure root-cause review requires a changes_requested verdict',
      );
    }
    return { route: { kind: 'finalize' }, mutations: [] };
  }
  if (verdict === 'changes_requested') {
    const escalation = ifIterationLimit(state, clock);
    if (escalation !== undefined) return escalation;
    const issueScope = verdictEntry.issueScope ?? 'implementation';
    if (issueScope !== 'implementation' && issueScope !== 'architecture') {
      throw new Error('REVIEWER verdict issueScope must be "implementation" or "architecture"');
    }
    if (issueScope === 'architecture' && hasRole(roster, 'ARCHITECT')) {
      const complexity = upgradedComplexity(state, verdictEntry);
      return {
        route: { kind: 'worker', batch: [{ role: 'ARCHITECT' }], parallel: false },
        mutations: [
          setMutation('iterationCount', state.iterationCount + 1),
          setMutation('nextRole', 'ARCHITECT'),
          setMutation('phase', 'planning'),
          setMutation('complexity', complexity),
          appendMutation(
            'messages',
            announce(
              clock,
              {
                nextRole: 'ARCHITECT',
                reason: 'reviewer_architecture_issue',
                previousTier: tierOf(state),
                tier: complexity.tier,
                reviewCommentId: complexity.signals.escalation.reviewCommentId,
              },
              `REVIEWER 指出架构问题，复杂度 Tier ${tierOf(state)}→${complexity.tier}，拉 ARCHITECT 重设计`,
            ),
          ),
        ],
      };
    }
    const architectUnavailable = issueScope === 'architecture';
    const feedback: Message = {
      msgId: clock.newId(),
      channelId: 'main',
      fromRole: 'COORDINATOR',
      to: ['CODER'],
      type: 'feedback',
      payload: {
        reason: 'review_changes_requested',
        issueScope,
        summary: verdictEntry.summary ?? null,
        comments: reviewEntries,
        ...(architectUnavailable
          ? { degraded: true, degradedReason: 'architect_not_rostered' }
          : {}),
      },
      display: `评审退回（${reviewEntries.length} 条意见），退回 CODER 第 ${state.iterationCount + 1} 轮`,
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
        ...(architectUnavailable
          ? [setMutation('complexity', upgradedComplexity(state, verdictEntry))]
          : []),
        appendMutation('messages', feedback),
      ],
    };
  }
  throw new Error(`unknown review verdict "${String(verdict)}" in reviewComments`);
}
