import { describe, expect, it } from 'vitest';
import {
  activeRequirements,
  appendMutation,
  applyMutations,
  buildObjectionResolution,
  createInitialAppState,
  deriveObjectionResolutions,
  mergeByIdMutation,
  type Objection,
} from '../src/index';

const blockingDecisionObjection: Objection = {
  id: 'obj-1',
  threadId: 'obj-1',
  fromRole: 'PM',
  claim: 'contradiction',
  target: { kind: 'decision', id: 'dec-1' },
  argument: 'The selected runtime violates the deployment baseline.',
  track: 'blocking',
  ts: 2,
};

describe('D14 objection resolution facts', () => {
  it('builds a deterministic Leader decision that withdraws a challenged decision', () => {
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      appendMutation('decisionLedger', {
        id: 'dec-1',
        topic: 'runtime',
        decision: 'Use runtime A',
        rationale: 'Initial choice',
        authority: 'agent',
        by: 'ARCHITECT',
        ts: 1,
      }),
      appendMutation('objections', blockingDecisionObjection),
    ]);

    expect(
      buildObjectionResolution(state, {
        actionId: 'resolve-1',
        objectionId: 'obj-1',
        option: 'accept_objection',
        rationale: 'The deployment baseline is controlling.',
        ts: 3,
        mode: 'blocking_gate',
      }),
    ).toEqual({
      decision: {
        id: 'objection-resolution:resolve-1',
        topic: 'runtime',
        decision: 'accept_objection',
        rationale: 'The deployment baseline is controlling.',
        authority: 'leader',
        by: 'leader',
        supersedes: 'dec-1',
        objectionResolution: {
          objectionId: 'obj-1',
          outcome: 'accepted',
          target: { kind: 'decision', id: 'dec-1' },
        },
        ts: 3,
      },
    });
  });

  it('withdraws an accepted blocking requirement and filters it from active requirements', () => {
    const objection: Objection = {
      ...blockingDecisionObjection,
      id: 'obj-req',
      threadId: 'obj-req',
      target: { kind: 'requirement', id: 'req-1' },
    };
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      mergeByIdMutation('requirements', 'req-1', {
        story: 'Persist tasks',
        acceptance: ['survives restart'],
        nonGoals: [],
      }),
      appendMutation('objections', objection),
    ]);
    const built = buildObjectionResolution(state, {
      actionId: 'resolve-req',
      objectionId: objection.id,
      option: 'accept_objection',
      rationale: 'This requirement contradicts the revised product scope.',
      ts: 3,
      mode: 'blocking_gate',
    });
    expect(built.requirementPatch).toEqual({
      id: 'req-1',
      withdrawnByDecisionId: 'objection-resolution:resolve-req',
    });
    const resolved = applyMutations(state, [
      appendMutation('decisionLedger', built.decision),
      mergeByIdMutation('requirements', 'req-1', built.requirementPatch ?? {}),
      appendMutation('messages', {
        msgId: 'resolve-req',
        channelId: 'main',
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: {
            kind: 'resolve_human_gate',
            gateId: 'human-gate:obj-req',
            option: 'accept_objection',
            argument: built.decision.rationale,
          },
          action: { status: 'applied' },
          resolution: {
            gateId: 'human-gate:obj-req',
            option: 'accept_objection',
            argument: built.decision.rationale,
            safePointRefs: ['ref-1'],
            resumeSessionId: 'human-gate-resume:resolve-req',
          },
          objectionResolution: {
            objectionId: 'obj-req',
            option: 'accept_objection',
            resolutionDecisionId: built.decision.id,
          },
        },
        display: '/resolve-gate human-gate:obj-req accept_objection rationale',
        ts: 3,
      }),
    ]);
    expect(activeRequirements(resolved)).toEqual([]);
  });

  it('fails closed when a requirement withdrawal does not point to its canonical Leader ruling', () => {
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      mergeByIdMutation('requirements', 'req-1', {
        story: 'Persist tasks',
        acceptance: ['survives restart'],
        nonGoals: [],
        withdrawnByDecisionId: 'missing-ruling',
      }),
    ]);
    expect(() => activeRequirements(state)).toThrow('invalid requirement withdrawal');
  });

  it('fails closed when a requirement withdrawal has a ruling but no canonical Leader message', () => {
    const objection: Objection = {
      ...blockingDecisionObjection,
      id: 'obj-req',
      threadId: 'obj-req',
      target: { kind: 'requirement', id: 'req-1' },
    };
    const active = applyMutations(createInitialAppState('task-1', 'goal'), [
      mergeByIdMutation('requirements', 'req-1', {
        story: 'Persist tasks',
        acceptance: ['survives restart'],
        nonGoals: [],
      }),
      appendMutation('objections', objection),
    ]);
    const state = applyMutations(active, [
      mergeByIdMutation('requirements', 'req-1', {
        withdrawnByDecisionId: 'objection-resolution:resolve-req',
      }),
      appendMutation('decisionLedger', {
        id: 'objection-resolution:resolve-req',
        topic: 'requirement:req-1',
        decision: 'accept_objection',
        rationale: 'The requirement conflicts with the revised scope.',
        authority: 'leader',
        by: 'leader',
        objectionResolution: {
          objectionId: objection.id,
          outcome: 'accepted',
          target: objection.target,
        },
        ts: 3,
      }),
    ]);
    expect(() => activeRequirements(state)).toThrow('invalid requirement withdrawal');
  });

  it('derives one canonical resolution and fails closed when its decision fact is missing', () => {
    const state = applyMutations(createInitialAppState('task-1', 'goal'), [
      appendMutation('decisionLedger', {
        id: 'dec-1',
        topic: 'runtime',
        decision: 'Use runtime A',
        rationale: 'Initial choice',
        authority: 'agent',
        by: 'ARCHITECT',
        ts: 1,
      }),
      appendMutation('objections', blockingDecisionObjection),
    ]);
    const built = buildObjectionResolution(state, {
      actionId: 'resolve-1',
      objectionId: 'obj-1',
      option: 'reject_objection',
      rationale: 'The existing decision remains valid.',
      ts: 3,
      mode: 'blocking_gate',
    });
    const message = {
      msgId: 'resolve-1',
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat' as const,
      payload: {
        kind: 'leader_intent',
        intent: {
          kind: 'resolve_human_gate',
          gateId: 'human-gate:obj-1',
          option: 'reject_objection',
          argument: 'The existing decision remains valid.',
        },
        action: { status: 'applied' },
        resolution: {
          gateId: 'human-gate:obj-1',
          option: 'reject_objection',
          argument: 'The existing decision remains valid.',
          safePointRefs: ['ref-1'],
          resumeSessionId: 'human-gate-resume:resolve-1',
        },
        objectionResolution: {
          objectionId: 'obj-1',
          option: 'reject_objection',
          resolutionDecisionId: built.decision.id,
        },
      },
      display:
        '/resolve-gate human-gate:obj-1 reject_objection The existing decision remains valid.',
      ts: 3,
    };
    const resolved = applyMutations(state, [
      appendMutation('decisionLedger', built.decision),
      appendMutation('messages', message),
    ]);
    expect(deriveObjectionResolutions(resolved)).toMatchObject([
      { objectionId: 'obj-1', status: 'resolved', outcome: 'rejected', actionId: 'resolve-1' },
    ]);
    expect(() =>
      deriveObjectionResolutions({
        ...resolved,
        decisionLedger: resolved.decisionLedger.slice(0, 1),
      }),
    ).toThrow('missing resolution decision');
  });
});
