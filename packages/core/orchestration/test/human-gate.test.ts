import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import { materializeHumanGate, planHumanGateResolution } from '../src/human-gate';

describe('humanGate durable lifecycle planning (task 8.1)', () => {
  it('materializes a stable complete gate only after checkpoint refs are supplied', () => {
    const request = {
      triggerMsgId: 'escalation-1',
      triggerTs: 123,
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'testing' as const,
    };
    expect(materializeHumanGate(request, ['ref-1'])).toEqual({
      gateId: 'human-gate:escalation-1',
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'testing',
      openedTs: 123,
      safePointRefs: ['ref-1'],
    });
    expect(materializeHumanGate(request, ['ref-1'])).toEqual(
      materializeHumanGate(request, ['ref-1']),
    );
  });

  it('continues an iteration-limit gate in one mutation plan and retains refs in the receipt', () => {
    const state = applyMutations(createInitialAppState('task-1', 'goal', 'project-1'), [
      setMutation('iterationCount', 8),
      setMutation(
        'humanGate',
        materializeHumanGate(
          {
            triggerMsgId: 'limit-1',
            triggerTs: 123,
            reason: 'iteration_limit',
            options: ['continue'],
            phase: 'testing',
          },
          ['ref-1'],
        ),
      ),
    ]);
    const plan = planHumanGateResolution(state, {
      actionId: 'resolve-1',
      gateId: 'human-gate:limit-1',
      option: 'continue',
      enabledRoles: [],
    });
    const resolved = applyMutations(state, plan.mutations);
    expect(resolved.iterationCount).toBe(0);
    expect(resolved.humanGate).toBeUndefined();
    expect(plan.receipt).toEqual({
      gateId: 'human-gate:limit-1',
      option: 'continue',
      safePointRefs: ['ref-1'],
      resumeSessionId: 'human-gate-resume:resolve-1',
    });
  });

  it('requires the unavailable role to be enabled before retry', () => {
    const base = createInitialAppState('task-1', 'goal');
    const state = applyMutations(base, [
      setMutation(
        'humanGate',
        materializeHumanGate(
          {
            triggerMsgId: 'role-1',
            triggerTs: 123,
            reason: 'required_role_unavailable:TESTER',
            options: ['retry'],
            phase: 'testing',
          },
          [],
        ),
      ),
    ]);
    expect(() =>
      planHumanGateResolution(state, {
        actionId: 'resolve-2',
        gateId: 'human-gate:role-1',
        option: 'retry',
        enabledRoles: ['CODER'],
      }),
    ).toThrow('required role "TESTER" is not enabled');
    expect(
      planHumanGateResolution(state, {
        actionId: 'resolve-2',
        gateId: 'human-gate:role-1',
        option: 'retry',
        enabledRoles: ['TESTER'],
      }).mutations,
    ).toEqual([setMutation('humanGate', undefined)]);
  });

  it('atomically transfers blocked responsibilities for a departure replacement', () => {
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      mergeByIdMutation('subtasks', 'sub-1', {
        title: 'work',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'blocked',
      }),
      setMutation(
        'humanGate',
        materializeHumanGate(
          {
            triggerMsgId: 'departure-1',
            triggerTs: 123,
            reason: 'role_departure_requires_replacement:CODER',
            options: ['assign_enabled_successor'],
            phase: 'coding',
          },
          ['ref-1'],
        ),
      ),
    ]);
    const plan = planHumanGateResolution(state, {
      actionId: 'resolve-3',
      gateId: 'human-gate:departure-1',
      option: 'assign_enabled_successor',
      argument: 'TESTER',
      enabledRoles: ['TESTER'],
    });
    const resolved = applyMutations(state, plan.mutations);
    expect(resolved.subtasks[0]).toMatchObject({ ownerRole: 'TESTER', status: 'todo' });
    expect(resolved.humanGate).toBeUndefined();
  });

  it('fails closed for stale gates, unsupported options, and conflicting arguments', () => {
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      setMutation(
        'humanGate',
        materializeHumanGate(
          {
            triggerMsgId: 'limit-1',
            triggerTs: 1,
            reason: 'iteration_limit',
            options: ['continue'],
            phase: 'testing',
          },
          ['ref-1'],
        ),
      ),
    ]);
    expect(() =>
      planHumanGateResolution(state, {
        actionId: 'a',
        gateId: 'stale',
        option: 'continue',
        enabledRoles: [],
      }),
    ).toThrow('does not match the active gate');
    expect(() =>
      planHumanGateResolution(state, {
        actionId: 'a',
        gateId: 'human-gate:limit-1',
        option: 'abort',
        enabledRoles: [],
      }),
    ).toThrow('is not allowed');
    expect(() =>
      planHumanGateResolution(state, {
        actionId: 'a',
        gateId: 'human-gate:limit-1',
        option: 'continue',
        argument: 'x',
        enabledRoles: [],
      }),
    ).toThrow('does not accept an argument');
  });
});
