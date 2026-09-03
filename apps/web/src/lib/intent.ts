import { type AppState, type Mutation, type RoleSpec, setMutation } from '@agora/core-domain';

export type DeferredLeaderIntent =
  | 'requirement_change'
  | 'decision_change'
  | 'human_gate_resolution'
  | 'priority_change'
  | 'objection_resolution'
  | 'open_sub_channel';

export type LeaderIntent =
  | { kind: 'assign'; targetRole: string; instruction: string }
  | { kind: 'open_sub_channel'; requestedRoles: string[]; topic: string }
  | { kind: 'close_sub_channel'; channelId: string }
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
  | { status: 'none' }
  | { status: 'rejected'; reason: string }
  | { status: 'deferred'; targetPhase: 6 | 8 | 9; reason: string };

export interface LeaderIntentPlan {
  intent: LeaderIntent;
  action: LeaderActionStatus;
  mutations: readonly Mutation[];
}

const DEFERRED_COMMANDS: Readonly<
  Record<string, { requestedKind: DeferredLeaderIntent; targetPhase: 6 | 8 | 9; reason: string }>
> = {
  '/requirement': {
    requestedKind: 'requirement_change',
    targetPhase: 9,
    reason: 'requirement changes require Phase 9 safe-point preemption and rerouting',
  },
  '/decision': {
    requestedKind: 'decision_change',
    targetPhase: 9,
    reason: 'decision changes require Phase 9 safe-point preemption and rerouting',
  },
  '/priority': {
    requestedKind: 'priority_change',
    targetPhase: 9,
    reason: 'priority changes require Phase 9 safe-point preemption and rerouting',
  },
  '/approve': {
    requestedKind: 'human_gate_resolution',
    targetPhase: 8,
    reason: 'humanGate resolution is implemented in Phase 8',
  },
  '/reject': {
    requestedKind: 'human_gate_resolution',
    targetPhase: 8,
    reason: 'humanGate resolution is implemented in Phase 8',
  },
  '/resolve-objection': {
    requestedKind: 'objection_resolution',
    targetPhase: 8,
    reason: 'objection resolution is implemented in Phase 8',
  },
};

const ROLE_MENTION = /^@[A-Za-z][A-Za-z0-9_-]*$/;
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SAFE_CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
    const deferred = DEFERRED_COMMANDS[firstToken.toLowerCase()];
    if (deferred === undefined) {
      return { kind: 'invalid', reason: `unknown leader command "${firstToken}"` };
    }
    return { kind: 'deferred', ...deferred };
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
      return { intent, action: { status: 'applied' }, mutations: [] };
    case 'assign': {
      const role = roster.find((entry) => entry.role.toUpperCase() === intent.targetRole);
      if (role === undefined) {
        if (knownRoles.some((entry) => entry.toUpperCase() === intent.targetRole)) {
          return rejected(intent, `role "${intent.targetRole}" is disabled`);
        }
        return rejected(intent, `unknown role "${intent.targetRole}"`);
      }
      if (state.phase === 'done') {
        return rejected(intent, 'cannot assign a role after the task is done');
      }
      if (state.humanGate !== undefined) {
        return rejected(intent, 'cannot assign a role while humanGate awaits leader resolution');
      }
      return {
        intent,
        action: { status: 'applied' },
        mutations: [setMutation('nextRole', role.role)],
      };
    }
  }
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
