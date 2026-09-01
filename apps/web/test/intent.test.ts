import { createInitialAppState, type RoleSpec, setMutation } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import { parseLeaderIntent, planLeaderIntent } from '../src/lib/intent';

const enabledCoder: RoleSpec = {
  role: 'CODER',
  enabled: true,
  executor: 'harness',
  systemPrompt: 'code',
  tools: [],
  projection: [],
  routeWhen: 'always',
};

const disabledTester: RoleSpec = {
  ...enabledCoder,
  role: 'TESTER',
  enabled: false,
};

const roster = [enabledCoder, disabledTester];

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
    expect(parseLeaderIntent('@ split the work')).toMatchObject({ kind: 'invalid' });
  });

  it.each([
    ['/requirement add TTL', 'requirement_change', 9],
    ['/decision use an LRU list', 'decision_change', 9],
    ['/priority raise cache tests', 'priority_change', 9],
    ['/approve gate-1', 'human_gate_resolution', 8],
    ['/reject gate-1', 'human_gate_resolution', 8],
    ['/resolve-objection obj-1', 'objection_resolution', 8],
    ['/channel CODER TESTER', 'open_sub_channel', 6],
  ] as const)('maps %s to an explicit deferred phase', (display, requestedKind, targetPhase) => {
    expect(parseLeaderIntent(display)).toMatchObject({
      kind: 'deferred',
      requestedKind,
      targetPhase,
    });
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

  it('rejects unknown and disabled roles without producing mutations', () => {
    const state = createInitialAppState('task-a', 'Build a cache', 'project-a');

    expect(planLeaderIntent(parseLeaderIntent('@PM clarify it'), state, roster)).toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('PM') },
      mutations: [],
    });
    expect(planLeaderIntent(parseLeaderIntent('@TESTER test it'), state, roster)).toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('disabled') },
      mutations: [],
    });
  });

  it('does not let an assignment bypass done or humanGate state', () => {
    const done = { ...createInitialAppState('task-a', 'Build a cache'), phase: 'done' as const };
    const gated = {
      ...createInitialAppState('task-a', 'Build a cache'),
      humanGate: { reason: 'review', options: ['approve', 'reject'], phase: 'review' as const },
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
    expect(planLeaderIntent(parseLeaderIntent('/channel CODER'), state, roster)).toMatchObject({
      action: { status: 'deferred', targetPhase: 6 },
      mutations: [],
    });
    expect(planLeaderIntent(parseLeaderIntent('/unknown'), state, roster)).toMatchObject({
      action: { status: 'rejected' },
      mutations: [],
    });
  });
});
