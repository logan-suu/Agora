import {
  type AppState,
  adoptedExecutionPlan,
  appendMutation,
  applyMutations,
  canonicalJson,
  currentApprovedReviewId,
  currentReviewDispatch,
  deriveCompletionResolution,
  type ExecutionWave,
  executionPlanFromArchitecture,
  isReviewBinding,
  type Message,
  type Mutation,
  mergeByIdMutation,
  type ParallelExecution,
  type ReviewBinding,
  reopenClosure,
  setMutation,
  validationReceipt,
  validationSubtaskIds,
  type WaveValidationReceipt,
} from '@agora/core-domain';
import type { Assignment, CoordinatorDecision, DecideOptions, Route } from './coordinator';
import { buildCoordinationLedger } from './progress-ledger';

export interface ParallelDecisionContext {
  initialBase: { branch: string; commit: string };
  controlFingerprint: string;
}

type Options = DecideOptions & { parallel: ParallelDecisionContext };
type Clock = { newId(): string; now(): number };

export function decideParallel(state: AppState, options: Options): CoordinatorDecision {
  const clock: Clock = {
    newId: options.newId ?? (() => crypto.randomUUID()),
    now: options.now ?? Date.now,
  };
  if (state.humanGate !== undefined)
    throw new Error('cannot route an unresolved parallel humanGate');
  if (state.parallelExecution !== undefined) {
    const recover = recoverDispatch(state, options);
    if (recover !== undefined) return checkRecoveredRoles(state, recover, options, clock);
  }
  if (state.phase === 'planning') return adoptPlan(state, options, clock);
  const execution = state.parallelExecution;
  if (execution === undefined) throw new Error('parallel routing requires an adopted plan');
  switch (state.phase) {
    case 'coding': {
      const wave = execution.activeWave;
      if (wave === undefined) return startWave(state, options, clock);
      const workers = wave.coderWorkerIds.map((workerId) => {
        const worker = state.workers.find((candidate) => candidate.workerId === workerId);
        if (worker === undefined) throw new Error('current wave worker is missing');
        return worker;
      });
      if (workers.some((worker) => worker.status === 'running' || worker.status === 'paused'))
        throw new Error('current coding wave has not settled');
      const failed = workers.filter((worker) => worker.status !== 'done');
      if (failed.length > 0) {
        const roleGate = unavailable(state, options, clock, 'CODER');
        if (roleGate !== undefined) return roleGate;
        return retryWorkers(
          state,
          failed.map((worker) => worker.workerId),
          clock,
        );
      }
      return finish(state, { kind: 'integrate' }, [setMutation('phase', 'integrating')], clock);
    }
    case 'integrating':
      if (state.integration?.status !== 'done')
        return { route: { kind: 'integrate' }, mutations: [] };
      return dispatchValidation(state, options, clock);
    case 'testing':
      return consumeValidation(state, options, clock);
    case 'review':
      return consumeReview(state, options, clock);
    case 'done':
      return { route: { kind: 'finalize' }, mutations: [], requestSatisfied: true };
    default:
      throw new Error(`parallel phase ${state.phase} has no executable dispatch`);
  }
}

function checkRecoveredRoles(
  state: AppState,
  decision: CoordinatorDecision,
  options: Options,
  clock: Clock,
): CoordinatorDecision {
  if (decision.route.kind === 'worker') {
    for (const assignment of decision.route.batch) {
      const roleGate = unavailable(state, options, clock, assignment.role);
      if (roleGate !== undefined) return roleGate;
    }
  }
  return decision;
}

function control(clock: Clock, payload: Record<string, unknown>, display: string): Message {
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

function workerRoute(assignments: readonly Assignment[]): Route {
  const first = assignments[0];
  if (first === undefined) throw new Error('an executable dispatch must not be empty');
  if (assignments.length === 1) return { kind: 'worker', batch: [first], parallel: false };
  return {
    kind: 'worker',
    batch: [first, assignments[1] as Assignment, ...assignments.slice(2)],
    parallel: true,
  };
}

function finish(
  state: AppState,
  route: Route,
  mutations: Mutation[],
  clock: Clock,
  satisfied = false,
  candidate = false,
): CoordinatorDecision {
  const next = applyMutations(state, mutations);
  const ledger = buildCoordinationLedger(next, {
    nextSpeaker: route.kind === 'worker' ? route.batch[0].role : null,
    instruction:
      route.kind === 'worker'
        ? 'Execute only your persisted assignment and its wave scope.'
        : `Continue the ${next.phase} control transition.`,
    completionCandidate: candidate,
    requestSatisfied: satisfied,
  });
  return {
    route,
    mutations: [
      ...mutations,
      appendMutation('messages', {
        ...control(clock, ledger, 'Coordinator recorded wave progress'),
        type: 'chat',
      }),
    ],
    ...(candidate ? { completionCandidate: true } : {}),
    ...(satisfied ? { requestSatisfied: true } : {}),
  };
}

function gate(
  state: AppState,
  clock: Clock,
  reason: string,
  options: string[] = ['retry'],
): CoordinatorDecision {
  const message = control(clock, { reason }, `Leader attention required: ${reason}`);
  return finish(
    state,
    {
      kind: 'human_gate',
      request: {
        triggerMsgId: message.msgId,
        triggerTs: message.ts,
        reason,
        options,
        phase: state.phase,
      },
    },
    [appendMutation('messages', message)],
    clock,
  );
}

function unavailable(
  state: AppState,
  options: Options,
  clock: Clock,
  role: string,
): CoordinatorDecision | undefined {
  return options.roster !== undefined && !options.roster.some((spec) => spec.role === role)
    ? gate(state, clock, `required_role_unavailable:${role}`)
    : undefined;
}

function registrations(assignments: readonly Assignment[], ts: number): Mutation[] {
  return assignments.map((assignment) =>
    mergeByIdMutation('workers', assignment.workerId, {
      ...assignment,
      executor: 'harness',
      status: 'pending',
      sessionId: `session:${assignment.workerId}`,
      startedTs: ts,
    }),
  );
}

function adoptPlan(state: AppState, options: Options, clock: Clock): CoordinatorDecision {
  if (
    state.parallelExecution?.activeWave !== undefined ||
    state.workers.some((worker) => worker.status === 'running' || worker.status === 'paused')
  )
    throw new Error('execution plan can only change after the active wave is quiescent');
  const { plan, degraded } = executionPlanFromArchitecture(state.architecture);
  const previous = state.parallelExecution;
  if (previous === undefined && state.subtasks.length > 0)
    throw new Error('cannot infer wave identity for an already started legacy task');
  const oldPlan = previous === undefined ? undefined : adoptedExecutionPlan(state);
  const planningDispatch = [...state.messages]
    .reverse()
    .find(
      (message) =>
        message.fromRole === 'COORDINATOR' &&
        message.type === 'announce' &&
        message.payload.nextRole === 'ARCHITECT',
    );
  let replanBase: ExecutionWave['base'] | undefined;
  if (planningDispatch?.payload.kind === 'parallel_replan_dispatch') {
    const sourceId = planningDispatch.payload.replanSourceReceiptId;
    if (
      typeof sourceId !== 'string' ||
      currentReviewDispatch(state)?.payload.reviewBinding === undefined
    )
      throw new Error('architecture replan requires its cumulative validation source');
    const binding = currentReviewDispatch(state)?.payload.reviewBinding;
    const source = validationReceipt(state, sourceId);
    if (
      !isReviewBinding(binding) ||
      binding.validationReceiptId !== sourceId ||
      source.planId !== previous?.planId ||
      state.messages.findIndex((message) => message.msgId === sourceId) >=
        state.messages.indexOf(planningDispatch)
    )
      throw new Error('architecture replan source drifted from its reviewed plan');
    replanBase = { branch: source.worktree.branch, commit: source.worktree.headCommit as string };
  }
  if (
    oldPlan?.subtasks.some((node) => !plan.subtasks.some((candidate) => candidate.id === node.id))
  )
    throw new Error('execution plan cannot delete historical subtask identities');
  const changed = plan.subtasks
    .filter(
      (node) =>
        canonicalJson(oldPlan?.subtasks.find((candidate) => candidate.id === node.id)) !==
        canonicalJson(node),
    )
    .map((node) => node.id);
  const reopen =
    replanBase !== undefined
      ? plan.subtasks.map((node) => node.id)
      : changed.length === 0
        ? []
        : reopenClosure(plan, changed);
  const message = control(
    clock,
    { kind: 'execution_plan', plan, degraded },
    degraded
      ? 'Adopted an explicit sequential fallback plan'
      : 'Adopted the dependency execution plan',
  );
  const mutations: Mutation[] = [
    appendMutation('messages', message),
    ...plan.subtasks.map((node) =>
      mergeByIdMutation('subtasks', node.id, {
        ...node,
        ownerRole: 'CODER',
        status:
          previous === undefined || reopen.includes(node.id)
            ? 'todo'
            : (state.subtasks.find((candidate) => candidate.id === node.id)?.status ?? 'todo'),
      }),
    ),
    setMutation('parallelExecution', {
      version: 1,
      planId: message.msgId,
      initialBase: previous?.initialBase ?? options.parallel.initialBase,
      ...(previous?.acceptedReceiptId === undefined
        ? {}
        : { acceptedReceiptId: previous.acceptedReceiptId }),
    }),
    setMutation('phase', 'coding'),
  ];
  const next = applyMutations(state, mutations);
  const decision = startWave(next, options, clock, replanBase);
  return { ...decision, mutations: [...mutations, ...decision.mutations] };
}

function readySubtasks(state: AppState): string[] {
  const planIds = new Set(adoptedExecutionPlan(state).subtasks.map((node) => node.id));
  return state.subtasks
    .filter(
      (node) =>
        planIds.has(node.id) &&
        node.status === 'todo' &&
        node.dependsOn.every(
          (dependency) =>
            state.subtasks.find((candidate) => candidate.id === dependency)?.status === 'done',
        ),
    )
    .sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((node) => node.id);
}

function startWave(
  state: AppState,
  options: Options,
  clock: Clock,
  baseOverride?: ExecutionWave['base'],
  extra: Mutation[] = [],
  reworkSourceMsgId?: string,
): CoordinatorDecision {
  const execution = state.parallelExecution as ParallelExecution;
  const subtaskIds = readySubtasks(state);
  if (subtaskIds.length === 0) {
    if (
      adoptedExecutionPlan(state).subtasks.some(
        (node) => state.subtasks.find((candidate) => candidate.id === node.id)?.status !== 'done',
      )
    )
      return gate(state, clock, 'dependency_graph_blocked');
    return dispatchReview(state, options, clock);
  }
  const roleGate = unavailable(state, options, clock, 'CODER');
  if (roleGate !== undefined) return roleGate;
  const accepted =
    execution.acceptedReceiptId === undefined
      ? undefined
      : validationReceipt(state, execution.acceptedReceiptId);
  const base =
    baseOverride ??
    (accepted === undefined
      ? execution.initialBase
      : { branch: accepted.worktree.branch, commit: accepted.worktree.headCommit as string });
  const message = control(
    clock,
    {
      kind: 'coding_wave',
      ...(reworkSourceMsgId === undefined ? {} : { reworkSourceMsgId }),
      planId: execution.planId,
      nextRole: 'CODER',
      subtaskIds,
      attempt: 1,
      base,
    },
    `Dispatch coding wave: ${subtaskIds.join(', ')}`,
  );
  const assignments = subtaskIds.map(
    (subtaskId, index): Assignment => ({
      workerId: `worker:${message.msgId}:${index}`,
      role: 'CODER',
      subtaskId,
    }),
  );
  message.payload.workerIds = assignments.map((assignment) => assignment.workerId);
  const wave: ExecutionWave = {
    waveId: message.msgId,
    attempt: 1,
    base,
    subtaskIds,
    coderWorkerIds: assignments.map((assignment) => assignment.workerId),
  };
  return finish(
    state,
    workerRoute(assignments),
    [
      ...extra,
      appendMutation('messages', message),
      ...registrations(assignments, message.ts),
      ...subtaskIds.map((subtaskId) =>
        mergeByIdMutation('subtasks', subtaskId, { status: 'in_progress', worktree: undefined }),
      ),
      setMutation('parallelExecution', { ...execution, activeWave: wave }),
      setMutation('integration', undefined),
      setMutation('phase', 'coding'),
      setMutation('nextRole', 'CODER'),
    ],
    clock,
  );
}

function recoverDispatch(state: AppState, options: Options): CoordinatorDecision | undefined {
  const wave = state.parallelExecution?.activeWave;
  let workerIds: readonly string[] = [];
  if (state.phase === 'coding' && wave !== undefined)
    workerIds = [
      ...wave.coderWorkerIds,
      ...(wave.preparationWorkerId === undefined ? [] : [wave.preparationWorkerId]),
    ];
  else if (state.phase === 'testing' && wave?.validation !== undefined)
    workerIds = [wave.validation.workerId];
  else if (state.phase === 'review' || state.phase === 'planning') {
    const message = [...state.messages]
      .reverse()
      .find(
        (candidate) =>
          candidate.fromRole === 'COORDINATOR' &&
          candidate.type === 'announce' &&
          candidate.payload.nextRole === state.nextRole,
      );
    if (
      Array.isArray(message?.payload.workerIds) &&
      message.payload.workerIds.every((value) => typeof value === 'string')
    )
      workerIds = message.payload.workerIds as string[];
  }
  const failedCodingBatch =
    state.phase === 'coding' &&
    wave !== undefined &&
    wave.coderWorkerIds.some(
      (workerId) =>
        state.workers.find((worker) => worker.workerId === workerId)?.status === 'failed',
    );
  const assignments: Assignment[] = [];
  for (const workerId of workerIds) {
    const worker = state.workers.find((candidate) => candidate.workerId === workerId);
    if (worker === undefined) throw new Error(`missing current dispatch worker ${workerId}`);
    if (
      (worker.status === 'pending' && !failedCodingBatch) ||
      (worker.status === 'paused' && options.resumingWorkerIds?.includes(worker.workerId))
    )
      assignments.push({
        workerId,
        role: worker.role,
        ...(worker.subtaskId === undefined ? {} : { subtaskId: worker.subtaskId }),
      });
  }
  return assignments.length === 0 ? undefined : { route: workerRoute(assignments), mutations: [] };
}

function retryWorkers(state: AppState, workerIds: string[], clock: Clock): CoordinatorDecision {
  if (state.iterationCount >= 8) return gate(state, clock, 'iteration_limit', ['continue']);
  const execution = state.parallelExecution as ParallelExecution;
  const wave = execution.activeWave as ExecutionWave;
  const feedbackIds = new Set(
    workerIds.flatMap((workerId) => {
      const source = [...state.messages]
        .reverse()
        .find(
          (message) =>
            message.fromRole === 'COORDINATOR' &&
            message.type === 'announce' &&
            message.payload.kind === 'coding_retry' &&
            message.payload.waveId === wave.waveId &&
            message.payload.attempt === wave.attempt &&
            Array.isArray(message.payload.workerIds) &&
            message.payload.workerIds.includes(workerId),
        );
      return typeof source?.payload.failedReceiptId === 'string'
        ? [source.payload.failedReceiptId]
        : [];
    }),
  );
  if (feedbackIds.size > 1)
    throw new Error('failed worker feedback belongs to conflicting receipts');
  const failedReceiptId = [...feedbackIds][0];
  const message = control(
    clock,
    {
      kind: 'coding_retry',
      nextRole: 'CODER',
      waveId: wave.waveId,
      attempt: wave.attempt,
      ...(failedReceiptId === undefined ? {} : { failedReceiptId }),
      failedWorkerIds: workerIds,
      base: wave.base,
    },
    'Retry only the failed coding assignments',
  );
  const assignments = workerIds.map(
    (workerId, index): Assignment => ({
      workerId: `worker:${message.msgId}:${index}`,
      role: 'CODER',
      subtaskId: wave.subtaskIds[wave.coderWorkerIds.indexOf(workerId)] as string,
    }),
  );
  message.payload.workerIds = assignments.map((assignment) => assignment.workerId);
  const coderWorkerIds = wave.coderWorkerIds.map(
    (workerId) => assignments[workerIds.indexOf(workerId)]?.workerId ?? workerId,
  );
  return finish(
    state,
    workerRoute(assignments),
    [
      appendMutation('messages', message),
      ...registrations(assignments, message.ts),
      ...assignments.map((assignment) =>
        mergeByIdMutation('subtasks', assignment.subtaskId as string, {
          status: 'in_progress',
          worktree: undefined,
        }),
      ),
      setMutation('parallelExecution', { ...execution, activeWave: { ...wave, coderWorkerIds } }),
      setMutation('iterationCount', state.iterationCount + 1),
    ],
    clock,
  );
}

function dispatchValidation(
  state: AppState,
  options: Options,
  clock: Clock,
  sourceReceiptId?: string,
): CoordinatorDecision {
  const roleGate = unavailable(state, options, clock, 'TESTER');
  if (roleGate !== undefined) return roleGate;
  const execution = state.parallelExecution as ParallelExecution;
  const wave = execution.activeWave;
  const integration = state.integration;
  if (
    wave === undefined ||
    integration?.status !== 'done' ||
    integration.waveId !== wave.waveId ||
    integration.resultCommit === undefined
  )
    throw new Error('validation requires the frozen current wave Integration');
  const inputCommit =
    sourceReceiptId === undefined
      ? integration.resultCommit
      : (validationReceipt(state, sourceReceiptId).worktree.headCommit as string);
  const message = control(
    clock,
    {
      kind: 'wave_validation_dispatch',
      nextRole: 'TESTER',
      planId: execution.planId,
      waveId: wave.waveId,
      attempt: wave.attempt,
      subtaskIds: validationSubtaskIds(state, wave),
      integrationId: integration.integrationId,
      inputCommit,
      ...(sourceReceiptId === undefined ? {} : { sourceReceiptId }),
      controlFingerprint: options.parallel.controlFingerprint,
    },
    'Validate the cumulative integrated code in an independent worktree',
  );
  const assignment: Assignment = { workerId: `worker:${message.msgId}:0`, role: 'TESTER' };
  message.payload.workerIds = [assignment.workerId];
  return finish(
    state,
    workerRoute([assignment]),
    [
      appendMutation('messages', message),
      ...registrations([assignment], message.ts),
      setMutation('testResults', undefined),
      setMutation('phase', 'testing'),
      setMutation('nextRole', 'TESTER'),
      setMutation('parallelExecution', {
        ...execution,
        activeWave: {
          ...wave,
          validation: {
            dispatchId: message.msgId,
            workerId: assignment.workerId,
            integrationId: integration.integrationId,
            inputCommit,
          },
        },
      }),
    ],
    clock,
  );
}

function consumeValidation(state: AppState, options: Options, clock: Clock): CoordinatorDecision {
  const execution = state.parallelExecution as ParallelExecution;
  const wave = execution.activeWave;
  if (wave?.validation?.receiptId === undefined)
    throw new Error('validation completed without an authoritative execution receipt');
  const receipt = validationReceipt(state, wave.validation.receiptId);
  if (
    state.workers.find((worker) => worker.workerId === wave.validation?.workerId)?.status !== 'done'
  )
    throw new Error('validation worker has not settled');
  if (receipt.controlFingerprint !== options.parallel.controlFingerprint)
    return dispatchValidation(state, options, clock, wave.validation.receiptId);
  if (!receipt.results.passed) {
    const previousFailures = state.messages.filter(
      (message) =>
        message.payload.kind === 'wave_validation' &&
        message.payload.waveId === wave.waveId &&
        (message.payload.results as { passed?: boolean } | undefined)?.passed === false,
    ).length;
    if (previousFailures >= 2)
      return dispatchReview(state, options, clock, wave.validation.receiptId);
    return testRework(state, receipt, options, clock);
  }
  const closing = receipt.subtaskIds.filter(
    (subtaskId) => state.subtasks.find((node) => node.id === subtaskId)?.status !== 'done',
  );
  const { activeWave: _removed, ...closed } = execution;
  const mutations: Mutation[] = [
    ...closing.map((subtaskId) => mergeByIdMutation('subtasks', subtaskId, { status: 'done' })),
    setMutation('parallelExecution', { ...closed, acceptedReceiptId: wave.validation.receiptId }),
    ...(closing.length === 0
      ? []
      : [
          appendMutation(
            'messages',
            control(
              clock,
              {
                kind: 'wave_closed',
                planId: execution.planId,
                waveId: wave.waveId,
                attempt: wave.attempt,
                receiptId: wave.validation.receiptId,
                subtaskIds: closing,
              },
              `Validated and completed: ${closing.join(', ')}`,
            ),
          ),
        ]),
    setMutation('phase', 'coding'),
  ];
  const decision = startWave(applyMutations(state, mutations), options, clock);
  return { ...decision, mutations: [...mutations, ...decision.mutations] };
}

function testRework(
  state: AppState,
  receipt: WaveValidationReceipt,
  options: Options,
  clock: Clock,
): CoordinatorDecision {
  if (state.iterationCount >= 8) return gate(state, clock, 'iteration_limit', ['continue']);
  const execution = state.parallelExecution as ParallelExecution;
  const wave = execution.activeWave as ExecutionWave;
  const finalRevalidation = wave.subtaskIds.every(
    (subtaskId) => state.subtasks.find((node) => node.id === subtaskId)?.status === 'done',
  );
  if (finalRevalidation)
    return reviewRework(
      state,
      adoptedExecutionPlan(state).subtasks.map((node) => node.id),
      receipt,
      options,
      clock,
      'final_revalidation_failed',
    );
  const message = control(
    clock,
    {
      kind: 'coding_retry',
      nextRole: 'CODER',
      waveId: wave.waveId,
      attempt: wave.attempt + 1,
      failedReceiptId: `wave-validation:${receipt.dispatchId}`,
      reason: 'tests_failed',
    },
    'Rework the current wave from its failed validation commit',
  );
  const assignments = wave.subtaskIds.map(
    (subtaskId, index): Assignment => ({
      workerId: `worker:${message.msgId}:${index}`,
      role: 'CODER',
      subtaskId,
    }),
  );
  message.payload.workerIds = assignments.map((assignment) => assignment.workerId);
  const { validation: _validation, ...coding } = wave;
  return finish(
    state,
    workerRoute(assignments),
    [
      appendMutation('messages', message),
      ...registrations(assignments, message.ts),
      ...wave.subtaskIds.map((subtaskId) =>
        mergeByIdMutation('subtasks', subtaskId, { status: 'in_progress', worktree: undefined }),
      ),
      setMutation('parallelExecution', {
        ...execution,
        activeWave: {
          ...coding,
          attempt: wave.attempt + 1,
          base: { branch: receipt.worktree.branch, commit: receipt.worktree.headCommit },
          coderWorkerIds: assignments.map((assignment) => assignment.workerId),
        },
      }),
      setMutation('integration', undefined),
      setMutation('phase', 'coding'),
      setMutation('nextRole', 'CODER'),
      setMutation('iterationCount', state.iterationCount + 1),
    ],
    clock,
  );
}

function dispatchReview(
  state: AppState,
  options: Options,
  clock: Clock,
  failedReceiptId?: string,
): CoordinatorDecision {
  const roleGate = unavailable(state, options, clock, 'REVIEWER');
  if (roleGate !== undefined) return roleGate;
  const execution = state.parallelExecution as ParallelExecution;
  const receiptId = failedReceiptId ?? execution.acceptedReceiptId;
  if (receiptId === undefined) throw new Error('review requires a bound validation receipt');
  const receipt = validationReceipt(state, receiptId);
  if (
    receipt.planId !== execution.planId ||
    receipt.controlFingerprint !== options.parallel.controlFingerprint
  )
    return revalidate(state, receipt, options, clock);
  if (
    failedReceiptId === undefined &&
    (execution.activeWave !== undefined ||
      !receipt.results.passed ||
      adoptedExecutionPlan(state).subtasks.some(
        (node) => state.subtasks.find((candidate) => candidate.id === node.id)?.status !== 'done',
      ))
  )
    throw new Error('final review requires all plan tasks and the current validation to pass');
  const reviewBinding: ReviewBinding = {
    planId: execution.planId,
    validationReceiptId: receiptId,
    commit: receipt.worktree.headCommit as string,
    controlFingerprint: receipt.controlFingerprint,
  };
  const message = control(
    clock,
    {
      kind: 'parallel_review_dispatch',
      nextRole: 'REVIEWER',
      reviewCommentCursor: state.reviewComments.length,
      reviewBinding,
      ...(failedReceiptId === undefined
        ? {}
        : { reason: 'repeated_test_failures', failureStreak: 2 }),
    },
    failedReceiptId === undefined
      ? 'Review the complete cumulative implementation'
      : 'Review the root cause of repeated test failures',
  );
  const assignment: Assignment = { workerId: `worker:${message.msgId}:0`, role: 'REVIEWER' };
  message.payload.workerIds = [assignment.workerId];
  return finish(
    state,
    workerRoute([assignment]),
    [
      appendMutation('messages', message),
      ...registrations([assignment], message.ts),
      setMutation('phase', 'review'),
      setMutation('nextRole', 'REVIEWER'),
    ],
    clock,
  );
}

function revalidate(
  state: AppState,
  receipt: WaveValidationReceipt,
  options: Options,
  clock: Clock,
): CoordinatorDecision {
  const execution = state.parallelExecution as ParallelExecution;
  const source = [...state.messages]
    .reverse()
    .find(
      (message) =>
        message.payload.kind === 'wave_closed' && message.payload.waveId === receipt.waveId,
    );
  const integration = state.integration;
  if (
    integration?.integrationId !== receipt.integrationId ||
    (source === undefined && execution.activeWave === undefined)
  )
    throw new Error('cannot recover the last validated wave for cumulative revalidation');
  const activeWave: ExecutionWave = execution.activeWave ?? {
    waveId: receipt.waveId,
    attempt: receipt.attempt,
    base: integration.base,
    subtaskIds: integration.pendingBranches.map((branch) => branch.subtaskId),
    coderWorkerIds: integration.pendingBranches.map(({ subtaskId }) => {
      const branch = integration.pendingBranches.find(
        (candidate) => candidate.subtaskId === subtaskId,
      );
      if (branch === undefined) throw new Error('last integration membership drifted');
      return branch.workerId;
    }),
  };
  const mutations = [
    setMutation('parallelExecution', { ...execution, activeWave }),
    setMutation('phase', 'integrating'),
  ];
  const decision = dispatchValidation(
    applyMutations(state, mutations),
    options,
    clock,
    `wave-validation:${receipt.dispatchId}`,
  );
  return { ...decision, mutations: [...mutations, ...decision.mutations] };
}

function consumeReview(state: AppState, options: Options, clock: Clock): CoordinatorDecision {
  const dispatch = currentReviewDispatch(state);
  const reviewWorkerIds = dispatch?.payload.workerIds;
  if (
    !Array.isArray(reviewWorkerIds) ||
    reviewWorkerIds.length !== 1 ||
    state.workers.find((worker) => worker.workerId === reviewWorkerIds[0])?.status !== 'done'
  )
    throw new Error('current review worker has not settled');
  const binding = dispatch?.payload.reviewBinding;
  if (!isReviewBinding(binding) || binding.planId !== state.parallelExecution?.planId)
    throw new Error('current review requires its canonical plan/validation binding');
  const receipt = validationReceipt(state, binding.validationReceiptId);
  if (
    binding.commit !== receipt.worktree.headCommit ||
    binding.controlFingerprint !== receipt.controlFingerprint
  )
    throw new Error('current review binding drifted');
  if (binding.controlFingerprint !== options.parallel.controlFingerprint)
    return revalidate(state, receipt, options, clock);
  const cursor = dispatch?.payload.reviewCommentCursor;
  if (
    typeof cursor !== 'number' ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > state.reviewComments.length
  )
    throw new Error('invalid current review cursor');
  const verdicts = state.reviewComments.slice(cursor).filter((entry) => entry.kind === 'verdict');
  const verdict = verdicts[0];
  if (
    verdicts.length !== 1 ||
    verdict === undefined ||
    typeof verdict.id !== 'string' ||
    state.reviewComments.slice(0, cursor).some((entry) => entry.id === verdict.id)
  )
    throw new Error('review requires exactly one unique current verdict');
  const plan = adoptedExecutionPlan(state);
  const targets = verdict.subtaskIds;
  const reopen =
    targets === undefined
      ? plan.subtasks.map((node) => node.id)
      : reopenClosure(plan, targets as string[]);
  if (verdict.verdict === 'changes_requested') {
    if (verdict.issueScope === 'architecture') {
      if (state.iterationCount >= 8) return gate(state, clock, 'iteration_limit', ['continue']);
      const roleGate = unavailable(state, options, clock, 'ARCHITECT');
      if (roleGate !== undefined) return roleGate;
      const message = control(
        clock,
        {
          kind: 'parallel_replan_dispatch',
          nextRole: 'ARCHITECT',
          reason: 'reviewer_architecture_issue',
          reviewId: verdict.id,
          replanSourceReceiptId: binding.validationReceiptId,
          reworkScope: 'full_plan',
        },
        'Revise the execution plan without deleting historical task identities',
      );
      const assignment: Assignment = { workerId: `worker:${message.msgId}:0`, role: 'ARCHITECT' };
      message.payload.workerIds = [assignment.workerId];
      const { activeWave: _wave, ...execution } = state.parallelExecution as ParallelExecution;
      return finish(
        state,
        workerRoute([assignment]),
        [
          appendMutation('messages', message),
          ...registrations([assignment], message.ts),
          ...plan.subtasks.map(({ id: subtaskId }) =>
            mergeByIdMutation('subtasks', subtaskId, { status: 'todo' }),
          ),
          setMutation('parallelExecution', execution),
          setMutation('phase', 'planning'),
          setMutation('nextRole', 'ARCHITECT'),
          setMutation('iterationCount', state.iterationCount + 1),
        ],
        clock,
      );
    }
    return reviewRework(
      state,
      reopen,
      receipt,
      options,
      clock,
      targets === undefined ? 'missing_subtask_refs' : 'review_changes_requested',
    );
  }
  if (
    verdict.verdict !== 'approved' ||
    dispatch?.payload.reason === 'repeated_test_failures' ||
    !receipt.results.passed
  )
    throw new Error('root-cause review cannot approve completion');
  const reviewId = currentApprovedReviewId(state);
  const resolution = deriveCompletionResolution(state, reviewId);
  if (resolution === undefined)
    return finish(
      state,
      {
        kind: 'human_gate',
        request: {
          triggerMsgId: reviewId,
          triggerTs: clock.now(),
          reason: `completion_confirmation:${reviewId}`,
          options: ['approve_completion', 'request_changes'],
          phase: 'review',
        },
      },
      [],
      clock,
      false,
      true,
    );
  if (!resolution.resumed)
    throw new Error('completion resolution must resume through D4 before routing');
  if (resolution.option === 'request_changes')
    return reviewRework(
      state,
      plan.subtasks.map((node) => node.id),
      receipt,
      options,
      clock,
      'leader_completion_changes_requested',
    );
  return finish(state, { kind: 'finalize' }, [], clock, true, true);
}

function reviewRework(
  state: AppState,
  targets: string[],
  receipt: WaveValidationReceipt,
  options: Options,
  clock: Clock,
  reason: string,
): CoordinatorDecision {
  if (state.iterationCount >= 8) return gate(state, clock, 'iteration_limit', ['continue']);
  const { activeWave: _wave, ...execution } = state.parallelExecution as ParallelExecution;
  const message = control(
    clock,
    {
      kind: 'review_rework',
      reason,
      degraded: reason === 'missing_subtask_refs',
      subtaskIds: targets,
      failedReceiptId: `wave-validation:${receipt.dispatchId}`,
    },
    `Reopen affected tasks and their successors: ${targets.join(', ')}`,
  );
  const mutations: Mutation[] = [
    ...targets.map((subtaskId) => mergeByIdMutation('subtasks', subtaskId, { status: 'todo' })),
    appendMutation('messages', message),
    setMutation('parallelExecution', execution),
    setMutation('iterationCount', state.iterationCount + 1),
    setMutation('phase', 'coding'),
  ];
  const decision = startWave(
    applyMutations(state, mutations),
    options,
    clock,
    {
      branch: receipt.worktree.branch,
      commit: receipt.worktree.headCommit as string,
    },
    [],
    message.msgId,
  );
  return { ...decision, mutations: [...mutations, ...decision.mutations] };
}
