import { describe, expect, it } from 'vitest';
import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  type Message,
  mergeByIdMutation,
} from '../src/index';
import {
  confirmedRequirementIntent,
  requirementBasis,
  requirementProposalView,
} from '../src/requirement-proposal';

function fixture(includeDraft = false) {
  let state = applyMutations(createInitialAppState('task', 'goal', 'project'), [
    mergeByIdMutation('requirements', 'ticket', {
      story: '1000 cents',
      acceptance: ['two cost 2000'],
      nonGoals: ['No payments'],
    }),
  ]);
  if (includeDraft) {
    state = applyMutations(state, [
      mergeByIdMutation('requirements', 'draft', {
        story: 'Criteria still being clarified',
        acceptance: [],
        nonGoals: [],
      }),
    ]);
  }
  const source: Message = {
    msgId: 'input',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    display: 'Change tickets to 900 cents',
    payload: {
      kind: 'leader_intent',
      intent: { kind: 'chat', text: 'Change tickets to 900 cents' },
      action: { status: 'none' },
    },
    ts: 1,
  };
  const proposal: Message = {
    msgId: 'requirement-proposal:input',
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'chat',
    display: 'Change ticket price',
    payload: {
      kind: 'leader_requirement_interpretation',
      sourceMsgId: 'input',
      basis: requirementBasis(state),
      result: {
        kind: 'proposal',
        summary: 'Change ticket price',
        changes: [
          {
            requirementId: 'ticket',
            requirement: {
              story: '900 cents',
              acceptance: ['two cost 1800'],
              nonGoals: ['No payments'],
            },
          },
        ],
      },
    },
    ts: 2,
  };
  state = applyMutations(state, [
    appendMutation('messages', source),
    appendMutation('messages', proposal),
  ]);
  return { state, proposal };
}

describe('persisted requirement proposals', () => {
  it('preserves a partial pre-existing requirement without applying new-upsert rules to the before snapshot', () => {
    const { state } = fixture(true);
    expect(requirementProposalView(state)?.status).toBe('pending');
    expect(confirmedRequirementIntent(state, 'requirement-proposal:input')).toMatchObject({
      kind: 'requirements_change',
      changes: [{ requirementId: 'ticket' }],
    });
    expect(
      state.requirements.find((requirement) => requirement.id === 'draft')?.acceptance,
    ).toEqual([]);
  });
  it('survives serialization without changing requirements before confirmation', () => {
    const { state } = fixture();
    const restored = JSON.parse(JSON.stringify(state));
    expect(restored.requirements[0].story).toBe('1000 cents');
    expect(requirementProposalView(restored)).toMatchObject({
      status: 'pending',
      changes: [{ before: { story: '1000 cents' }, after: { story: '900 cents' } }],
    });
    expect(confirmedRequirementIntent(restored, 'requirement-proposal:input').kind).toBe(
      'requirements_change',
    );
  });
  it('rejects stale requirements, completed tasks, active gates and a different proposal', () => {
    const { state } = fixture();
    const changed = applyMutations(state, [
      mergeByIdMutation('requirements', 'ticket', { story: '1200 cents' }),
    ]);
    expect(requirementProposalView(changed)?.status).toBe('stale');
    expect(() => confirmedRequirementIntent(changed, 'requirement-proposal:input')).toThrow(
      /no longer current/,
    );
    expect(() =>
      confirmedRequirementIntent({ ...state, phase: 'done' }, 'requirement-proposal:input'),
    ).toThrow();
    expect(() =>
      confirmedRequirementIntent(
        {
          ...state,
          humanGate: {
            gateId: 'g',
            reason: 'test',
            options: [],
            phase: 'review',
            openedTs: 2,
            safePointRefs: [],
          },
        },
        'requirement-proposal:input',
      ),
    ).toThrow();
    expect(() => confirmedRequirementIntent(state, 'another')).toThrow();
  });
  it('does not offer an already resolved proposal or trust a forged source', () => {
    const { state, proposal } = fixture();
    const done = applyMutations(state, [
      appendMutation('messages', {
        msgId: 'cancel',
        channelId: 'main',
        fromRole: 'leader',
        type: 'chat',
        display: 'Cancel',
        payload: {
          kind: 'leader_intent',
          intent: { kind: 'chat', text: 'Cancel' },
          action: { status: 'none' },
          requirementProposalId: proposal.msgId,
          requirementProposalAction: 'dismiss',
        },
        ts: 3,
      }),
    ]);
    expect(requirementProposalView(done)).toBeNull();
    const corrupted = structuredClone(state);
    const source = corrupted.messages[0];
    if (!source) throw new Error('Missing source');
    source.fromRole = 'CODER';
    expect(() => requirementProposalView(corrupted)).toThrow(/provenance/);
  });
});
