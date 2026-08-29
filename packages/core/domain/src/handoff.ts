import type { Decision } from './ledger';

export interface HandoffPacket {
  fromRole: string;
  toRole: string;
  done: string;
  /**
   * Ids referencing decisionLedger entries
   */
  keyDecisions: string[];
  openIssues: string[];
  /**
   * Path + line references, never full code
   */
  fileRefs: string[];
  ts: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function assertValidHandoff(packet: HandoffPacket): void {
  if (typeof packet !== 'object' || packet === null || Array.isArray(packet)) {
    throw new Error('invalid handoff packet: a handoff packet object is required');
  }
  const valid =
    isNonEmptyString(packet.fromRole) &&
    isNonEmptyString(packet.toRole) &&
    isNonEmptyString(packet.done) &&
    isStringArray(packet.keyDecisions) &&
    isStringArray(packet.openIssues) &&
    isStringArray(packet.fileRefs) &&
    typeof packet.ts === 'number' &&
    Number.isFinite(packet.ts);
  if (!valid) {
    throw new Error(
      'invalid handoff packet: non-empty {fromRole, toRole, done}, string[] {keyDecisions, openIssues, fileRefs}, and a finite ts are required',
    );
  }
}

export function assertAppendableHandoff(ledger: readonly Decision[], packet: HandoffPacket): void {
  assertValidHandoff(packet);
  for (const id of packet.keyDecisions) {
    if (!ledger.some((entry) => entry.id === id)) {
      throw new Error(
        `handoff packet from "${packet.fromRole}" to "${packet.toRole}" references unknown decision id "${id}"`,
      );
    }
  }
}
