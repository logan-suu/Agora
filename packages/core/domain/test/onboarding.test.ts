import { describe, expect, it } from 'vitest';
import {
  type AppState,
  createInitialAppState,
  deriveOnboardingContext,
  type HandoffPacket,
  planRoleOnboarding,
  type RosterEntry,
} from '../src/index';

const SPEC = (role: string) => ({
  role,
  executor: 'harness' as const,
  systemPrompt: role,
  tools: [],
  projection: [],
  routeWhen: 'always',
});

const directPacket: HandoffPacket = {
  fromRole: 'CODER',
  toRole: 'TESTER',
  done: 'implementation complete',
  keyDecisions: [],
  openIssues: ['run acceptance tests'],
  fileRefs: ['src/cache.ts:12'],
  ts: 2,
};

const hostedPacket: HandoffPacket = {
  fromRole: 'REVIEWER',
  toRole: 'leader',
  done: 'review started',
  keyDecisions: [],
  openIssues: ['Recommendation: verify eviction ordering'],
  fileRefs: ['src/cache.ts:20-30'],
  ts: 3,
};

function departureMessage(msgId: string, actionId: string, packet: HandoffPacket) {
  return {
    msgId,
    channelId: 'main',
    fromRole: 'COORDINATOR',
    to: [packet.toRole],
    type: 'handoff' as const,
    payload: { kind: 'role_departure_handoff', actionId, packet },
    display: `${packet.fromRole} handoff`,
    ts: packet.ts,
  };
}

function roster(): RosterEntry[] {
  return [
    { spec: SPEC('COORDINATOR'), status: 'enabled' },
    {
      spec: SPEC('CODER'),
      status: 'departed',
      departure: {
        actionId: 'remove-coder',
        taskId: 'task-a',
        requestedTs: 1,
        successorRole: 'TESTER',
        stage: 'completed',
        handoffRef: { taskId: 'task-a', msgId: 'role-departure:remove-coder' },
      },
    },
    { spec: SPEC('TESTER'), status: 'enabled' },
    {
      spec: SPEC('REVIEWER'),
      status: 'departing',
      departure: {
        actionId: 'remove-reviewer',
        taskId: 'task-a',
        requestedTs: 1,
        stage: 'awaiting_replacement',
        handoffRef: { taskId: 'task-a', msgId: 'role-departure:remove-reviewer' },
      },
    },
  ];
}

function stateWithHandoffs(): AppState {
  return {
    ...createInitialAppState('task-a', 'verify cache', 'project-a'),
    messages: [
      departureMessage('role-departure:remove-coder', 'remove-coder', directPacket),
      departureMessage('role-departure:remove-reviewer', 'remove-reviewer', hostedPacket),
    ],
    handoffPackets: [structuredClone(directPacket), structuredClone(hostedPacket)],
  };
}

describe('planRoleOnboarding (D13)', () => {
  it('selects direct handoffs in State order and explicitly entrusted leader handoffs', () => {
    const state = stateWithHandoffs();
    const plan = planRoleOnboarding(state, roster(), 'onboard-tester', {
      kind: 'onboard_role',
      targetRole: 'TESTER',
      entrustedHandoffMsgIds: ['role-departure:remove-reviewer'],
    });

    expect(plan.receipt).toEqual({
      actionId: 'onboard-tester',
      role: 'TESTER',
      handoffRefs: [
        { taskId: 'task-a', msgId: 'role-departure:remove-coder' },
        { taskId: 'task-a', msgId: 'role-departure:remove-reviewer' },
      ],
    });
    expect(plan.mutations).toEqual([{ op: 'set', field: 'nextRole', value: 'TESTER' }]);
  });

  it('rejects unavailable targets, unknown refs, and handoffs claimed by another action', () => {
    const state = stateWithHandoffs();
    expect(() =>
      planRoleOnboarding(state, roster(), 'onboard-pm', {
        kind: 'onboard_role',
        targetRole: 'PM',
        entrustedHandoffMsgIds: [],
      }),
    ).toThrow(/enabled/i);
    expect(() =>
      planRoleOnboarding(state, roster(), 'onboard-tester', {
        kind: 'onboard_role',
        targetRole: 'TESTER',
        entrustedHandoffMsgIds: ['missing'],
      }),
    ).toThrow(/unknown/i);

    const first = planRoleOnboarding(state, roster(), 'onboard-tester', {
      kind: 'onboard_role',
      targetRole: 'TESTER',
      entrustedHandoffMsgIds: ['role-departure:remove-reviewer'],
    });
    state.messages.push({
      msgId: 'onboard-tester',
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat',
      payload: {
        kind: 'leader_intent',
        intent: {
          kind: 'onboard_role',
          targetRole: 'TESTER',
          entrustedHandoffMsgIds: ['role-departure:remove-reviewer'],
        },
        action: { status: 'applied' },
        onboarding: first.receipt,
      },
      display: '/role onboard TESTER from role-departure:remove-reviewer',
      ts: 4,
    });
    expect(() =>
      planRoleOnboarding(state, roster(), 'onboard-coder', {
        kind: 'onboard_role',
        targetRole: 'TESTER',
        entrustedHandoffMsgIds: ['role-departure:remove-reviewer'],
      }),
    ).toThrow(/claimed/i);
  });
});

describe('deriveOnboardingContext (D13)', () => {
  it('rebuilds the latest durable context and returns defensive copies', () => {
    const state = stateWithHandoffs();
    const receipt = planRoleOnboarding(state, roster(), 'onboard-tester', {
      kind: 'onboard_role',
      targetRole: 'TESTER',
      entrustedHandoffMsgIds: [],
    }).receipt;
    state.messages.push({
      msgId: 'onboard-tester',
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat',
      payload: {
        kind: 'leader_intent',
        intent: {
          kind: 'onboard_role',
          targetRole: 'TESTER',
          entrustedHandoffMsgIds: [],
        },
        action: { status: 'applied' },
        onboarding: receipt,
      },
      display: 'SENTINEL-RAW-DISPLAY',
      ts: 4,
    });

    const context = deriveOnboardingContext(state, 'TESTER');
    expect(context).toEqual({
      actionId: 'onboard-tester',
      role: 'TESTER',
      handoffs: [
        {
          ref: { taskId: 'task-a', msgId: 'role-departure:remove-coder' },
          packet: directPacket,
        },
      ],
    });
    expect(JSON.stringify(context)).not.toContain('SENTINEL-RAW-DISPLAY');
    context.handoffs[0]?.packet.openIssues.push('mutated');
    expect(state.handoffPackets[0]?.openIssues).toEqual(['run acceptance tests']);
  });

  it('returns an explicit empty shape and fails closed on receipt drift', () => {
    const state = stateWithHandoffs();
    expect(deriveOnboardingContext(state, 'TESTER')).toEqual({
      actionId: null,
      role: 'TESTER',
      handoffs: [],
    });

    state.messages.push({
      msgId: 'onboard-tester',
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat',
      payload: {
        kind: 'leader_intent',
        intent: {
          kind: 'onboard_role',
          targetRole: 'TESTER',
          entrustedHandoffMsgIds: [],
        },
        action: { status: 'applied' },
        onboarding: {
          actionId: 'different-action',
          role: 'TESTER',
          handoffRefs: [{ taskId: 'task-a', msgId: 'role-departure:remove-coder' }],
        },
      },
      display: '/role onboard TESTER',
      ts: 4,
    });
    expect(() => deriveOnboardingContext(state, 'TESTER')).toThrow(/actionId/i);
  });
});
