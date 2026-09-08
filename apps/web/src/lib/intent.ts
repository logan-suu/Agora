import {
  type AppState,
  type Mutation,
  normalizePhase9LeaderIntent,
  type Phase9LeaderIntent,
  type RoleSpec,
  setMutation,
} from '@agora/core-domain';

export type DeferredLeaderIntent = 'human_gate_resolution' | 'open_sub_channel';

export type LeaderIntent =
  | Phase9LeaderIntent
  | { kind: 'assign'; targetRole: string; instruction: string }
  | { kind: 'onboard_role'; targetRole: string; entrustedHandoffMsgIds: string[] }
  | { kind: 'remove_role'; targetRole: string; successorRole?: string }
  | { kind: 'open_sub_channel'; requestedRoles: string[]; topic: string }
  | { kind: 'close_sub_channel'; channelId: string }
  | { kind: 'resolve_human_gate'; gateId: string; option: string; argument?: string }
  | {
      kind: 'resolve_objection';
      objectionId: string;
      option: 'accept_objection' | 'reject_objection';
      rationale: string;
    }
  | { kind: 'chat'; text: string }
  | {
      kind: 'deferred';
      requestedKind: DeferredLeaderIntent;
      targetPhase: 6 | 8 | 9;
      reason: string;
    }
  | { kind: 'invalid'; reason: string };

export type LeaderActionStatus =
  | { status: 'applied' }
  | { status: 'blocked'; reason: string }
  | { status: 'none' }
  | { status: 'rejected'; reason: string }
  | { status: 'deferred'; targetPhase: 6 | 8 | 9; reason: string };

export interface LeaderIntentPlan {
  intent: LeaderIntent;
  action: LeaderActionStatus;
  mutations: readonly Mutation[];
}

const ROLE_MENTION = /^@[A-Za-z][A-Za-z0-9_-]*$/;
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SAFE_CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MSG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isSafeMessageId(value: string): boolean {
  return SAFE_MSG_ID.test(value);
}

export function parseLeaderIntent(display: string): LeaderIntent {
  const text = display.trim();
  if (text.length === 0) return { kind: 'invalid', reason: 'leader input cannot be empty' };

  const separator = text.search(/\s/);
  const firstToken = separator < 0 ? text : text.slice(0, separator);
  const remainder = separator < 0 ? '' : text.slice(separator).trim();

  if (firstToken.startsWith('@')) {
    const hasAdditionalMention = remainder.split(/\s+/).some((token) => token.startsWith('@'));
    if (!ROLE_MENTION.test(firstToken) || hasAdditionalMention) {
      return {
        kind: 'invalid',
        reason: 'a leading assignment must contain exactly one valid @ROLE token',
      };
    }
    return {
      kind: 'assign',
      targetRole: firstToken.slice(1).toUpperCase(),
      instruction: remainder,
    };
  }

  if (firstToken.startsWith('/')) {
    if (firstToken.toLowerCase() === '/channel') return parseChannelIntent(remainder);
    if (firstToken.toLowerCase() === '/role') return parseRoleIntent(remainder);
    if (firstToken.toLowerCase() === '/resolve-gate') return parseHumanGateIntent(remainder);
    if (firstToken.toLowerCase() === '/resolve-objection') return parseObjectionIntent(remainder);
    if (firstToken.toLowerCase() === '/requirement') return parseRequirementIntent(remainder);
    if (firstToken.toLowerCase() === '/decision') return parseDecisionIntent(remainder);
    if (firstToken.toLowerCase() === '/priority') return parsePriorityIntent(remainder);
    return { kind: 'invalid', reason: `unknown leader command "${firstToken}"` };
  }

  return { kind: 'chat', text };
}

export function planLeaderIntent(
  intent: LeaderIntent,
  state: AppState,
  roster: readonly RoleSpec[],
  knownRoles: readonly string[] = roster.map((entry) => entry.role),
): LeaderIntentPlan {
  switch (intent.kind) {
    case 'chat':
      return { intent, action: { status: 'none' }, mutations: [] };
    case 'invalid':
      return {
        intent,
        action: { status: 'rejected', reason: intent.reason },
        mutations: [],
      };
    case 'deferred':
      return {
        intent,
        action: {
          status: 'deferred',
          targetPhase: intent.targetPhase,
          reason: intent.reason,
        },
        mutations: [],
      };
    case 'open_sub_channel':
    case 'close_sub_channel':
    case 'resolve_human_gate':
    case 'resolve_objection':
    case 'requirement_change':
    case 'decision_change':
    case 'priority_change':
      return { intent, action: { status: 'applied' }, mutations: [] };
    case 'remove_role': {
      if (!knownRoles.some((entry) => entry.toUpperCase() === intent.targetRole)) {
        return rejected(intent, `unknown role "${intent.targetRole}"`);
      }
      if (intent.targetRole === 'COORDINATOR') {
        return rejected(intent, 'COORDINATOR cannot depart');
      }
      if (intent.successorRole === intent.targetRole) {
        return rejected(intent, 'departure successor must differ from target');
      }
      if (
        intent.successorRole !== undefined &&
        !roster.some((entry) => entry.role.toUpperCase() === intent.successorRole)
      ) {
        return rejected(intent, `departure successor "${intent.successorRole}" must be enabled`);
      }
      if (state.phase === 'done') {
        return rejected(intent, 'cannot remove a role after the task is done');
      }
      if (state.humanGate !== undefined) {
        return rejected(intent, 'cannot remove a role while humanGate awaits leader resolution');
      }
      return { intent, action: { status: 'applied' }, mutations: [] };
    }
    case 'onboard_role':
    case 'assign': {
      if (state.parallelExecution !== undefined)
        return rejected(
          intent,
          'parallel tasks require a wave-bound assignment; use requirement/decision/priority or resolve the active gate',
        );
      const role = roster.find((entry) => entry.role.toUpperCase() === intent.targetRole);
      if (role === undefined) {
        if (knownRoles.some((entry) => entry.toUpperCase() === intent.targetRole)) {
          return rejected(intent, `role "${intent.targetRole}" is disabled`);
        }
        return rejected(intent, `unknown role "${intent.targetRole}"`);
      }
      if (state.phase === 'done') {
        return rejected(
          intent,
          intent.kind === 'assign'
            ? 'cannot assign a role after the task is done'
            : 'cannot onboard a role after the task is done',
        );
      }
      if (state.humanGate !== undefined) {
        return rejected(
          intent,
          intent.kind === 'assign'
            ? 'cannot assign a role while humanGate awaits leader resolution'
            : 'cannot onboard a role while humanGate awaits leader resolution',
        );
      }
      return {
        intent,
        action: { status: 'applied' },
        mutations: [setMutation('nextRole', role.role)],
      };
    }
  }
}

function parseRequirementIntent(remainder: string): LeaderIntent {
  const parsed = splitCommandArgument(remainder);
  if (parsed === undefined || !SAFE_MSG_ID.test(parsed.id)) {
    return invalidPhase9Syntax('/requirement <requirementId> <JSON>');
  }
  const payload = parseJsonObject(parsed.payload);
  if (payload === undefined) return invalidPhase9Syntax('/requirement <requirementId> <JSON>');
  try {
    return normalizePhase9LeaderIntent({
      kind: 'requirement_change',
      requirementId: parsed.id,
      requirement: payload as unknown as {
        story: string;
        acceptance: string[];
        nonGoals: string[];
      },
    });
  } catch {
    return invalidPhase9Syntax('/requirement <requirementId> <JSON>');
  }
}

function parseDecisionIntent(remainder: string): LeaderIntent {
  const parsed = splitCommandArgument(remainder);
  if (parsed === undefined || !SAFE_MSG_ID.test(parsed.id)) {
    return invalidPhase9Syntax('/decision <topic> <JSON>');
  }
  const payload = parseJsonObject(parsed.payload);
  if (payload === undefined) return invalidPhase9Syntax('/decision <topic> <JSON>');
  const decisionKeys = Object.keys(payload);
  if (
    !decisionKeys.includes('decision') ||
    !decisionKeys.includes('rationale') ||
    decisionKeys.some((key) => key !== 'decision' && key !== 'rationale' && key !== 'supersedes')
  ) {
    return invalidPhase9Syntax('/decision <topic> <JSON>');
  }
  try {
    return normalizePhase9LeaderIntent({
      kind: 'decision_change',
      topic: parsed.id,
      decision: payload.decision as string,
      rationale: payload.rationale as string,
      ...(payload.supersedes === undefined ? {} : { supersedes: payload.supersedes as string }),
    } as Phase9LeaderIntent);
  } catch {
    return invalidPhase9Syntax('/decision <topic> <JSON>');
  }
}

function parsePriorityIntent(remainder: string): LeaderIntent {
  const tokens = remainder.split(/\s+/).filter((token) => token.length > 0);
  const [subtaskId, rawPriority] = tokens;
  if (
    tokens.length !== 2 ||
    subtaskId === undefined ||
    !SAFE_MSG_ID.test(subtaskId) ||
    rawPriority === undefined ||
    !/^(?:0|[1-9]\d*)$/.test(rawPriority)
  ) {
    return invalidPhase9Syntax('/priority <subtaskId> <0-100>');
  }
  try {
    return normalizePhase9LeaderIntent({
      kind: 'priority_change',
      subtaskId,
      priority: Number(rawPriority),
    });
  } catch {
    return invalidPhase9Syntax('/priority <subtaskId> <0-100>');
  }
}

function splitCommandArgument(remainder: string): { id: string; payload: string } | undefined {
  const separator = remainder.search(/\s/);
  if (separator < 1) return undefined;
  const id = remainder.slice(0, separator);
  const payload = remainder.slice(separator).trim();
  return payload.length === 0 ? undefined : { id, payload };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function invalidPhase9Syntax(syntax: string): LeaderIntent {
  return { kind: 'invalid', reason: `Phase 9 command syntax is ${syntax}` };
}

function parseHumanGateIntent(remainder: string): LeaderIntent {
  const tokens = remainder.split(/\s+/).filter((token) => token.length > 0);
  const gateId = tokens[0];
  const option = tokens[1];
  const objectionOption = option === 'accept_objection' || option === 'reject_objection';
  const completionOption = option === 'approve_completion' || option === 'request_changes';
  if (
    gateId === undefined ||
    option === undefined ||
    !SAFE_MSG_ID.test(gateId) ||
    !SAFE_MSG_ID.test(option)
  ) {
    return {
      kind: 'invalid',
      reason: 'humanGate syntax is /resolve-gate <gateId> <option> [argument]',
    };
  }
  const argument = tokens.slice(2).join(' ');
  if (
    (objectionOption && (argument.length === 0 || argument.length > 2000)) ||
    (completionOption &&
      ((option === 'request_changes' && argument.length === 0) || argument.length > 2000)) ||
    (!objectionOption &&
      !completionOption &&
      (tokens.length > 3 || (argument.length > 0 && !SAFE_MSG_ID.test(argument))))
  ) {
    return {
      kind: 'invalid',
      reason: 'humanGate syntax is /resolve-gate <gateId> <option> [argument]',
    };
  }
  return {
    kind: 'resolve_human_gate',
    gateId,
    option,
    ...(argument.length === 0 ? {} : { argument }),
  };
}

function parseObjectionIntent(remainder: string): LeaderIntent {
  const tokens = remainder.split(/\s+/).filter((token) => token.length > 0);
  const objectionId = tokens[0];
  const option = tokens[1];
  const rationale = tokens.slice(2).join(' ');
  if (
    objectionId === undefined ||
    !SAFE_MSG_ID.test(objectionId) ||
    (option !== 'accept_objection' && option !== 'reject_objection') ||
    rationale.length === 0 ||
    rationale.length > 2000
  ) {
    return {
      kind: 'invalid',
      reason:
        'objection syntax is /resolve-objection <objectionId> <accept_objection|reject_objection> <rationale...>',
    };
  }
  return { kind: 'resolve_objection', objectionId, option, rationale };
}

function parseRoleIntent(remainder: string): LeaderIntent {
  const tokens = remainder.split(/\s+/).filter((token) => token.length > 0);
  if (tokens[0]?.toLowerCase() === 'onboard') {
    const role = tokens[1];
    if (role === undefined || !ROLE_NAME.test(role)) return invalidRoleSyntax();
    if (tokens.length === 2) {
      return { kind: 'onboard_role', targetRole: role.toUpperCase(), entrustedHandoffMsgIds: [] };
    }
    if (tokens.length !== 4 || tokens[2]?.toLowerCase() !== 'from') return invalidRoleSyntax();
    const ids = (tokens[3] ?? '').split(',');
    if (ids.length === 0 || ids.some((id) => !isSafeMessageId(id))) {
      return invalidRoleSyntax();
    }
    return {
      kind: 'onboard_role',
      targetRole: role.toUpperCase(),
      entrustedHandoffMsgIds: [...new Set(ids)],
    };
  }
  if (tokens.length !== 2 && tokens.length !== 4) {
    return invalidRoleSyntax();
  }
  const [operation, role, connector, successor] = tokens;
  if (
    operation?.toLowerCase() !== 'remove' ||
    role === undefined ||
    !ROLE_NAME.test(role) ||
    (tokens.length === 4 &&
      (connector?.toLowerCase() !== 'to' || successor === undefined || !ROLE_NAME.test(successor)))
  ) {
    return invalidRoleSyntax();
  }
  return {
    kind: 'remove_role',
    targetRole: role.toUpperCase(),
    ...(successor === undefined ? {} : { successorRole: successor.toUpperCase() }),
  };
}

function invalidRoleSyntax(): LeaderIntent {
  return {
    kind: 'invalid',
    reason:
      'role syntax is /role remove <ROLE> [to <SUCCESSOR>] or /role onboard <ROLE> [from <HANDOFF_MSG_ID>[,<HANDOFF_MSG_ID>...]]',
  };
}

function parseChannelIntent(remainder: string): LeaderIntent {
  const [operation, argument, ...tail] = remainder.split(/\s+/);
  if (operation === 'open') {
    const topic = tail.join(' ').trim();
    const requestedRoles = (argument ?? '').split(',').map((role) => role.toUpperCase());
    if (
      topic.length === 0 ||
      requestedRoles.length === 0 ||
      requestedRoles.some((role) => !ROLE_NAME.test(role))
    ) {
      return {
        kind: 'invalid',
        reason: 'channel open syntax is /channel open ROLE[,ROLE...] <topic>',
      };
    }
    return { kind: 'open_sub_channel', requestedRoles, topic };
  }
  if (operation === 'close' && argument !== undefined && tail.length === 0) {
    if (!SAFE_CHANNEL_ID.test(argument)) {
      return { kind: 'invalid', reason: 'channelId must be a safe non-empty segment' };
    }
    return { kind: 'close_sub_channel', channelId: argument };
  }
  return {
    kind: 'invalid',
    reason: 'channel syntax is /channel open ROLE[,ROLE...] <topic> or /channel close <channelId>',
  };
}

function rejected(intent: LeaderIntent, reason: string): LeaderIntentPlan {
  return { intent, action: { status: 'rejected', reason }, mutations: [] };
}
