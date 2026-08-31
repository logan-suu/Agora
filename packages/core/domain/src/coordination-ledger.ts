import type { AppState, RoleId } from './state';

export const COORDINATION_LEDGER_KIND = 'coordination_ledger';

export interface LedgerFact {
  key: string;
  value: string | number | boolean | null;
}

export interface LedgerPlanStep {
  id: string;
  revision: number;
  role: RoleId;
  instruction: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  dependsOn: string[];
}

export interface TaskLedger {
  confirmedFacts: LedgerFact[];
  hypotheses: LedgerFact[];
  plan: LedgerPlanStep[];
}

interface ReasonedAnswer<T> {
  reason: string;
  answer: T;
}

export interface ProgressLedger {
  isRequestSatisfied: ReasonedAnswer<boolean> & { authority: 'leader' };
  isInLoop: ReasonedAnswer<boolean>;
  isProgressBeingMade: ReasonedAnswer<boolean>;
  nextSpeaker: ReasonedAnswer<string | null>;
  instructionOrQuestion: ReasonedAnswer<string>;
}

export interface CoordinationLedgerPayload extends Record<string, unknown> {
  kind: typeof COORDINATION_LEDGER_KIND;
  revision: number;
  task: TaskLedger;
  progress: ProgressLedger;
  completionCandidate: boolean;
  stallCount: number;
  progressMarker: string;
  replanned: boolean;
  replanReason: 'max_stalls_reached' | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

const REASONED_ANSWER_KEYS = ['reason', 'answer'] as const;

function isReasonedBoolean(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, REASONED_ANSWER_KEYS) &&
    typeof value.reason === 'string' &&
    typeof value.answer === 'boolean'
  );
}

function isLedgerFact(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['key', 'value']) ||
    typeof value.key !== 'string' ||
    value.key.length === 0
  ) {
    return false;
  }
  return (
    value.value === null ||
    typeof value.value === 'string' ||
    typeof value.value === 'number' ||
    typeof value.value === 'boolean'
  );
}

const PLAN_STATUSES = new Set(['pending', 'active', 'done', 'blocked']);

function isLedgerPlanStep(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'revision', 'role', 'instruction', 'status', 'dependsOn']) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    value.revision > 0 &&
    typeof value.role === 'string' &&
    value.role.length > 0 &&
    typeof value.instruction === 'string' &&
    typeof value.status === 'string' &&
    PLAN_STATUSES.has(value.status) &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.every((id) => typeof id === 'string')
  );
}

function isLedgerPayload(value: unknown): value is CoordinationLedgerPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'revision',
      'task',
      'progress',
      'completionCandidate',
      'stallCount',
      'progressMarker',
      'replanned',
      'replanReason',
    ]) ||
    value.kind !== COORDINATION_LEDGER_KIND
  ) {
    return false;
  }
  if (
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.stallCount !== 'number' ||
    !Number.isInteger(value.stallCount) ||
    value.stallCount < 0 ||
    typeof value.progressMarker !== 'string' ||
    typeof value.replanned !== 'boolean' ||
    typeof value.completionCandidate !== 'boolean' ||
    (value.replanReason !== null && value.replanReason !== 'max_stalls_reached')
  ) {
    return false;
  }
  if (
    !isRecord(value.task) ||
    !hasExactKeys(value.task, ['confirmedFacts', 'hypotheses', 'plan']) ||
    !isRecord(value.progress) ||
    !hasExactKeys(value.progress, [
      'isRequestSatisfied',
      'isInLoop',
      'isProgressBeingMade',
      'nextSpeaker',
      'instructionOrQuestion',
    ])
  ) {
    return false;
  }
  if (
    !Array.isArray(value.task.confirmedFacts) ||
    !Array.isArray(value.task.hypotheses) ||
    !Array.isArray(value.task.plan) ||
    !value.task.confirmedFacts.every(isLedgerFact) ||
    !value.task.hypotheses.every(isLedgerFact) ||
    !value.task.plan.every(isLedgerPlanStep)
  ) {
    return false;
  }
  const progress = value.progress;
  return (
    isRecord(progress.isRequestSatisfied) &&
    hasExactKeys(progress.isRequestSatisfied, ['reason', 'answer', 'authority']) &&
    typeof progress.isRequestSatisfied.reason === 'string' &&
    typeof progress.isRequestSatisfied.answer === 'boolean' &&
    progress.isRequestSatisfied.authority === 'leader' &&
    isReasonedBoolean(progress.isInLoop) &&
    isReasonedBoolean(progress.isProgressBeingMade) &&
    isRecord(progress.nextSpeaker) &&
    hasExactKeys(progress.nextSpeaker, REASONED_ANSWER_KEYS) &&
    typeof progress.nextSpeaker.reason === 'string' &&
    (typeof progress.nextSpeaker.answer === 'string' || progress.nextSpeaker.answer === null) &&
    isRecord(progress.instructionOrQuestion) &&
    hasExactKeys(progress.instructionOrQuestion, REASONED_ANSWER_KEYS) &&
    typeof progress.instructionOrQuestion.reason === 'string' &&
    typeof progress.instructionOrQuestion.answer === 'string'
  );
}

export function latestCoordinationLedger(state: AppState): CoordinationLedgerPayload | undefined {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (
      message?.fromRole === 'COORDINATOR' &&
      message.type === 'chat' &&
      isLedgerPayload(message.payload)
    ) {
      return message.payload;
    }
  }
  return undefined;
}
