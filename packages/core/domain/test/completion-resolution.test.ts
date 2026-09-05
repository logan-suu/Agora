import { describe, expect, it } from 'vitest';
import {
  appendMutation,
  applyMutations,
  buildCompletionResolution,
  createInitialAppState,
  deriveCompletionResolution,
  setMutation,
} from '../src/index';

function approvedReviewState() {
  return applyMutations(createInitialAppState('task-1', 'goal', 'project-1'), [
    setMutation('phase', 'review'),
    appendMutation('messages', {
      msgId: 'review-dispatch',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      to: ['REVIEWER'],
      type: 'announce',
      payload: { nextRole: 'REVIEWER', reviewCommentCursor: 0 },
      display: 'Review the result',
      ts: 1,
    }),
    appendMutation('reviewComments', {
      id: 'review-verdict-1',
      kind: 'verdict',
      verdict: 'approved',
    }),
  ]);
}

describe('D16 completion resolution', () => {
  it('builds a deterministic highest-authority approval decision with a canonical default rationale', () => {
    const built = buildCompletionResolution(approvedReviewState(), {
      actionId: 'approve-1',
      reviewId: 'review-verdict-1',
      option: 'approve_completion',
      ts: 2,
    });

    expect(built).toEqual({
      action: {
        reviewId: 'review-verdict-1',
        option: 'approve_completion',
        resolutionDecisionId: 'task-completion-resolution:approve-1',
      },
      decision: {
        id: 'task-completion-resolution:approve-1',
        topic: 'task-completion:task-1',
        decision: 'approve_completion',
        rationale: 'Leader approved the current completion candidate.',
        authority: 'leader',
        by: 'leader',
        ts: 2,
      },
    });
  });

  it('requires a bounded rationale for request_changes and binds only the current approved review', () => {
    const state = approvedReviewState();
    expect(() =>
      buildCompletionResolution(state, {
        actionId: 'invalid-option-1',
        reviewId: 'review-verdict-1',
        option: 'invalid' as never,
        rationale: 'Do not persist an unknown completion action.',
        ts: 2,
      }),
    ).toThrow('option must be "approve_completion" or "request_changes"');
    expect(() =>
      buildCompletionResolution(state, {
        actionId: 'rework-1',
        reviewId: 'review-verdict-1',
        option: 'request_changes',
        rationale: '   ',
        ts: 2,
      }),
    ).toThrow('requires a Leader rationale');
    expect(() =>
      buildCompletionResolution(state, {
        actionId: 'rework-1',
        reviewId: 'old-review',
        option: 'request_changes',
        rationale: 'Cover the restart path.',
        ts: 2,
      }),
    ).toThrow('current REVIEWER verdict');
  });

  it('derives and cross-validates the canonical Message, Decision, receipt, and resumed marker', () => {
    const state = approvedReviewState();
    const built = buildCompletionResolution(state, {
      actionId: 'approve-1',
      reviewId: 'review-verdict-1',
      option: 'approve_completion',
      ts: 2,
    });
    const resolved = applyMutations(state, [
      appendMutation('decisionLedger', built.decision),
      appendMutation('messages', {
        msgId: 'approve-1',
        channelId: 'main',
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: {
            kind: 'resolve_human_gate',
            gateId: 'human-gate:review-verdict-1',
            option: 'approve_completion',
          },
          action: { status: 'applied' },
          resolution: {
            gateId: 'human-gate:review-verdict-1',
            option: 'approve_completion',
            safePointRefs: ['safe-1'],
            resumeSessionId: 'human-gate-resume:approve-1',
          },
          completionResolution: built.action,
        },
        display: '/resolve-gate human-gate:review-verdict-1 approve_completion',
        ts: 2,
      }),
      appendMutation('messages', {
        msgId: 'human-gate-resumed:approve-1',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        payload: {
          kind: 'human_gate_resumed',
          actionId: 'approve-1',
          gateId: 'human-gate:review-verdict-1',
          resumeSessionId: 'human-gate-resume:approve-1',
        },
        display: 'Human gate resumed.',
        ts: 3,
      }),
    ]);

    expect(deriveCompletionResolution(resolved, 'review-verdict-1')).toEqual({
      reviewId: 'review-verdict-1',
      option: 'approve_completion',
      actionId: 'approve-1',
      resolutionDecisionId: 'task-completion-resolution:approve-1',
      rationale: 'Leader approved the current completion candidate.',
      resumed: true,
    });
  });

  it('fails closed when a persisted completion decision drifts', () => {
    const state = approvedReviewState();
    const built = buildCompletionResolution(state, {
      actionId: 'approve-1',
      reviewId: 'review-verdict-1',
      option: 'approve_completion',
      ts: 2,
    });
    const damaged = applyMutations(state, [
      appendMutation('decisionLedger', { ...built.decision, topic: 'other-topic' }),
      appendMutation('messages', {
        msgId: 'approve-1',
        channelId: 'main',
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: {
            kind: 'resolve_human_gate',
            gateId: 'human-gate:review-verdict-1',
            option: 'approve_completion',
          },
          action: { status: 'applied' },
          resolution: {
            gateId: 'human-gate:review-verdict-1',
            option: 'approve_completion',
            safePointRefs: [],
            resumeSessionId: 'human-gate-resume:approve-1',
          },
          completionResolution: built.action,
        },
        display: 'approve',
        ts: 2,
      }),
    ]);
    expect(() => deriveCompletionResolution(damaged, 'review-verdict-1')).toThrow('drifted');
  });
});
