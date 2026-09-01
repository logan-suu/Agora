export interface ChannelSummaryDecision {
  decision: string;
  rationale: string;
}

export interface ChannelSummary {
  conclusion: string;
  keyDecisions: ChannelSummaryDecision[];
  openQuestions: string[];
  sourceMsgIds: string[];
}

export function emptyChannelSummary(): ChannelSummary {
  return {
    conclusion: 'No conclusion recorded.',
    keyDecisions: [],
    openQuestions: [],
    sourceMsgIds: [],
  };
}

export function parseChannelSummary(
  value: unknown,
  allowedSourceMsgIds: ReadonlySet<string>,
): ChannelSummary {
  const record = objectValue(value, 'channel summary');
  assertExactKeys(record, ['conclusion', 'keyDecisions', 'openQuestions', 'sourceMsgIds']);
  const conclusion = nonEmpty(record.conclusion, 'channel summary conclusion');
  if (!Array.isArray(record.keyDecisions)) {
    throw new Error('channel summary keyDecisions must be an array');
  }
  const keyDecisions = record.keyDecisions.map((value, index) => {
    const decision = objectValue(value, `channel summary keyDecisions[${index}]`);
    assertExactKeys(decision, ['decision', 'rationale']);
    return {
      decision: nonEmpty(decision.decision, `channel summary keyDecisions[${index}].decision`),
      rationale: nonEmpty(decision.rationale, `channel summary keyDecisions[${index}].rationale`),
    };
  });
  const openQuestions = stringArray(record.openQuestions, 'channel summary openQuestions');
  const sourceMsgIds = stringArray(record.sourceMsgIds, 'channel summary sourceMsgIds');
  if (new Set(sourceMsgIds).size !== sourceMsgIds.length) {
    throw new Error('channel summary sourceMsgIds must be unique');
  }
  for (const msgId of sourceMsgIds) {
    if (!allowedSourceMsgIds.has(msgId)) {
      throw new Error(`channel summary sourceMsgId "${msgId}" is outside the source channel`);
    }
  }
  return { conclusion, keyDecisions, openQuestions, sourceMsgIds };
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return [...value];
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('channel summary contains missing or unexpected fields');
  }
}
