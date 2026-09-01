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
  '/channel': {
    requestedKind: 'open_sub_channel',
    targetPhase: 6,
    reason: 'dynamic sub channels are implemented in Phase 6',
  },
};

const ROLE_MENTION = /^@[A-Za-z][A-Za-z0-9_-]*$/;

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
    case 'assign': {
      const role = roster.find((entry) => entry.role.toUpperCase() === intent.targetRole);
      if (role === undefined) {
        return rejected(intent, `unknown role "${intent.targetRole}"`);
      }
      if (!role.enabled) {
        return rejected(intent, `role "${intent.targetRole}" is disabled`);
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

function rejected(intent: LeaderIntent, reason: string): LeaderIntentPlan {
  return { intent, action: { status: 'rejected', reason }, mutations: [] };
}
