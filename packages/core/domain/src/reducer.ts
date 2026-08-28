import type {
  AppState,
  HumanGate,
  Message,
  Phase,
  Requirement,
  Subtask,
  TestResults,
} from './state';

export const APPEND_FIELDS = [
  'messages',
  'decisionLedger',
  'objections',
  'handoffPackets',
  'appliedHistory',
  'reviewComments',
] as const;
export type AppendField = (typeof APPEND_FIELDS)[number];

export const MERGE_BY_ID_FIELDS = [
  'workers',
  'subtasks',
  'channels',
  'roster',
  'requirements',
] as const;
export type MergeByIdField = (typeof MERGE_BY_ID_FIELDS)[number];

export const SET_FIELDS = [
  'testResults',
  'phase',
  'nextRole',
  'iterationCount',
  'humanGate',
  'integration',
  'architecture',
] as const;
export type SetField = (typeof SET_FIELDS)[number];

export const ENABLED_APPEND_FIELDS: readonly AppendField[] = ['messages', 'reviewComments'];
export const ENABLED_MERGE_BY_ID_FIELDS: readonly MergeByIdField[] = ['subtasks', 'requirements'];
export const ENABLED_SET_FIELDS: readonly SetField[] = [
  'testResults',
  'phase',
  'nextRole',
  'iterationCount',
  'humanGate',
  'architecture',
];

export type Mutation =
  | { field: AppendField; op: 'append'; value: unknown }
  | { field: MergeByIdField; op: 'mergeById'; value: { id: string } }
  | { field: SetField; op: 'set'; value: unknown };

export function appendMutation(field: AppendField, value: unknown): Mutation {
  return { field, op: 'append', value };
}

export function mergeByIdMutation(
  field: MergeByIdField,
  id: string,
  patch: Record<string, unknown>,
): Mutation {
  return { field, op: 'mergeById', value: { ...patch, id } as { id: string } };
}

export function setMutation(field: SetField, value: unknown): Mutation {
  return { field, op: 'set', value };
}

function isNotEnabled(field: string, enabled: readonly string[]): boolean {
  return !enabled.includes(field);
}

function isHumanGate(value: unknown): value is HumanGate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.reason === 'string' &&
    Array.isArray(record.options) &&
    record.options.every((option) => typeof option === 'string') &&
    typeof record.phase === 'string'
  );
}

function disabledFieldError(field: string): Error {
  return new Error(`mutation field "${field}" is defined by spec §1 but not enabled in Phase 0`);
}

function identityKeyOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const key = record.msgId ?? record.id;
  return typeof key === 'string' ? key : undefined;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => key in rightRecord && deepEqual(leftRecord[key], rightRecord[key]),
  );
}

function deduplicatedAppend(list: readonly unknown[], value: unknown): unknown[] {
  const key = identityKeyOf(value);
  if (key !== undefined) {
    if (list.some((item) => identityKeyOf(item) === key)) return [...list];
    return [...list, value];
  }
  if (list.some((item) => deepEqual(item, value))) return [...list];
  return [...list, value];
}

function applyAppend(state: AppState, field: AppendField, value: unknown): AppState {
  if (isNotEnabled(field, ENABLED_APPEND_FIELDS)) throw disabledFieldError(field);
  switch (field) {
    case 'messages':
      return { ...state, messages: deduplicatedAppend(state.messages, value) as Message[] };
    case 'reviewComments':
      return {
        ...state,
        reviewComments: deduplicatedAppend(state.reviewComments, value) as Record<
          string,
          unknown
        >[],
      };
    default:
      throw new Error(`no writer registered for append field "${field}"`);
  }
}

function applyMergeById(state: AppState, field: MergeByIdField, value: { id: string }): AppState {
  if (isNotEnabled(field, ENABLED_MERGE_BY_ID_FIELDS)) throw disabledFieldError(field);
  switch (field) {
    case 'subtasks': {
      const index = state.subtasks.findIndex((item) => item.id === value.id);
      if (index < 0) return { ...state, subtasks: [...state.subtasks, value as Subtask] };
      const existing = state.subtasks[index];
      if (existing === undefined) {
        throw new Error(`subtask "${value.id}" disappeared during merge`);
      }
      const merged: Subtask = { ...existing, ...value };
      const subtasks = state.subtasks.slice();
      subtasks[index] = merged;
      return { ...state, subtasks };
    }
    case 'requirements': {
      const index = state.requirements.findIndex((item) => item.id === value.id);
      if (index < 0) {
        return { ...state, requirements: [...state.requirements, value as Requirement] };
      }
      const existing = state.requirements[index];
      if (existing === undefined) {
        throw new Error(`requirement "${value.id}" disappeared during merge`);
      }
      const merged: Requirement = { ...existing, ...value };
      const requirements = state.requirements.slice();
      requirements[index] = merged;
      return { ...state, requirements };
    }
    default:
      throw new Error(`no writer registered for mergeById field "${field}"`);
  }
}

function applySet(state: AppState, field: SetField, value: unknown): AppState {
  if (isNotEnabled(field, ENABLED_SET_FIELDS)) throw disabledFieldError(field);
  switch (field) {
    case 'testResults':
      return { ...state, testResults: value as TestResults };
    case 'phase':
      return { ...state, phase: value as Phase };
    case 'nextRole':
      return { ...state, nextRole: value as string };
    case 'iterationCount':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('iterationCount must be a non-negative integer');
      }
      return { ...state, iterationCount: value };
    case 'humanGate':
      if (!isHumanGate(value)) {
        throw new Error('humanGate must be { reason: string; options: string[]; phase: Phase }');
      }
      return { ...state, humanGate: value };
    case 'architecture':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('architecture must be a non-array object');
      }
      return { ...state, architecture: value as Record<string, unknown> };
    default:
      throw new Error(`no writer registered for set field "${field}"`);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable mutation variant: ${String(value)}`);
}

export function applyMutations(state: AppState, mutations: readonly Mutation[]): AppState {
  let current = { ...state };
  for (const mutation of mutations) {
    switch (mutation.op) {
      case 'append':
        current = applyAppend(current, mutation.field, mutation.value);
        break;
      case 'mergeById':
        current = applyMergeById(current, mutation.field, mutation.value);
        break;
      case 'set':
        current = applySet(current, mutation.field, mutation.value);
        break;
      default:
        assertNever(mutation);
    }
  }
  return current;
}
