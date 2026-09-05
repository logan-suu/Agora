import type { ObjectionTarget } from './objection';

export type Authority = 'leader' | 'agent';

export interface ObjectionResolutionRecord {
  objectionId: string;
  outcome: 'accepted' | 'rejected';
  target?: ObjectionTarget;
}

export interface Decision {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  authority: Authority;
  by: string;
  supersedes?: string;
  objectionResolution?: ObjectionResolutionRecord;
  ts: number;
}

export interface DecisionConflict {
  existingId: string;
  incomingId: string;
  topic: string;
}

const AUTHORITIES: readonly Authority[] = ['leader', 'agent'];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertValidDecision(decision: Decision): void {
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) {
    throw new Error('invalid decision: a decision object is required');
  }
  const valid =
    isNonEmptyString(decision.id) &&
    isNonEmptyString(decision.topic) &&
    isNonEmptyString(decision.decision) &&
    isNonEmptyString(decision.rationale) &&
    isNonEmptyString(decision.by) &&
    typeof decision.ts === 'number' &&
    Number.isFinite(decision.ts) &&
    AUTHORITIES.includes(decision.authority);
  if (!valid) {
    throw new Error(
      'invalid decision: non-empty {id, topic, decision, rationale, by}, a finite ts, and authority in ("leader" | "agent") are required',
    );
  }
  if (decision.objectionResolution !== undefined) {
    assertValidObjectionResolution(decision);
  }
}

function assertValidObjectionResolution(decision: Decision): void {
  const resolution = decision.objectionResolution;
  if (
    resolution === undefined ||
    typeof resolution !== 'object' ||
    resolution === null ||
    Array.isArray(resolution) ||
    !isNonEmptyString(resolution.objectionId) ||
    !SAFE_ID.test(resolution.objectionId) ||
    (resolution.outcome !== 'accepted' && resolution.outcome !== 'rejected') ||
    decision.authority !== 'leader' ||
    decision.by !== 'leader' ||
    (decision.decision !== 'accept_objection' && decision.decision !== 'reject_objection') ||
    (resolution.outcome === 'accepted') !== (decision.decision === 'accept_objection') ||
    !hasExactKeys(resolution, [
      'objectionId',
      'outcome',
      ...(resolution.target === undefined ? [] : ['target']),
    ])
  ) {
    throw new Error('invalid decision: objection resolution must be a canonical leader ruling');
  }
  if (resolution.target !== undefined) {
    if (
      typeof resolution.target !== 'object' ||
      resolution.target === null ||
      (resolution.target.kind !== 'decision' && resolution.target.kind !== 'requirement') ||
      !isNonEmptyString(resolution.target.id) ||
      !SAFE_ID.test(resolution.target.id) ||
      !hasExactKeys(resolution.target, ['id', 'kind'])
    ) {
      throw new Error('invalid decision: objection resolution target is malformed');
    }
  }
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}

function sameContent(left: Decision, right: Decision): boolean {
  return (
    left.topic === right.topic &&
    left.decision === right.decision &&
    left.rationale === right.rationale &&
    left.authority === right.authority &&
    left.by === right.by &&
    left.supersedes === right.supersedes &&
    sameObjectionResolution(left.objectionResolution, right.objectionResolution) &&
    left.ts === right.ts
  );
}

function sameObjectionResolution(
  left: ObjectionResolutionRecord | undefined,
  right: ObjectionResolutionRecord | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.objectionId === right.objectionId &&
    left.outcome === right.outcome &&
    left.target?.kind === right.target?.kind &&
    left.target?.id === right.target?.id
  );
}

function assertSupersedesIsLegal(ledger: readonly Decision[], decision: Decision): void {
  if (decision.supersedes === undefined) return;
  const superseded = ledger.find((entry) => entry.id === decision.supersedes);
  if (superseded === undefined) {
    throw new Error(
      `decision "${decision.id}" supersedes unknown decision id "${decision.supersedes}"`,
    );
  }
  if (ledger.some((entry) => entry.supersedes === superseded.id)) {
    throw new Error(
      `decision "${decision.id}" cannot supersede decision "${superseded.id}": target is no longer current`,
    );
  }
  if (superseded.topic !== decision.topic) {
    throw new Error(
      `decision "${decision.id}" cannot supersede decision "${superseded.id}": both decisions must use the same topic`,
    );
  }
  if (superseded.authority === 'leader' && decision.authority === 'agent') {
    throw new Error(
      `decision "${decision.id}" (authority=agent) cannot supersede leader-level decision "${superseded.id}": only the leader may override a leader-level decision (blueprint §14)`,
    );
  }
}

export function assertAppendableDecision(ledger: readonly Decision[], decision: Decision): void {
  assertValidDecision(decision);
  if (ledger.some((entry) => entry.id === decision.id)) return;
  assertSupersedesIsLegal(ledger, decision);
}

export function addDecision(
  ledger: readonly Decision[],
  decision: Decision,
): { ledger: Decision[]; conflicts: DecisionConflict[] } {
  assertValidDecision(decision);

  const existingSameId = ledger.find((entry) => entry.id === decision.id);
  if (existingSameId !== undefined) {
    if (sameContent(existingSameId, decision)) {
      return { ledger: [...ledger], conflicts: [] };
    }
    throw new Error(
      `decision id "${decision.id}" already exists with different content (producer contract violation, spec §1: first write stays)`,
    );
  }

  assertSupersedesIsLegal(ledger, decision);

  const conflicts: DecisionConflict[] = ledger
    .filter((entry) => entry.topic === decision.topic && entry.id !== decision.supersedes)
    .map((entry) => ({ existingId: entry.id, incomingId: decision.id, topic: decision.topic }));

  return { ledger: [...ledger, decision], conflicts };
}
