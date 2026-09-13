import {
  type AppState,
  buildCompletionResolution,
  createInitialAppState,
  type WaveValidationReceipt,
} from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { describe, expect, it } from 'vitest';
import { project, projectForAssignment } from '../src/project';

// Pure canonical control fixtures exercise the real projector without model mocks.
const RATIONALE = 'Fix ticketCost(Object.create(null)): throw RangeError without String(input).';
function resolved(parallel = false): AppState {
  const state = createInitialAppState('completion-feedback', 'Build a quote');
  state.phase = 'review';
  if (parallel) {
    const receipt: WaveValidationReceipt = {
      kind: 'wave_validation',
      version: 1,
      planId: 'plan',
      waveId: 'old-wave',
      attempt: 1,
      dispatchId: 'validation',
      workerId: 'worker:validation:0',
      integrationId: 'integration',
      inputCommit: 'a'.repeat(40),
      worktree: {
        path: '/data/validation',
        branch: 'validation',
        baseCommit: 'a'.repeat(40),
        headCommit: 'b'.repeat(40),
      },
      subtaskIds: ['A'],
      controlFingerprint: 'f'.repeat(64),
      results: { passed: true, total: 21, failed: 0, failures: [] },
      evidence: {
        path: 'validation/validation.json',
        sha256: 'e'.repeat(64),
        exitCode: 0,
        timedOut: false,
      },
    };
    state.parallelExecution = {
      version: 1,
      planId: 'plan',
      initialBase: { branch: 'base', commit: 'a'.repeat(40) },
      acceptedReceiptId: 'wave-validation:validation',
    };
    state.workers.push({
      workerId: receipt.workerId,
      role: 'TESTER',
      executor: 'harness',
      status: 'done',
      startedTs: 1,
      worktree: receipt.worktree,
    });
    state.messages.push(
      {
        msgId: 'validation',
        fromRole: 'COORDINATOR',
        channelId: 'main',
        type: 'announce',
        ts: 1,
        display: 'PRIVATE-DISPLAY',
        payload: { ...receipt, kind: 'wave_validation_dispatch' },
      },
      {
        msgId: 'wave-validation:validation',
        fromRole: 'COORDINATOR',
        channelId: 'main',
        type: 'announce',
        ts: 2,
        display: 'PRIVATE-DISPLAY',
        payload: { ...receipt },
      },
    );
  }
  const binding = parallel
    ? {
        planId: 'plan',
        validationReceiptId: 'wave-validation:validation',
        commit: 'b'.repeat(40),
        controlFingerprint: 'f'.repeat(64),
      }
    : undefined;
  state.messages.push({
    msgId: 'review-dispatch',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    ts: 3,
    display: 'PRIVATE-DISPLAY',
    payload: {
      nextRole: 'REVIEWER',
      reviewCommentCursor: 0,
      ...(binding ? { reviewBinding: binding } : {}),
    },
  });
  state.reviewComments.push({ id: 'review-1', kind: 'verdict', verdict: 'approved' });
  const built = buildCompletionResolution(state, {
    actionId: 'rework-1',
    reviewId: 'review-1',
    option: 'request_changes',
    rationale: RATIONALE,
    ts: 4,
  });
  state.decisionLedger.push(built.decision);
  state.messages.push({
    msgId: 'rework-1',
    fromRole: 'leader',
    channelId: 'main',
    type: 'chat',
    ts: 4,
    display: 'PRIVATE-DISPLAY',
    payload: {
      kind: 'leader_intent',
      action: { status: 'applied' },
      intent: {
        kind: 'resolve_human_gate',
        gateId: 'human-gate:review-1',
        option: 'request_changes',
        argument: RATIONALE,
      },
      resolution: {
        gateId: 'human-gate:review-1',
        option: 'request_changes',
        argument: RATIONALE,
        safePointRefs: [],
        resumeSessionId: 'human-gate-resume:rework-1',
        ...(binding ? { completionEvidence: binding } : {}),
      },
      completionResolution: built.action,
    },
  });
  state.messages.push({
    msgId: 'human-gate-resumed:rework-1',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    ts: 5,
    display: 'PRIVATE-DISPLAY',
    payload: {
      kind: 'human_gate_resumed',
      actionId: 'rework-1',
      gateId: 'human-gate:review-1',
      resumeSessionId: 'human-gate-resume:rework-1',
    },
  });
  state.phase = 'coding';
  return state;
}

describe('Leader completion feedback projection', () => {
  it('delivers verified feedback to every role independently of roster slices and chat display', () => {
    const state = resolved();
    for (const role of DEFAULT_ROSTER) {
      const view = project(state, role.role, [{ ...role, projection: [] }]);
      expect(view.slices.completionFeedback).toMatchObject({
        actionId: 'rework-1',
        reviewId: 'review-1',
        option: 'request_changes',
        rationale: RATIONALE,
        resumed: true,
      });
      expect(JSON.stringify(view)).not.toContain('PRIVATE-DISPLAY');
      (view.slices.completionFeedback as { rationale: string }).rationale = 'changed';
    }
    expect(state.decisionLedger[0]?.rationale).toBe(RATIONALE);
  });

  it('survives assignment reprojection, persistence and the next review dispatch', () => {
    const state = resolved(true);
    if (!state.parallelExecution) throw new Error('missing execution');
    state.parallelExecution.activeWave = {
      waveId: 'new-wave',
      attempt: 1,
      base: { branch: 'validation', commit: 'b'.repeat(40) },
      subtaskIds: ['A'],
      coderWorkerIds: ['worker:new-wave:0'],
    };
    state.subtasks.push({
      id: 'A',
      title: 'Implement ticket',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'in_progress',
    });
    state.workers.push({
      workerId: 'worker:new-wave:0',
      role: 'CODER',
      subtaskId: 'A',
      executor: 'harness',
      status: 'running',
      startedTs: 6,
    });
    const assignment = { workerId: 'worker:new-wave:0', role: 'CODER', subtaskId: 'A' };
    expect(
      projectForAssignment(JSON.parse(JSON.stringify(state)), assignment, DEFAULT_ROSTER).slices
        .completionFeedback,
    ).toMatchObject({ rationale: RATIONALE });
    state.phase = 'review';
    state.messages.push({
      msgId: 'next-review',
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: 7,
      display: 'PRIVATE-DISPLAY',
      payload: { nextRole: 'REVIEWER', reviewCommentCursor: 1 },
    });
    state.reviewComments.push({ id: 'review-2', kind: 'verdict', verdict: 'approved' });
    expect(project(state, 'REVIEWER', DEFAULT_ROSTER).slices.completionFeedback).toMatchObject({
      reviewId: 'review-1',
      rationale: RATIONALE,
    });
  });

  it('does not project unresumed or nonexistent feedback', () => {
    expect(
      project(createInitialAppState('empty', 'goal'), 'CODER', DEFAULT_ROSTER).slices
        .completionFeedback,
    ).toBeNull();
    const state = resolved();
    state.messages.pop();
    expect(project(state, 'CODER', DEFAULT_ROSTER).slices.completionFeedback).toBeNull();
  });

  it('rejects canonical decision, receipt and parallel evidence drift', () => {
    for (const damage of ['decision', 'receipt', 'evidence']) {
      const state = resolved(true);
      const message = state.messages.find((m) => m.msgId === 'rework-1');
      if (!message || !state.decisionLedger[0]) throw new Error('missing fixture');
      if (damage === 'decision') state.decisionLedger[0].rationale = 'forged';
      if (damage === 'receipt')
        (message.payload.resolution as Record<string, unknown>).argument = 'forged';
      if (damage === 'evidence')
        (
          (message.payload.resolution as Record<string, unknown>).completionEvidence as Record<
            string,
            unknown
          >
        ).commit = 'c'.repeat(40);
      expect(() => project(state, 'CODER', DEFAULT_ROSTER)).toThrow();
    }
  });
});
