import { createInitialAppState, type RoleSpec, setMutation } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import { parseLeaderIntent, planLeaderIntent } from '../src/lib/intent';

const enabledCoder: RoleSpec = {
  role: 'CODER',
  executor: 'harness',
  systemPrompt: 'code',
  tools: [],
  projection: [],
  routeWhen: 'always',
};

const roster = [enabledCoder];

describe('parseLeaderIntent', () => {
  it('recognizes only a single leading mention as a deterministic assignment', () => {
    expect(parseLeaderIntent('  @coder implement the cache  ')).toEqual({
      kind: 'assign',
      targetRole: 'CODER',
      instruction: 'implement the cache',
    });
    expect(parseLeaderIntent('Ask @CODER to implement the cache')).toEqual({
      kind: 'chat',
      text: 'Ask @CODER to implement the cache',
    });
  });

  it('rejects malformed or multi-target leading mentions', () => {
    expect(parseLeaderIntent('@CODER,@TESTER split the work')).toMatchObject({
      kind: 'invalid',
    });
    expect(parseLeaderIntent('@CODER @TESTER split the work')).toMatchObject({
      kind: 'invalid',
    });
    expect(parseLeaderIntent('@ split the work')).toMatchObject({ kind: 'invalid' });
  });

  it.each([
    ['/requirement add TTL', 'requirement_change', 9],
    ['/decision use an LRU list', 'decision_change', 9],
    ['/priority raise cache tests', 'priority_change', 9],
  ] as const)('maps %s to an explicit deferred phase', (display, requestedKind, targetPhase) => {
    expect(parseLeaderIntent(display)).toMatchObject({
      kind: 'deferred',
      requestedKind,
      targetPhase,
    });
  });

  it('parses strict Phase 6 channel open and close commands', () => {
    expect(parseLeaderIntent('/channel open tester,coder Investigate the cache race')).toEqual({
      kind: 'open_sub_channel',
      requestedRoles: ['TESTER', 'CODER'],
      topic: 'Investigate the cache race',
    });
    expect(parseLeaderIntent('/channel close sub-task-a-action-1')).toEqual({
      kind: 'close_sub_channel',
      channelId: 'sub-task-a-action-1',
    });
  });

  it('parses the strict Phase 7 role departure command', () => {
    expect(parseLeaderIntent('/role remove coder to tester')).toEqual({
      kind: 'remove_role',
      targetRole: 'CODER',
      successorRole: 'TESTER',
    });
    expect(parseLeaderIntent('/role remove reviewer')).toEqual({
      kind: 'remove_role',
      targetRole: 'REVIEWER',
    });
  });

  it('parses the strict Phase 7 role onboarding command', () => {
    expect(parseLeaderIntent('/role onboard tester')).toEqual({
      kind: 'onboard_role',
      targetRole: 'TESTER',
      entrustedHandoffMsgIds: [],
    });
    expect(
      parseLeaderIntent(
        '/role onboard tester from role-departure:remove-coder,role-departure:remove-reviewer',
      ),
    ).toEqual({
      kind: 'onboard_role',
      targetRole: 'TESTER',
      entrustedHandoffMsgIds: ['role-departure:remove-coder', 'role-departure:remove-reviewer'],
    });
  });

  it('parses only gate-bound Phase 8 resolution commands', () => {
    expect(parseLeaderIntent('/resolve-gate human-gate:limit-1 continue')).toEqual({
      kind: 'resolve_human_gate',
      gateId: 'human-gate:limit-1',
      option: 'continue',
    });
    expect(
      parseLeaderIntent('/resolve-gate human-gate:departure-1 assign_enabled_successor TESTER'),
    ).toEqual({
      kind: 'resolve_human_gate',
      gateId: 'human-gate:departure-1',
      option: 'assign_enabled_successor',
      argument: 'TESTER',
    });
    expect(parseLeaderIntent('/approve')).toMatchObject({ kind: 'invalid' });
    expect(parseLeaderIntent('/reject')).toMatchObject({ kind: 'invalid' });
  });

  it('parses objection rulings with a free-text Leader rationale', () => {
    expect(
      parseLeaderIntent(
        '/resolve-gate human-gate:obj-1 accept_objection The revised scope is controlling.',
      ),
    ).toEqual({
      kind: 'resolve_human_gate',
      gateId: 'human-gate:obj-1',
      option: 'accept_objection',
      argument: 'The revised scope is controlling.',
    });
    expect(
      parseLeaderIntent('/resolve-objection obj-2 reject_objection The existing design is safer.'),
    ).toEqual({
      kind: 'resolve_objection',
      objectionId: 'obj-2',
      option: 'reject_objection',
      rationale: 'The existing design is safer.',
    });
    expect(parseLeaderIntent('/resolve-objection obj-2 accept_objection')).toMatchObject({
      kind: 'invalid',
    });
  });

  it('parses completion approval with optional rationale and requires rework rationale', () => {
    expect(parseLeaderIntent('/resolve-gate human-gate:review-1 approve_completion')).toEqual({
      kind: 'resolve_human_gate',
      gateId: 'human-gate:review-1',
      option: 'approve_completion',
    });
    expect(
      parseLeaderIntent(
        '/resolve-gate human-gate:review-1 request_changes Cover the restart case.',
      ),
    ).toEqual({
      kind: 'resolve_human_gate',
      gateId: 'human-gate:review-1',
      option: 'request_changes',
      argument: 'Cover the restart case.',
    });
    expect(parseLeaderIntent('/resolve-gate human-gate:review-1 request_changes')).toMatchObject({
      kind: 'invalid',
    });
  });

  it.each([
    '/role',
    '/role remove',
    '/role remove CODER to',
    '/role remove CODER TESTER',
    '/role disable CODER',
    '/role remove @CODER',
    '/role onboard',
    '/role onboard TESTER from',
    '/role onboard TESTER role-departure:remove-coder',
    '/role onboard @TESTER',
  ])('rejects malformed role departure command %s', (display) => {
    expect(parseLeaderIntent(display)).toMatchObject({ kind: 'invalid' });
  });

  it.each([
    '/channel',
    '/channel open',
    '/channel open CODER',
    '/channel open CODER, Cache race',
    '/channel close',
    '/channel close sub-a trailing',
    '/channel archive sub-a',
  ])('rejects malformed channel command %s', (display) => {
    expect(parseLeaderIntent(display)).toMatchObject({ kind: 'invalid' });
  });

  it('rejects unknown slash commands instead of silently treating them as chat', () => {
    expect(parseLeaderIntent('/ship now')).toMatchObject({
      kind: 'invalid',
      reason: expect.stringContaining('unknown'),
    });
  });
});

describe('planLeaderIntent', () => {
  it('maps a valid enabled-role assignment to nextRole', () => {
    const state = createInitialAppState('task-a', 'Build a cache', 'project-a');
    const plan = planLeaderIntent(parseLeaderIntent('@CODER implement it'), state, roster);

    expect(plan.action).toEqual({ status: 'applied' });
    expect(plan.mutations).toEqual([setMutation('nextRole', 'CODER')]);
  });

  it('maps a valid enabled-role onboarding intent to nextRole', () => {
    const state = createInitialAppState('task-a', 'Build a cache', 'project-a');
    const plan = planLeaderIntent(parseLeaderIntent('/role onboard CODER'), state, roster);

    expect(plan.action).toEqual({ status: 'applied' });
    expect(plan.mutations).toEqual([setMutation('nextRole', 'CODER')]);
  });

  it('rejects roles absent from the enabled role definitions without producing mutations', () => {
    const state = createInitialAppState('task-a', 'Build a cache', 'project-a');

    expect(planLeaderIntent(parseLeaderIntent('@PM clarify it'), state, roster)).toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('PM') },
      mutations: [],
    });
    expect(planLeaderIntent(parseLeaderIntent('@TESTER test it'), state, roster)).toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('TESTER') },
      mutations: [],
    });
    expect(
      planLeaderIntent(parseLeaderIntent('@TESTER test it'), state, roster, ['CODER', 'TESTER']),
    ).toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('disabled') },
      mutations: [],
    });
  });

  it('does not let an assignment bypass done or humanGate state', () => {
    const done = { ...createInitialAppState('task-a', 'Build a cache'), phase: 'done' as const };
    const gated = {
      ...createInitialAppState('task-a', 'Build a cache'),
      humanGate: {
        gateId: 'human-gate:review-1',
        reason: 'review',
        options: ['approve'],
        phase: 'review' as const,
        openedTs: 1,
        safePointRefs: ['ref-1'],
      },
    };

    expect(planLeaderIntent(parseLeaderIntent('@CODER work'), done, roster)).toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('done') },
      mutations: [],
    });
    expect(planLeaderIntent(parseLeaderIntent('@CODER work'), gated, roster)).toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('humanGate') },
      mutations: [],
    });
  });

  it('reports chat, deferred, and invalid input without state mutations', () => {
    const state = createInitialAppState('task-a', 'Build a cache');

    expect(planLeaderIntent(parseLeaderIntent('hello team'), state, roster)).toMatchObject({
      action: { status: 'none' },
      mutations: [],
    });
    expect(
      planLeaderIntent(parseLeaderIntent('/channel open CODER investigate'), state, roster),
    ).toMatchObject({
      action: { status: 'applied' },
      mutations: [],
    });
    expect(
      planLeaderIntent(parseLeaderIntent('/role remove CODER'), state, roster, ['CODER']),
    ).toMatchObject({ action: { status: 'applied' }, mutations: [] });
    expect(
      planLeaderIntent(parseLeaderIntent('/role remove UNKNOWN'), state, roster, ['CODER']),
    ).toMatchObject({
      action: { status: 'rejected', reason: 'unknown role "UNKNOWN"' },
      mutations: [],
    });
    expect(
      planLeaderIntent(parseLeaderIntent('/role remove COORDINATOR'), state, roster, [
        'COORDINATOR',
      ]),
    ).toMatchObject({
      action: { status: 'rejected', reason: 'COORDINATOR cannot depart' },
      mutations: [],
    });
    expect(
      planLeaderIntent(parseLeaderIntent('/role remove CODER to CODER'), state, roster, ['CODER']),
    ).toMatchObject({
      action: { status: 'rejected', reason: 'departure successor must differ from target' },
      mutations: [],
    });
    expect(
      planLeaderIntent(parseLeaderIntent('/role remove CODER to TESTER'), state, roster, [
        'CODER',
        'TESTER',
      ]),
    ).toMatchObject({
      action: { status: 'rejected', reason: 'departure successor "TESTER" must be enabled' },
      mutations: [],
    });
    expect(
      planLeaderIntent(
        parseLeaderIntent('/role remove CODER'),
        { ...state, phase: 'done' },
        roster,
        ['CODER'],
      ),
    ).toMatchObject({
      action: { status: 'rejected', reason: 'cannot remove a role after the task is done' },
      mutations: [],
    });
    expect(
      planLeaderIntent(
        parseLeaderIntent('/role remove CODER'),
        {
          ...state,
          humanGate: {
            gateId: 'human-gate:review-2',
            reason: 'review_required',
            options: ['approve'],
            phase: state.phase,
            openedTs: 2,
            safePointRefs: ['ref-2'],
          },
        },
        roster,
        ['CODER'],
      ),
    ).toMatchObject({
      action: {
        status: 'rejected',
        reason: 'cannot remove a role while humanGate awaits leader resolution',
      },
      mutations: [],
    });
    expect(planLeaderIntent(parseLeaderIntent('/unknown'), state, roster)).toMatchObject({
      action: { status: 'rejected' },
      mutations: [],
    });
  });
});
