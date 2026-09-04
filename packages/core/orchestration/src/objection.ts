import {
  type AppState,
  appendMutation,
  classifyObjection,
  type Mutation,
  type ObjectionDraft,
} from '@agora/core-domain';
import type { StepResult } from '@agora/runtime-executor';

export function planObjectionMutations(
  state: AppState,
  role: string,
  result: StepResult,
): readonly Mutation[] {
  const raw = result.output.objection;
  if (raw === undefined) return [];
  if (!result.reachedSafeBoundary) {
    throw new Error('invalid objection output: worker step has not reached a safe boundary');
  }
  if (!isRecord(raw)) throw new Error('invalid objection output: expected an object');
  assertKeys(raw, [
    'argument',
    'claim',
    'id',
    'threadId',
    ...(raw.target === undefined ? [] : ['target']),
  ]);
  const id = requireString(raw.id, 'id');
  const threadId = requireString(raw.threadId, 'threadId');
  const claim = raw.claim;
  if (claim !== 'contradiction' && claim !== 'concern') {
    throw new Error('invalid objection output: claim must be contradiction or concern');
  }
  const argument = requireString(raw.argument, 'argument');
  const target = parseTarget(raw.target);
  const messages = result.mutations.flatMap((mutation) =>
    mutation.op === 'append' && mutation.field === 'messages' ? [mutation.value] : [],
  );
  const matches = messages.filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.msgId === id,
  );
  if (matches.length !== 1) {
    throw new Error('invalid objection output: expected exactly one matching assistant message');
  }
  const message = matches[0];
  if (message === undefined) {
    throw new Error('invalid objection output: expected exactly one matching assistant message');
  }
  if (
    message.threadId !== threadId ||
    message.fromRole !== role ||
    message.type !== 'objection' ||
    typeof message.ts !== 'number' ||
    !Number.isInteger(message.ts) ||
    message.ts < 0 ||
    typeof message.display !== 'string' ||
    message.display.length === 0
  ) {
    if (message.fromRole !== role) {
      throw new Error('invalid objection output: assistant message does not match the active role');
    }
    throw new Error('invalid objection output: expected a canonical objection message');
  }
  if (!isRecord(message.payload)) {
    throw new Error('invalid objection output: expected a canonical objection message payload');
  }
  assertKeys(message.payload, ['objection']);
  const payloadObjection = message.payload.objection;
  if (!isRecord(payloadObjection)) {
    throw new Error('invalid objection output: expected a structured objection payload');
  }
  assertKeys(payloadObjection, [
    'argument',
    'claim',
    ...(payloadObjection.target === undefined ? [] : ['target']),
  ]);
  const sameTarget = targetEquals(target, parseTarget(payloadObjection.target));
  if (payloadObjection.claim !== claim || payloadObjection.argument !== argument || !sameTarget) {
    throw new Error(
      'invalid objection output: message payload does not match the structured output',
    );
  }
  const draft: ObjectionDraft = {
    id,
    threadId,
    fromRole: role,
    claim,
    ...(target === undefined ? {} : { target }),
    argument,
    ts: message.ts,
  };
  return [
    appendMutation(
      'objections',
      classifyObjection(draft, state.decisionLedger, state.requirements),
    ),
  ];
}

function parseTarget(value: unknown): ObjectionDraft['target'] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('invalid objection output: target must be an object');
  assertKeys(value, ['id', 'kind']);
  if (value.kind !== 'decision' && value.kind !== 'requirement') {
    throw new Error('invalid objection output: target kind must be decision or requirement');
  }
  return { kind: value.kind, id: requireString(value.id, 'target id') };
}

function targetEquals(left: ObjectionDraft['target'], right: ObjectionDraft['target']): boolean {
  return left?.kind === right?.kind && left?.id === right?.id;
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (keys.length !== canonical.length || keys.some((key, index) => key !== canonical[index])) {
    throw new Error('invalid objection output: unexpected or missing fields');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid objection output: ${field} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
