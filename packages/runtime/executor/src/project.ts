import {
  type AppState,
  activeRequirements,
  adoptedExecutionPlan,
  type CoordinationLedgerPayload,
  currentReviewDispatch,
  deriveCompletionFeedback,
  deriveLeaderDirective,
  deriveObjectionResolutions,
  deriveOnboardingContext,
  type ExecutionWave,
  isFileRef,
  isReviewBinding,
  latestCoordinationLedger,
  type RoleId,
  type RoleSpec,
  validationReceipt,
  validationSubtaskIds,
  type WorktreeRef,
} from '@agora/core-domain';
import type { ProjectionView } from './base';
import {
  collapseSupersededDecisions,
  compressWhenOverThreshold,
  SLICE_COMPRESSION_THRESHOLD_CHARS,
} from './slice-compression';

/**
 * Role projection implementing the spec §7 slice table (task 2.4; D1/WO).
 *
 * Every roster-declared slice is built here from structured State only — never
 * the raw chat log (iron rule 1), and code travels as path+line refs only
 * (iron rule 2). Iron rule 3 (rationale-follows-decision) projects
 * leader-authority entries from state.decisionLedger with their rationale
 * (task 3.3). Slices whose State sources land in later phases return explicit
 * empty defaults (R9), annotated with the upgrade task; the §7 view-level
 * blockingObjections (Phase 8) has no State field yet and is not
 * roster-declared, so no slice machinery exists for it until then. Cross-agent
 * slice compression (task 3.4, spec §7)
 * applies to the ledger slice at read time; State stays the complete truth
 * (see slice-compression.ts for the division of labor with ctx.compaction).
 */
export function project(
  state: AppState,
  role: RoleId,
  roster: readonly RoleSpec[],
  channelContext: readonly unknown[] = [],
): ProjectionView {
  const spec = roster.find((entry) => entry.role === role);
  const slices: Record<string, unknown> = {};
  if (spec !== undefined) {
    for (const slice of spec.projection) {
      slices[slice] = sliceOf(state, role, slice);
    }
  }
  slices.channels = structuredClone([...channelContext]);
  slices.currentRequirements = activeRequirements(state).map(
    ({ id, story, acceptance, nonGoals }) => structuredClone({ id, story, acceptance, nonGoals }),
  );
  slices.onboardingContext = deriveOnboardingContext(state, role);
  slices.leaderDirective = deriveLeaderDirective(state);
  slices.completionFeedback = deriveCompletionFeedback(state);
  slices.objectionResolutions = deriveObjectionResolutions(state)
    .filter((entry) => entry.status === 'resolved')
    .map((entry) => {
      const decision = state.decisionLedger.find(
        (candidate) => candidate.id === entry.resolutionDecisionId,
      );
      if (decision === undefined) {
        throw new Error(
          `missing verified objection resolution "${String(entry.resolutionDecisionId)}"`,
        );
      }
      return structuredClone(decision);
    });
  return { role: String(role), slices };
}

export interface ProjectionAssignment {
  workerId: string;
  role: RoleId;
  subtaskId?: string;
}

/** D17 assignment lens, also used for D9 reproject and D4 Fork resume. */
export function projectForAssignment(
  state: AppState,
  assignment: ProjectionAssignment,
  roster: readonly RoleSpec[],
  channelContext: readonly unknown[] = [],
): ProjectionView {
  const worker = state.workers.find((candidate) => candidate.workerId === assignment.workerId);
  if (
    worker === undefined ||
    worker.role !== assignment.role ||
    worker.subtaskId !== assignment.subtaskId
  )
    throw new Error('projection assignment does not match canonical WorkerState');
  const execution = state.parallelExecution;
  if (execution === undefined) return project(state, assignment.role, roster, channelContext);
  const wave = execution.activeWave;
  const isCoder = state.phase === 'coding' && wave?.coderWorkerIds.includes(assignment.workerId);
  const isValidation =
    state.phase === 'testing' && wave?.validation?.workerId === assignment.workerId;
  const isPreparation =
    state.phase === 'coding' && wave?.preparationWorkerId === assignment.workerId;
  const dispatch = [...state.messages]
    .reverse()
    .find(
      (message) =>
        message.fromRole === 'COORDINATOR' &&
        message.type === 'announce' &&
        message.payload.nextRole === assignment.role,
    );
  const explicit =
    (state.phase === 'review' || state.phase === 'planning') &&
    Array.isArray(dispatch?.payload.workerIds) &&
    dispatch.payload.workerIds.includes(assignment.workerId);
  if (!isCoder && !isValidation && !isPreparation && !explicit)
    throw new Error('assignment is not part of the current wave or serial dispatch');
  const view = project(state, assignment.role, roster, channelContext);
  const node = state.subtasks.find((candidate) => candidate.id === assignment.subtaskId);
  const advisoryId =
    explicit && assignment.role === 'REVIEWER' ? dispatch?.payload.advisorySourceMsgId : undefined;
  if (
    advisoryId !== undefined &&
    (typeof advisoryId !== 'string' ||
      !state.objections.some(
        (objection) =>
          objection.id === advisoryId &&
          objection.fromRole === 'REVIEWER' &&
          objection.track === 'advisory',
      ))
  )
    throw new Error('review continuation projection requires its advisory fact');
  const instruction = isCoder
    ? node?.title
    : isValidation
      ? 'Validate only currentSubtasks and completedSubtasks in validationScope. Do not import or add tests for deferredSubtasks. Whole-task requirements do not expand this wave. Commit tests, then run validation on that clean HEAD.'
      : isPreparation
        ? 'Prepare read-only acceptance checks for this wave.'
        : advisoryId !== undefined
          ? 'The advisory has been recorded. Continue the bound review and provide its required verdict.'
          : 'Execute the current serial review or planning dispatch.';
  if (instruction === undefined) throw new Error('assigned subtask is missing');
  const visibleSubtaskIds =
    isValidation && wave !== undefined ? validationSubtaskIds(state, wave) : wave?.subtaskIds;
  if ('assignedSubtask' in view.slices)
    view.slices.assignedSubtask = node === undefined ? [] : [structuredClone(node)];
  view.slices.assignment = {
    ...assignment,
    ...(worker.worktree === undefined ? {} : { worktree: structuredClone(worker.worktree) }),
    ...(wave === undefined
      ? {}
      : {
          waveId: wave.waveId,
          attempt: wave.attempt,
          base: structuredClone(wave.base),
          subtaskIds:
            isCoder && node !== undefined ? [node.id] : [...(visibleSubtaskIds ?? wave.subtaskIds)],
          completedSubtaskIds: state.subtasks
            .filter((candidate) => candidate.status === 'done')
            .map((candidate) => candidate.id),
          finalWave: state.subtasks.every(
            (candidate) => candidate.status === 'done' || visibleSubtaskIds?.includes(candidate.id),
          ),
        }),
    ...(isValidation ? { validationDispatchId: wave?.validation?.dispatchId } : {}),
  };
  view.slices.coordinationContext = {
    ...(view.slices.coordinationContext as Record<string, unknown> | undefined),
    plan: [
      {
        id: assignment.workerId,
        role: assignment.role,
        instruction,
        status: 'active',
        dependsOn: node?.dependsOn ?? [],
      },
    ],
    instructionOrQuestion: instruction,
  };
  if (isCoder && wave !== undefined) {
    const receiptId = repairFeedbackReceipt(state, assignment, wave);
    view.slices.failingTests =
      receiptId === undefined
        ? { passed: null, total: 0, failed: 0, failures: [] }
        : structuredClone(validationReceipt(state, receiptId).results);
  }
  if (isValidation && wave?.validation !== undefined) {
    const covered = new Set(visibleSubtaskIds);
    const describe = (subtask: AppState['subtasks'][number]) => ({
      subtaskId: subtask.id,
      title: subtask.title,
      dependsOn: [...subtask.dependsOn],
    });
    view.slices.validationScope = {
      currentSubtasks: state.subtasks
        .filter((subtask) => subtask.status !== 'done' && covered.has(subtask.id))
        .map(describe),
      completedSubtasks: state.subtasks
        .filter((subtask) => subtask.status === 'done')
        .map(describe),
      deferredSubtasks: state.subtasks
        .filter((subtask) => subtask.status !== 'done' && !covered.has(subtask.id))
        .map(describe),
    };
    view.slices.branchOrIntegration = {
      ...(view.slices.branchOrIntegration as Record<string, unknown>),
      validation: {
        dispatchId: wave.validation.dispatchId,
        integrationId: wave.validation.integrationId,
        inputCommit: wave.validation.inputCommit,
        ...(worker.worktree === undefined ? {} : { worktree: structuredClone(worker.worktree) }),
      },
    };
  }
  if (assignment.role === 'REVIEWER') {
    const binding = currentReviewDispatch(state)?.payload.reviewBinding;
    if (!isReviewBinding(binding) || binding.planId !== execution.planId)
      throw new Error('review projection requires a current evidence binding');
    const receipt = validationReceipt(state, binding.validationReceiptId);
    view.slices.branchOrIntegration = {
      ...(view.slices.branchOrIntegration as Record<string, unknown>),
      reviewScope: {
        planId: execution.planId,
        validationReceiptId: binding.validationReceiptId,
        worktree: structuredClone(receipt.worktree),
        subtasks: adoptedExecutionPlan(state).subtasks.map((subtask) => ({
          subtaskId: subtask.id,
          title: subtask.title,
          dependsOn: [...subtask.dependsOn],
        })),
      },
    };
  }
  return view;
}

function repairFeedbackReceipt(
  state: AppState,
  assignment: ProjectionAssignment,
  wave: ExecutionWave,
): string | undefined {
  const retry = [...state.messages]
    .reverse()
    .find(
      (message) =>
        message.fromRole === 'COORDINATOR' &&
        message.type === 'announce' &&
        message.channelId === 'main' &&
        message.payload.kind === 'coding_retry' &&
        message.payload.waveId === wave.waveId &&
        message.payload.attempt === wave.attempt &&
        Array.isArray(message.payload.workerIds) &&
        message.payload.workerIds.includes(assignment.workerId),
    );
  if (typeof retry?.payload.failedReceiptId === 'string') {
    const receipt = validationReceipt(state, retry.payload.failedReceiptId);
    if (
      receipt.planId !== state.parallelExecution?.planId ||
      receipt.waveId !== wave.waveId ||
      receipt.attempt >= wave.attempt ||
      receipt.worktree.headCommit !== wave.base.commit ||
      !receipt.subtaskIds.includes(assignment.subtaskId ?? '')
    )
      throw new Error('coding repair feedback does not match the current assignment');
    return retry.payload.failedReceiptId;
  }
  const waveIndex = state.messages.findIndex((message) => message.msgId === wave.waveId);
  const waveMessage = state.messages[waveIndex];
  const sourceId = waveMessage?.payload.reworkSourceMsgId;
  if (sourceId === undefined) return undefined;
  const sourceIndex = state.messages.findIndex((message) => message.msgId === sourceId);
  const source = state.messages[sourceIndex];
  if (
    waveMessage?.fromRole !== 'COORDINATOR' ||
    waveMessage.type !== 'announce' ||
    waveMessage.channelId !== 'main' ||
    waveMessage.payload.kind !== 'coding_wave' ||
    sourceIndex < 0 ||
    sourceIndex >= waveIndex ||
    source?.fromRole !== 'COORDINATOR' ||
    source.type !== 'announce' ||
    source.channelId !== 'main' ||
    source.payload.kind !== 'review_rework' ||
    !Array.isArray(source.payload.subtaskIds) ||
    typeof source.payload.failedReceiptId !== 'string'
  )
    throw new Error('review repair feedback requires its canonical source');
  if (!source.payload.subtaskIds.includes(assignment.subtaskId)) return undefined;
  const receipt = validationReceipt(state, source.payload.failedReceiptId);
  if (receipt.planId !== state.parallelExecution?.planId)
    throw new Error('review repair feedback belongs to another plan');
  return source.payload.failedReceiptId;
}

function sliceOf(state: AppState, role: RoleId, slice: string): unknown {
  const requirements = activeRequirements(state);
  switch (slice) {
    case 'global.summary':
      return {
        taskId: state.taskId,
        goal: state.goal,
        phase: state.phase,
        iterationCount: state.iterationCount,
        // task 4.2: tier wired from entry (4.1 ruling ③). WO: defensive
        // copies — the projection must never hand out the live State object.
        complexity:
          state.complexity === undefined
            ? null
            : { tier: state.complexity.tier, signals: { ...state.complexity.signals } },
        workers: state.workers.map((worker) => ({
          workerId: worker.workerId,
          role: worker.role,
          status: worker.status,
          ...(worker.subtaskId === undefined ? {} : { subtaskId: worker.subtaskId }),
          startedTs: worker.startedTs,
        })),
        testSummary:
          state.testResults === undefined
            ? null
            : {
                passed: state.testResults.passed,
                total: state.testResults.total,
                failed: state.testResults.failed,
              },
      };
    case 'goal':
      return { goal: state.goal };
    case 'requirements':
      return requirements;
    case 'leaderDecisions': {
      // Iron rule 3: rationale travels with the decision (spec §7). Task 3.3
      // plan ruling: leader-authority entries only — the slice name and the §2
      // PM row list "relevant leader decisions"; per-role relevance refinement
      // lands with Phase 6 channels (R9 upgrade point). WO: defensive copies.
      // Task 3.4 (spec §7): read-time slice compression, State stays the
      // complete truth — rulings and ctx.compaction boundary in
      // slice-compression.ts.
      const leaderEntries = state.decisionLedger
        .filter((entry) => entry.authority === 'leader')
        .map((entry) => ({ ...entry }));
      return compressWhenOverThreshold(
        leaderEntries,
        SLICE_COMPRESSION_THRESHOLD_CHARS,
        collapseSupersededDecisions,
      );
    }
    case 'repoStructure':
      return {}; // Phase 1 repoSnapshot upgrade point
    case 'conventions':
      return state.conventions === undefined ? {} : { ...state.conventions };
    case 'assignedSubtask':
      return state.subtasks
        .filter((s) => s.status !== 'done' && s.ownerRole === role)
        .map((s) => ({
          id: s.id,
          title: s.title,
          ownerRole: s.ownerRole,
          status: s.status,
          priority: s.priority ?? 0,
          ...(s.worktree === undefined ? {} : { worktree: structuredClone(s.worktree) }),
        }));
    case 'architecture':
      return state.architecture === undefined ? {} : { ...state.architecture };
    case 'failingTests':
      return state.testResults === undefined
        ? { passed: null, total: 0, failed: 0, failures: [] }
        : {
            passed: state.testResults.passed,
            total: state.testResults.total,
            failed: state.testResults.failed,
            failures: [...state.testResults.failures],
          };
    case 'fileRefs': {
      // Iron rule 2: path+line refs only — the truth lives in the worktree.
      const byFile = new Map<string, number[]>();
      for (const failure of state.testResults?.failures ?? []) {
        if (!isFileRef(`${failure.file}:${String(failure.line)}`)) continue;
        const lines = byFile.get(failure.file);
        if (lines === undefined) {
          byFile.set(failure.file, [failure.line]);
        } else if (!lines.includes(failure.line)) {
          lines.push(failure.line);
        }
      }
      return [...byFile.entries()].map(([file, lines]) => ({ file, lines }));
    }
    case 'acceptance':
      return {
        requirements: requirements.map((requirement) => ({
          id: requirement.id,
          acceptance: [...requirement.acceptance],
        })),
      };
    case 'branchOrIntegration':
      return branchOrIntegration(state);
    case 'interfaceContracts': {
      const declared = state.architecture?.interfaces;
      if (Array.isArray(declared)) return [...declared];
      if (typeof declared === 'object' && declared !== null) return { ...declared };
      return {}; // ARCHITECT has not declared interfaces yet
    }
    case 'reviewContext': {
      const control = latestCoordinatorControlMessage(state);
      const reason = typeof control?.payload.reason === 'string' ? control.payload.reason : null;
      const recordedStreak = control?.payload.failureStreak;
      return {
        mode: reason === 'repeated_test_failures' ? 'test_failure_root_cause' : 'quality_review',
        reason,
        failureStreak:
          typeof recordedStreak === 'number' &&
          Number.isInteger(recordedStreak) &&
          recordedStreak > 0
            ? recordedStreak
            : null,
      };
    }
    case 'reviewFeedback':
      return latestReviewFeedback(state);
    case 'coordinationContext':
      return coordinationContext(state, role);
    default:
      // All roster-declared slices are implemented above (drift-guarded by
      // project.test); an unknown name is roster/implementation drift.
      throw new Error(`unknown projection slice "${slice}" declared for role "${String(role)}"`);
  }
}

function branchOrIntegration(state: AppState): unknown {
  const candidates =
    state.integration === undefined
      ? sequentialWorktreeCandidates(state)
      : state.integration.pendingBranches.map((planned) => {
          const worker = state.workers.find((entry) => entry.workerId === planned.workerId);
          const subtask = state.subtasks.find((entry) => entry.id === planned.subtaskId);
          if (
            worker === undefined ||
            worker.status !== 'done' ||
            worker.subtaskId !== planned.subtaskId ||
            worker.worktree === undefined ||
            typeof worker.worktree === 'string' ||
            subtask === undefined ||
            subtask.worktree === undefined ||
            typeof subtask.worktree === 'string' ||
            !sameWorktreeRef(planned.worktree, worker.worktree) ||
            !sameWorktreeRef(planned.worktree, subtask.worktree)
          ) {
            throw new Error(
              `Integration branch "${planned.workerId}" conflicts with canonical WorkerState/Subtask`,
            );
          }
          return {
            workerId: worker.workerId,
            subtaskId: subtask.id,
            worktree: structuredClone(planned.worktree),
            startedTs: worker.startedTs,
          };
        });
  if (state.integration === undefined && candidates.length > 1) {
    const first = candidates[0]?.worktree;
    if (
      first === undefined ||
      candidates.some((entry) => !sameWorktreeRef(first, entry.worktree))
    ) {
      throw new Error('multiple review worktrees require canonical Integration');
    }
  }
  const selected =
    state.integration === undefined && candidates.length > 0
      ? [
          [...candidates].sort(
            (left, right) =>
              right.startedTs - left.startedTs || left.workerId.localeCompare(right.workerId),
          )[0] as (typeof candidates)[number],
        ]
      : candidates;
  const worktrees = selected
    .map(({ startedTs: _startedTs, ...entry }) => entry)
    .sort(
      (left, right) =>
        left.subtaskId.localeCompare(right.subtaskId) ||
        left.workerId.localeCompare(right.workerId),
    );
  return {
    worktrees,
    integration: state.integration === undefined ? null : structuredClone(state.integration),
  };
}

function sequentialWorktreeCandidates(state: AppState) {
  return state.subtasks
    .filter((subtask) => subtask.worktree !== undefined)
    .map((subtask) => {
      const subtaskWorktree = subtask.worktree;
      if (subtaskWorktree === undefined) {
        throw new Error(`subtask "${subtask.id}" worktree disappeared during projection`);
      }
      if (typeof subtaskWorktree === 'string') {
        throw new Error(`subtask "${subtask.id}" has an unmigrated legacy worktree`);
      }
      const matches = state.workers.filter(
        (worker) => worker.subtaskId === subtask.id && worker.worktree !== undefined,
      );
      const latestStartedTs = Math.max(...matches.map((worker) => worker.startedTs));
      const currentMatches = matches.filter((worker) => worker.startedTs === latestStartedTs);
      if (currentMatches.length !== 1) {
        throw new Error(
          `subtask "${subtask.id}" must match exactly one current WorkerState worktree`,
        );
      }
      const worker = currentMatches[0];
      const workerWorktree = worker?.worktree;
      if (
        worker === undefined ||
        workerWorktree === undefined ||
        typeof workerWorktree === 'string'
      ) {
        throw new Error(`subtask "${subtask.id}" has an unmigrated worker worktree`);
      }
      if (!sameWorktreeRef(subtaskWorktree, workerWorktree)) {
        throw new Error(`subtask "${subtask.id}" worktree conflicts with WorkerState`);
      }
      return {
        workerId: worker.workerId,
        subtaskId: subtask.id,
        worktree: structuredClone(subtaskWorktree),
        startedTs: worker.startedTs,
      };
    });
}

function sameWorktreeRef(left: WorktreeRef, right: WorktreeRef): boolean {
  return (
    left.path === right.path &&
    left.branch === right.branch &&
    left.baseCommit === right.baseCommit &&
    left.headCommit === right.headCommit
  );
}

function copiedFact(
  fact: CoordinationLedgerPayload['task']['confirmedFacts'][number],
): CoordinationLedgerPayload['task']['confirmedFacts'][number] {
  return { key: fact.key, value: fact.value };
}

function copiedPlanStep(
  step: CoordinationLedgerPayload['task']['plan'][number],
): CoordinationLedgerPayload['task']['plan'][number] {
  return {
    id: step.id,
    revision: step.revision,
    role: step.role,
    instruction: step.instruction,
    status: step.status,
    dependsOn: [...step.dependsOn],
  };
}

function copiedLedger(ledger: CoordinationLedgerPayload): CoordinationLedgerPayload {
  return {
    kind: ledger.kind,
    revision: ledger.revision,
    task: {
      confirmedFacts: ledger.task.confirmedFacts.map(copiedFact),
      hypotheses: ledger.task.hypotheses.map(copiedFact),
      plan: ledger.task.plan.map(copiedPlanStep),
    },
    progress: {
      isRequestSatisfied: { ...ledger.progress.isRequestSatisfied },
      isInLoop: { ...ledger.progress.isInLoop },
      isProgressBeingMade: { ...ledger.progress.isProgressBeingMade },
      nextSpeaker: { ...ledger.progress.nextSpeaker },
      instructionOrQuestion: { ...ledger.progress.instructionOrQuestion },
    },
    completionCandidate: ledger.completionCandidate,
    stallCount: ledger.stallCount,
    progressMarker: ledger.progressMarker,
    replanned: ledger.replanned,
    replanReason: ledger.replanReason,
  };
}

function coordinationContext(state: AppState, role: RoleId): unknown {
  const ledger = latestCoordinationLedger(state);
  if (role === 'COORDINATOR') {
    if (ledger === undefined) {
      return {
        revision: null,
        task: { confirmedFacts: [], hypotheses: [], plan: [] },
        progress: null,
        completionCandidate: false,
        stallCount: 0,
        progressMarker: null,
        replanned: false,
        replanReason: null,
      };
    }
    return copiedLedger(ledger);
  }
  if (ledger === undefined) {
    return {
      revision: null,
      confirmedFacts: [],
      plan: [],
      instructionOrQuestion: null,
      completionCandidate: false,
    };
  }
  return {
    revision: ledger.revision,
    confirmedFacts: ledger.task.confirmedFacts.map(copiedFact),
    plan: ledger.task.plan.filter((step) => step.role === role).map(copiedPlanStep),
    instructionOrQuestion:
      ledger.progress.nextSpeaker.answer === role
        ? ledger.progress.instructionOrQuestion.answer
        : null,
    completionCandidate: ledger.completionCandidate,
  };
}

function latestCoordinatorControlMessage(
  state: AppState,
): AppState['messages'][number] | undefined {
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

function latestReviewFeedback(state: AppState): {
  verdict: Record<string, unknown> | null;
  entries: Record<string, unknown>[];
} {
  let verdictIndex = -1;
  for (let index = state.reviewComments.length - 1; index >= 0; index -= 1) {
    if (state.reviewComments[index]?.kind === 'verdict') {
      verdictIndex = index;
      break;
    }
  }
  if (verdictIndex < 0) return { verdict: null, entries: [] };

  let previousVerdictIndex = -1;
  for (let index = verdictIndex - 1; index >= 0; index -= 1) {
    if (state.reviewComments[index]?.kind === 'verdict') {
      previousVerdictIndex = index;
      break;
    }
  }
  const verdict = state.reviewComments[verdictIndex];
  if (verdict === undefined) return { verdict: null, entries: [] };
  return {
    verdict: { ...verdict },
    entries: state.reviewComments.slice(previousVerdictIndex + 1).map((entry) => ({ ...entry })),
  };
}
