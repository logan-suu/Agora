import type { Decision } from './ledger';
import type { Requirement, RoleId } from './state';

export type ObjectionTrack = 'blocking' | 'advisory';
export type ObjectionClaim = 'contradiction' | 'concern';
export type ObjectionTarget =
  | { kind: 'decision'; id: string }
  | { kind: 'requirement'; id: string };

export interface ObjectionDraft {
  id: string;
  threadId: string;
  fromRole: RoleId;
  target?: ObjectionTarget;
  claim: ObjectionClaim;
  argument: string;
  ts: number;
}

export interface Objection extends ObjectionDraft {
  track: ObjectionTrack;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function classifyObjection(
  draft: ObjectionDraft,
  ledger: readonly Decision[],
  requirements: readonly Requirement[],
): Objection {
  assertDraft(draft);
  if (draft.claim === 'contradiction' && draft.target === undefined) {
    throw new Error('invalid objection: contradiction requires a target');
  }
  if (draft.target !== undefined) assertCurrentTarget(draft.target, ledger, requirements);
  return {
    ...draft,
    ...(draft.target === undefined ? {} : { target: { ...draft.target } }),
    track: draft.claim === 'contradiction' ? 'blocking' : 'advisory',
  };
}

export function assertAppendableObjection(
  existing: readonly Objection[],
  ledger: readonly Decision[],
  requirements: readonly Requirement[],
  value: unknown,
): asserts value is Objection {
  if (!isRecord(value)) throw new Error('invalid objection: an objection object is required');
  assertExactKeys(value, [
    'argument',
    'claim',
    'fromRole',
    'id',
    'threadId',
    'track',
    'ts',
    ...(value.target === undefined ? [] : ['target']),
  ]);
  const { track, ...draft } = value as unknown as Objection;
  const classified = classifyObjection(draft, ledger, requirements);
  if (track !== classified.track) {
    throw new Error(
      `invalid objection: track does not match deterministic classification (expected ${classified.track})`,
    );
  }
  const prior = existing.find((entry) => entry.id === classified.id);
  if (prior !== undefined && !sameObjection(prior, classified)) {
    throw new Error(
      `objection id "${classified.id}" already exists with different content (producer contract violation, D14 first write stays)`,
    );
  }
}

function assertDraft(value: ObjectionDraft): void {
  if (!isRecord(value)) throw new Error('invalid objection: an objection object is required');
  assertExactKeys(value, [
    'argument',
    'claim',
    'fromRole',
    'id',
    'threadId',
    'ts',
    ...(value.target === undefined ? [] : ['target']),
  ]);
  if (
    !isSafeId(value.id) ||
    !isSafeId(value.threadId) ||
    !isNonEmptyString(value.fromRole) ||
    (value.claim !== 'contradiction' && value.claim !== 'concern') ||
    !isNonEmptyString(value.argument) ||
    !Number.isInteger(value.ts) ||
    value.ts < 0
  ) {
    throw new Error('invalid objection: malformed identity, claim, argument, role, or timestamp');
  }
  if (value.id !== value.threadId) {
    throw new Error('invalid objection: threadId must equal the stable objection id');
  }
  if (value.target !== undefined) assertTargetShape(value.target);
}

function assertTargetShape(target: ObjectionTarget): void {
  if (!isRecord(target)) throw new Error('invalid objection: target must be an object');
  assertExactKeys(target, ['id', 'kind']);
  if ((target.kind !== 'decision' && target.kind !== 'requirement') || !isSafeId(target.id)) {
    throw new Error('invalid objection: target requires a known kind and safe non-empty id');
  }
}

function assertCurrentTarget(
  target: ObjectionTarget,
  ledger: readonly Decision[],
  requirements: readonly Requirement[],
): void {
  if (target.kind === 'requirement') {
    if (!requirements.some((requirement) => requirement.id === target.id)) {
      throw new Error(`invalid objection: unknown requirement "${target.id}"`);
    }
    return;
  }
  if (!ledger.some((decision) => decision.id === target.id)) {
    throw new Error(`invalid objection: unknown decision "${target.id}"`);
  }
  if (ledger.some((decision) => decision.supersedes === target.id)) {
    throw new Error(`invalid objection: decision "${target.id}" is no longer current`);
  }
}

function sameObjection(left: Objection, right: Objection): boolean {
  return (
    left.id === right.id &&
    left.threadId === right.threadId &&
    left.fromRole === right.fromRole &&
    left.claim === right.claim &&
    left.argument === right.argument &&
    left.track === right.track &&
    left.ts === right.ts &&
    left.target?.kind === right.target?.kind &&
    left.target?.id === right.target?.id
  );
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error('invalid objection: unexpected or missing fields');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}
