import {
  type AppState,
  activeRequirements,
  COORDINATION_LEDGER_KIND,
  type CoordinationLedgerPayload,
  type LedgerFact,
  type LedgerPlanStep,
  latestCoordinationLedger,
  type RoleId,
} from '@agora/core-domain';

export {
  COORDINATION_LEDGER_KIND,
  type CoordinationLedgerPayload,
  type LedgerFact,
  type LedgerPlanStep,
  latestCoordinationLedger,
} from '@agora/core-domain';

export const MAX_STALLS = 3;

export interface ProgressObservation {
  nextSpeaker: string | null;
  instruction: string;
  completionCandidate: boolean;
  availableRoles?: readonly string[];
  loopReason?: string;
}

const FULL_MACHINE_ROLES: readonly RoleId[] = ['PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER'];

function factsOf(state: AppState): LedgerFact[] {
  const requirements = activeRequirements(state);
  return [
    { key: 'goal', value: state.goal },
    { key: 'phase', value: state.phase },
    { key: 'complexityTier', value: state.complexity?.tier ?? null },
    { key: 'requirementsCount', value: requirements.length },
    { key: 'architectureReady', value: state.architecture !== undefined },
    {
      key: 'completedSubtasks',
      value: state.subtasks.filter((subtask) => subtask.status === 'done').length,
    },
    { key: 'testsPassed', value: state.testResults?.passed ?? null },
    { key: 'reviewEntries', value: state.reviewComments.length },
  ];
}

function rolesForTier(state: AppState): RoleId[] {
  return state.complexity?.tier === 0 ? ['CODER', 'TESTER', 'REVIEWER'] : [...FULL_MACHINE_ROLES];
}

function roleIsAvailable(role: RoleId, availableRoles: readonly string[] | undefined): boolean {
  return availableRoles === undefined || availableRoles.includes(role);
}

function roleIsDone(state: AppState, role: RoleId): boolean {
  switch (role) {
    case 'PM':
      return activeRequirements(state).length > 0;
    case 'ARCHITECT':
      return state.architecture !== undefined;
    case 'CODER':
      return (
        state.subtasks.length > 0 && state.subtasks.every((subtask) => subtask.status === 'done')
      );
    case 'TESTER':
      return state.testResults?.passed === true;
    case 'REVIEWER':
      return state.reviewComments.some(
        (entry) => entry.kind === 'verdict' && entry.verdict === 'approved',
      );
    default:
      return false;
  }
}

function planOf(
  state: AppState,
  observation: ProgressObservation,
  revision: number,
): LedgerPlanStep[] {
  const roles = rolesForTier(state).filter((role) =>
    roleIsAvailable(role, observation.availableRoles),
  );
  return roles.map((role, index) => {
    const previous = roles[index - 1];
    return {
      id: `coordination-plan-r${revision}-${String(index + 1)}`,
      revision,
      role,
      instruction:
        role === observation.nextSpeaker
          ? observation.instruction
          : `Complete the ${String(role)} stage when routed`,
      status:
        role === observation.nextSpeaker ? 'active' : roleIsDone(state, role) ? 'done' : 'pending',
      dependsOn: previous === undefined ? [] : [`coordination-plan-r${revision}-${String(index)}`],
    };
  });
}

function markerOf(state: AppState): string {
  const requirements = activeRequirements(state);
  return JSON.stringify({
    phase: state.phase,
    complexityTier: state.complexity?.tier ?? null,
    requirementIds: requirements.map((requirement) => requirement.id),
    architectureReady: state.architecture !== undefined,
    subtasks: state.subtasks.map((subtask) => ({ id: subtask.id, status: subtask.status })),
    testOutcome:
      state.testResults === undefined
        ? null
        : {
            passed: state.testResults.passed,
            total: state.testResults.total,
            failed: state.testResults.failed,
          },
    reviewEntries: state.reviewComments.length,
    humanGateReason: state.humanGate?.reason ?? null,
  });
}

export function buildCoordinationLedger(
  state: AppState,
  observation: ProgressObservation,
): CoordinationLedgerPayload {
  const previous = latestCoordinationLedger(state);
  const progressMarker = markerOf(state);
  const loopReason =
    observation.loopReason ??
    (previous !== undefined && previous.progressMarker === progressMarker
      ? 'no_structured_progress'
      : undefined);
  const inLoop = loopReason !== undefined;
  const accumulatedStalls = inLoop ? (previous?.stallCount ?? 0) + 1 : 0;
  const replanned = accumulatedStalls >= MAX_STALLS;
  const revision = (previous?.revision ?? 1) + (replanned ? 1 : 0);
  const stallCount = replanned ? 0 : accumulatedStalls;
  const firstEvaluation = previous === undefined && !inLoop;

  return {
    kind: COORDINATION_LEDGER_KIND,
    revision,
    task: {
      confirmedFacts: factsOf(state),
      hypotheses: [],
      plan: planOf(state, observation, revision),
    },
    progress: {
      isRequestSatisfied: {
        reason: observation.completionCandidate
          ? 'awaiting_leader_confirmation'
          : 'task_incomplete',
        answer: false,
        authority: 'leader',
      },
      isInLoop: {
        reason: loopReason ?? (firstEvaluation ? 'first_evaluation' : 'structured_state_advanced'),
        answer: inLoop,
      },
      isProgressBeingMade: {
        reason: inLoop ? (loopReason ?? 'no_structured_progress') : 'structured_state_advanced',
        answer: !inLoop,
      },
      nextSpeaker: { reason: 'coordinator_route', answer: observation.nextSpeaker },
      instructionOrQuestion: {
        reason: 'coordinator_instruction',
        answer: observation.instruction,
      },
    },
    completionCandidate: observation.completionCandidate,
    stallCount,
    progressMarker,
    replanned,
    replanReason: replanned ? 'max_stalls_reached' : null,
  };
}
