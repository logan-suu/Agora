import { describe, expect, it } from 'vitest';

import {
  applyMutations,
  assertPhase9LeaderActionReplay,
  createInitialAppState,
  deriveLeaderDirective,
  type Message,
  mergeByIdMutation,
  type Phase9LeaderIntent,
  planPhase9LeaderAction,
} from '../src/index';

function leaderMessage(actionId: string, intent: Phase9LeaderIntent, ts = 10): Message {
  return {
    msgId: actionId,
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    payload: { kind: 'leader_intent', intent, action: { status: 'applied' } },
    display: 'must not enter the projection',
    ts,
  };
}

describe('Phase 9 Leader action planning', () => {
  it('applies a confirmed set of related requirements atomically and checks every replay effect', () => {
    const state = createInitialAppState('task-a', 'goal', 'project-a');
    const intent = {
      kind: 'requirements_change' as const,
      changes: [
        {
          requirementId: 'ticket',
          requirement: { story: 'Charge 900 cents', acceptance: ['Two cost 1800'], nonGoals: [] },
        },
        {
          requirementId: 'quote',
          requirement: { story: 'Combine costs', acceptance: ['Total is 16800'], nonGoals: [] },
        },
      ],
    };
    const plan = planPhase9LeaderAction(state, { actionId: 'confirm', intent, ts: 10 });
    const changed = applyMutations(state, plan.mutations);
    expect(changed.requirements.map((r) => r.id)).toEqual(['ticket', 'quote']);
    expect(state.requirements).toEqual([]);
    expect(
      assertPhase9LeaderActionReplay(changed, leaderMessage('confirm', intent), intent).data,
    ).toEqual({ changes: intent.changes });
    const drifted = applyMutations(changed, [
      mergeByIdMutation('requirements', 'quote', { story: 'Drift' }),
    ]);
    expect(() =>
      assertPhase9LeaderActionReplay(drifted, leaderMessage('confirm', intent), intent),
    ).toThrow(/drifted/);
    const firstChange = intent.changes[0];
    if (!firstChange) throw new Error('Missing change');
    expect(() =>
      planPhase9LeaderAction(state, {
        actionId: 'bad',
        intent: { ...intent, changes: [firstChange, firstChange] },
        ts: 10,
      }),
    ).toThrow(/duplicate/);
  });

  it('fully upserts an active requirement and rejects revival of a withdrawn one', () => {
    const state = createInitialAppState('task-a', 'goal', 'project-a');
    const intent: Phase9LeaderIntent = {
      kind: 'requirement_change',
      requirementId: 'req-1',
      requirement: {
        story: 'Cache entries expire',
        acceptance: ['TTL is enforced'],
        nonGoals: ['Distributed invalidation'],
      },
    };

    const planned = planPhase9LeaderAction(state, { actionId: 'change-req', intent, ts: 10 });
    const changed = applyMutations(state, planned.mutations);
    expect(changed.requirements).toEqual([{ id: 'req-1', ...intent.requirement }]);

    const withdrawn = applyMutations(changed, [
      mergeByIdMutation('requirements', 'req-1', {
        withdrawnByDecisionId: 'objection-resolution:withdraw-1',
      }),
    ]);
    expect(() =>
      planPhase9LeaderAction(withdrawn, { actionId: 'revive-req', intent, ts: 11 }),
    ).toThrow(/withdrawn/);
  });

  it('requires explicit current-only supersedes and builds a deterministic Leader Decision', () => {
    const base = createInitialAppState('task-a', 'goal', 'project-a');
    const firstIntent: Phase9LeaderIntent = {
      kind: 'decision_change',
      topic: 'cache-policy',
      decision: 'Use LRU',
      rationale: 'Bounded memory',
    };
    const firstPlan = planPhase9LeaderAction(base, {
      actionId: 'decision-1',
      intent: firstIntent,
      ts: 10,
    });
    const first = applyMutations(base, firstPlan.mutations);
    expect(first.decisionLedger).toEqual([
      {
        id: 'leader-decision:decision-1',
        topic: 'cache-policy',
        decision: 'Use LRU',
        rationale: 'Bounded memory',
        authority: 'leader',
        by: 'leader',
        ts: 10,
      },
    ]);

    const missingSupersedes: Phase9LeaderIntent = {
      ...firstIntent,
      decision: 'Use LFU',
      rationale: 'Frequency matters',
    };
    expect(() =>
      planPhase9LeaderAction(first, {
        actionId: 'decision-2',
        intent: missingSupersedes,
        ts: 11,
      }),
    ).toThrow(/supersed/);

    const secondIntent: Phase9LeaderIntent = {
      ...missingSupersedes,
      supersedes: 'leader-decision:decision-1',
    };
    const second = applyMutations(
      first,
      planPhase9LeaderAction(first, {
        actionId: 'decision-2',
        intent: secondIntent,
        ts: 11,
      }).mutations,
    );
    expect(second.decisionLedger.at(-1)).toMatchObject({
      id: 'leader-decision:decision-2',
      supersedes: 'leader-decision:decision-1',
    });
  });

  it('updates priority only for an existing unfinished subtask', () => {
    const state = applyMutations(createInitialAppState('task-a', 'goal', 'project-a'), [
      mergeByIdMutation('subtasks', 'sub-1', {
        title: 'Implement cache',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'todo',
      }),
    ]);
    const intent: Phase9LeaderIntent = {
      kind: 'priority_change',
      subtaskId: 'sub-1',
      priority: 100,
    };
    const changed = applyMutations(
      state,
      planPhase9LeaderAction(state, { actionId: 'priority-1', intent, ts: 10 }).mutations,
    );
    expect(changed.subtasks[0]?.priority).toBe(100);

    const done = applyMutations(changed, [
      mergeByIdMutation('subtasks', 'sub-1', { status: 'done' }),
    ]);
    expect(() => planPhase9LeaderAction(done, { actionId: 'priority-2', intent, ts: 11 })).toThrow(
      /done/,
    );
  });

  it('derives a defensive structured directive and detects replay effect drift', () => {
    const state = applyMutations(createInitialAppState('task-a', 'goal', 'project-a'), [
      mergeByIdMutation('subtasks', 'sub-1', {
        title: 'Implement cache',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'todo',
      }),
    ]);
    const intent: Phase9LeaderIntent = {
      kind: 'priority_change',
      subtaskId: 'sub-1',
      priority: 80,
    };
    const message = leaderMessage('priority-1', intent);
    const committed = applyMutations(state, [
      ...planPhase9LeaderAction(state, { actionId: message.msgId, intent, ts: message.ts })
        .mutations,
      { field: 'messages', op: 'append', value: message },
    ]);

    expect(assertPhase9LeaderActionReplay(committed, message, intent)).toEqual({
      actionId: 'priority-1',
      kind: 'priority_change',
      data: { subtaskId: 'sub-1', priority: 80 },
      messageRef: { projectId: 'project-a', taskId: 'task-a', msgId: 'priority-1' },
    });
    const projected = deriveLeaderDirective(committed);
    expect(projected).toEqual(assertPhase9LeaderActionReplay(committed, message, intent));
    if (projected === null) throw new Error('expected directive');
    projected.data.priority = 1;
    expect(deriveLeaderDirective(committed)?.data).toEqual({ subtaskId: 'sub-1', priority: 80 });
    expect(JSON.stringify(projected)).not.toContain(message.display);

    const drifted = applyMutations(committed, [
      mergeByIdMutation('subtasks', 'sub-1', { priority: 20 }),
    ]);
    expect(() => assertPhase9LeaderActionReplay(drifted, message, intent)).toThrow(/effect/);
  });

  it('fails closed when an applied-looking directive message has a non-canonical envelope', () => {
    const intent: Phase9LeaderIntent = {
      kind: 'requirement_change',
      requirementId: 'req-1',
      requirement: { story: 'Current story', acceptance: ['works'], nonGoals: [] },
    };
    const state = createInitialAppState('task-a', 'goal', 'project-a');
    const forged = { ...leaderMessage('forged-1', intent), fromRole: 'CODER' };
    const committed = applyMutations(state, [
      ...planPhase9LeaderAction(state, { actionId: forged.msgId, intent, ts: forged.ts }).mutations,
      { field: 'messages', op: 'append', value: forged },
    ]);

    expect(() => deriveLeaderDirective(committed)).toThrow(/canonical envelope/);
  });
});
