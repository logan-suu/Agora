export type Authority = 'leader' | 'agent';

export interface Decision {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  authority: Authority;
  by: string;
  supersedes?: string;
  ts: number;
}

export interface DecisionConflict {
  existingId: string;
  incomingId: string;
  topic: string;
}

const AUTHORITIES: readonly Authority[] = ['leader', 'agent'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertValidDecision(decision: Decision): void {
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
}

function sameContent(left: Decision, right: Decision): boolean {
  return (
    left.topic === right.topic &&
    left.decision === right.decision &&
    left.rationale === right.rationale &&
    left.authority === right.authority &&
    left.by === right.by &&
    left.supersedes === right.supersedes &&
    left.ts === right.ts
  );
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

  if (decision.supersedes !== undefined) {
    const superseded = ledger.find((entry) => entry.id === decision.supersedes);
    if (superseded === undefined) {
      throw new Error(
        `decision "${decision.id}" supersedes unknown decision id "${decision.supersedes}"`,
      );
    }
    if (superseded.authority === 'leader' && decision.authority === 'agent') {
      throw new Error(
        `decision "${decision.id}" (authority=agent) cannot supersede leader-level decision "${superseded.id}": only the leader may override a leader-level decision (blueprint §14)`,
      );
    }
  }

  const conflicts: DecisionConflict[] = ledger
    .filter((entry) => entry.topic === decision.topic && entry.id !== decision.supersedes)
    .map((entry) => ({ existingId: entry.id, incomingId: decision.id, topic: decision.topic }));

  return { ledger: [...ledger, decision], conflicts };
}
