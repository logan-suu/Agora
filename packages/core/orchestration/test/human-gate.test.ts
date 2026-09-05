import {
  appendMutation,
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

  it('resolves a blocking requirement objection with a Leader ruling and target withdrawal', () => {
    const objection = {
      id: 'obj-1',
      threadId: 'obj-1',
      fromRole: 'PM',
      claim: 'contradiction' as const,
      target: { kind: 'requirement' as const, id: 'req-1' },
      argument: 'The requirement contradicts the revised scope.',
      track: 'blocking' as const,
      ts: 2,
    };
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      mergeByIdMutation('requirements', 'req-1', {
        story: 'Persist tasks',
        acceptance: ['survives restart'],
        nonGoals: [],
      }),
      appendMutation('objections', objection),
      setMutation(
        'humanGate',
        materializeHumanGate(
          {
            triggerMsgId: objection.id,
            triggerTs: objection.ts,
            reason: `blocking_objection:${objection.id}`,
            options: ['accept_objection', 'reject_objection'],
            phase: 'clarifying',
          },
          ['ref-1'],
        ),
      ),
    ]);
    const plan = planHumanGateResolution(state, {
      actionId: 'resolve-obj-1',
      gateId: 'human-gate:obj-1',
      option: 'accept_objection',
      argument: 'The revised scope is controlling.',
      enabledRoles: [],
      ts: 3,
    });
    const resolved = applyMutations(state, plan.mutations);
    expect(resolved.decisionLedger.at(-1)).toMatchObject({
      id: 'objection-resolution:resolve-obj-1',
      authority: 'leader',
      objectionResolution: { objectionId: 'obj-1', outcome: 'accepted' },
    });
    expect(resolved.requirements[0]?.withdrawnByDecisionId).toBe(
      'objection-resolution:resolve-obj-1',
    );
    expect(resolved.humanGate).toBeUndefined();
  });

  it('resolves a review-bound completion gate with a canonical Leader decision', () => {
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      setMutation('phase', 'review'),
      appendMutation('messages', {
        msgId: 'review-dispatch',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        payload: { nextRole: 'REVIEWER', reviewCommentCursor: 0 },
        display: 'Review',
        ts: 1,
      }),
      appendMutation('reviewComments', {
        id: 'review-1',
        kind: 'verdict',
        verdict: 'approved',
      }),
      setMutation(
        'humanGate',
        materializeHumanGate(
          {
            triggerMsgId: 'review-1',
            triggerTs: 2,
            reason: 'completion_confirmation:review-1',
            options: ['approve_completion', 'request_changes'],
            phase: 'review',
          },
          ['safe-1'],
        ),
      ),
    ]);
    const plan = planHumanGateResolution(state, {
      actionId: 'approve-1',
      gateId: 'human-gate:review-1',
      option: 'approve_completion',
      enabledRoles: [],
      ts: 3,
    });
    const resolved = applyMutations(state, plan.mutations);

    expect(plan.completionResolution).toEqual({
      reviewId: 'review-1',
      option: 'approve_completion',
      resolutionDecisionId: 'task-completion-resolution:approve-1',
    });
    expect(resolved.decisionLedger.at(-1)).toMatchObject({
      id: 'task-completion-resolution:approve-1',
      topic: 'task-completion:task-1',
      authority: 'leader',
    });
    expect(resolved.humanGate).toBeUndefined();
  });

  it('requires a rationale when the Leader requests completion changes', () => {
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      setMutation('phase', 'review'),
      appendMutation('messages', {
        msgId: 'review-dispatch',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        payload: { nextRole: 'REVIEWER', reviewCommentCursor: 0 },
        display: 'Review',
        ts: 1,
      }),
      appendMutation('reviewComments', {
        id: 'review-1',
        kind: 'verdict',
        verdict: 'approved',
      }),
      setMutation('humanGate', {
        gateId: 'human-gate:review-1',
        reason: 'completion_confirmation:review-1',
        options: ['approve_completion', 'request_changes'],
        phase: 'review',
        openedTs: 2,
        safePointRefs: [],
      }),
    ]);
    expect(() =>
      planHumanGateResolution(state, {
        actionId: 'rework-1',
        gateId: 'human-gate:review-1',
        option: 'request_changes',
        enabledRoles: [],
        ts: 3,
      }),
    ).toThrow('requires a Leader rationale');
  });
});
