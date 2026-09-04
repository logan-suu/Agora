import {
  type AppState,
  activeRequirements,
  type CoordinationLedgerPayload,
  deriveObjectionResolutions,
  deriveOnboardingContext,
  latestCoordinationLedger,
  type RoleId,
  type RoleSpec,
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
  slices.onboardingContext = deriveOnboardingContext(state, role);
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
        workers: [], // Phase 9 worker registry
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
          worktree: s.worktree,
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
    case 'branchOrPatch':
      return {
        worktrees: state.subtasks
          .filter((s) => s.status !== 'done' && s.worktree !== undefined)
          .map((s) => s.worktree),
        patch: state.pendingPatch === undefined ? null : { ...state.pendingPatch },
      };
    case 'interfaceContracts': {
      const declared = state.architecture?.interfaces;
      if (Array.isArray(declared)) return [...declared];
      if (typeof declared === 'object' && declared !== null) return { ...declared };
      return {}; // ARCHITECT has not declared interfaces yet
    }
    case 'pendingPatch':
      return state.pendingPatch === undefined ? null : { ...state.pendingPatch };
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
