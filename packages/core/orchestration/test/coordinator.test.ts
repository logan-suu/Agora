import type { AppState, RoleSpec } from '@agora/core-domain';
import {
  appendMutation,
  applyMutations,
  buildCompletionResolution,
  createInitialAppState,
  mergeByIdMutation,
  PHASE0_ROSTER,
  setMutation,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import {
  COORDINATION_LEDGER_KIND,
  decide,
  latestCoordinationLedger,
  MAX_ITERATIONS,
} from '../src/index';

interface DeterministicClock {
  newId: () => string;
  now: () => number;
}

function expectedGate(phase: AppState['phase']): Record<string, unknown> {
  return { reason: 'iteration_limit', options: ['continue'], phase };
}

function clock(): DeterministicClock {
  let counter = 0;
  return { newId: () => `id-${++counter}`, now: () => 1000 };
}

function latestCoordinatorControlPayload(state: AppState): Record<string, unknown> | undefined {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (
      message?.fromRole === 'COORDINATOR' &&
      (message.type === 'announce' || message.type === 'feedback' || message.type === 'escalation')
    ) {
      return message.payload;
    }
  }
  return undefined;
}

function stateAtPhase(phase: AppState['phase'], overrides?: Partial<AppState>): AppState {
  return {
    ...createInitialAppState('t-1', '实现带 TTL 的 LRU 缓存'),
    phase,
    ...overrides,
  };
}

function requirement(id: string): {
  id: string;
  story: string;
  acceptance: string[];
  nonGoals: [];
} {
  return { id, story: `story-${id}`, acceptance: [`acc-${id}`], nonGoals: [] };
}

function requirementsReadyState(): AppState {
  return applyMutations(createInitialAppState('t-1', '实现带 TTL 的 LRU 缓存'), [
    mergeByIdMutation('requirements', 'req-1', requirement('req-1')),
  ]);
}

function designedState(): AppState {
  return applyMutations(requirementsReadyState(), [
    setMutation('phase', 'planning'),
    setMutation('nextRole', 'ARCHITECT'),
    setMutation('architecture', { modules: ['cache'] }),
  ]);
}

function codingState(): AppState {
  return applyMutations(designedState(), [
    mergeByIdMutation('subtasks', 't-1-sub-0', {
      title: '实现带 TTL 的 LRU 缓存',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'in_progress',
    }),
    setMutation('phase', 'coding'),
    setMutation('nextRole', 'CODER'),
  ]);
}

function withObjection(state: AppState, track: 'blocking' | 'advisory'): AppState {
  return applyMutations(state, [
    appendMutation('objections', {
      id: `obj-${track}`,
      threadId: `obj-${track}`,
      fromRole: 'PM',
      target: { kind: 'requirement', id: 'req-1' },
      claim: track === 'blocking' ? 'contradiction' : 'concern',
      argument: 'The proposed implementation conflicts with restart durability.',
      track,
      ts: 900,
    }),
  ]);
}

function testingState(passed: boolean, iterationCount = 0): AppState {
  return applyMutations(codingState(), [
    setMutation('phase', 'testing'),
    setMutation('nextRole', 'TESTER'),
    setMutation('iterationCount', iterationCount),
    setMutation('testResults', { passed, total: 3, failed: passed ? 0 : 3, failures: [] }),
  ]);
}

function reviewState(
  verdict: 'approved' | 'changes_requested',
  iterationCount = 0,
  verdictExtra: Record<string, unknown> = {},
): AppState {
  const tested = testingState(true, iterationCount);
  const dispatch = decide(tested, {
    newId: () => 'review-dispatch',
    now: () => 1000,
    roster: FULL_ROSTER,
  });
  return applyMutations(applyMutations(tested, dispatch.mutations), [
    appendMutation('reviewComments', { id: 'rc-note-1', kind: 'comment', summary: 'naming' }),
    appendMutation('reviewComments', {
      id: 'rc-verdict-1',
      kind: 'verdict',
      verdict,
      ...verdictExtra,
    }),
  ]);
}

function resolvedCompletionState(option: 'approve_completion' | 'request_changes'): AppState {
  const state = reviewState('approved');
  const actionId = option === 'approve_completion' ? 'leader-approve' : 'leader-rework';
  const rationale =
    option === 'approve_completion' ? undefined : 'Cover the restart recovery path.';
  const built = buildCompletionResolution(state, {
    actionId,
    reviewId: 'rc-verdict-1',
    option,
    ...(rationale === undefined ? {} : { rationale }),
    ts: 1100,
  });
  return applyMutations(state, [
    appendMutation('decisionLedger', built.decision),
    appendMutation('messages', {
      msgId: actionId,
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat',
      payload: {
        kind: 'leader_intent',
        intent: {
          kind: 'resolve_human_gate',
          gateId: 'human-gate:rc-verdict-1',
          option,
          ...(rationale === undefined ? {} : { argument: rationale }),
        },
        action: { status: 'applied' },
        resolution: {
          gateId: 'human-gate:rc-verdict-1',
          option,
          ...(rationale === undefined ? {} : { argument: rationale }),
          safePointRefs: ['safe-1'],
          resumeSessionId: `human-gate-resume:${actionId}`,
        },
        completionResolution: built.action,
      },
      display: option,
      ts: 1100,
    }),
    appendMutation('messages', {
      msgId: `human-gate-resumed:${actionId}`,
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      payload: {
        kind: 'human_gate_resumed',
        actionId,
        gateId: 'human-gate:rc-verdict-1',
        resumeSessionId: `human-gate-resume:${actionId}`,
      },
      display: 'resumed',
      ts: 1200,
    }),
  ]);
}

const FULL_ROSTER: RoleSpec[] = (
  ['COORDINATOR', 'PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER'] as const
).map((role) => ({
  role,
  executor: 'harness' as const,
  systemPrompt: '',
  tools: [],
  projection: [],
  routeWhen: 'always',
}));

describe('decide · D14 objection routing', () => {
  it('routes a persisted blocking objection to a stable D4 request before normal phase work', () => {
    const state = withObjection(codingState(), 'blocking');
    const first = decide(state, { newId: () => 'ledger-1', now: () => 1000, roster: FULL_ROSTER });
    const second = decide(state, { newId: () => 'ledger-2', now: () => 2000, roster: FULL_ROSTER });

    expect(first.route).toEqual({
      kind: 'human_gate',
      request: {
        triggerMsgId: 'obj-blocking',
        triggerTs: 900,
        reason: 'blocking_objection:obj-blocking',
        options: ['accept_objection', 'reject_objection'],
        phase: 'coding',
      },
    });
    expect(second.route).toEqual(first.route);
    expect(
      latestCoordinationLedger(applyMutations(state, first.mutations))?.progress
        .instructionOrQuestion.answer,
    ).toBe('Await Leader resolution for blocking_objection:obj-blocking');
  });

  it('keeps advisory objections visible without interrupting normal routing', () => {
    const decision = decide(withObjection(codingState(), 'advisory'), {
      newId: () => 'ledger-advisory',
      now: () => 1000,
      roster: FULL_ROSTER,
    });
    expect(decision.route.kind).not.toBe('human_gate');
  });
});

function nextFailedTestRound(state: AppState): AppState {
  return applyMutations(state, [
    setMutation('phase', 'testing'),
    setMutation('nextRole', 'TESTER'),
    setMutation('testResults', { passed: false, total: 3, failed: 3, failures: [] }),
  ]);
}

describe('coordinator.decide · conditional routing (task 2.2, spec §5.3)', () => {
  it('consumes the latest applied Leader assignment once before normal phase routing', () => {
    const state = applyMutations(requirementsReadyState(), [
      appendMutation('messages', {
        msgId: 'leader-assign-reviewer',
        channelId: 'main',
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: {
            kind: 'assign',
            targetRole: 'REVIEWER',
            instruction: 'inspect the cache contract',
          },
          action: { status: 'applied' },
        },
        display: '@REVIEWER inspect the cache contract',
        ts: 900,
      }),
      setMutation('nextRole', 'REVIEWER'),
    ]);

    const override = decide(state, { ...clock(), roster: FULL_ROSTER });
    expect(override.route).toEqual({
      kind: 'worker',
      batch: [{ role: 'REVIEWER' }],
      parallel: false,
    });
    expect(override.mutations).toContainEqual(
      expect.objectContaining({
        op: 'append',
        field: 'messages',
        value: expect.objectContaining({
          fromRole: 'COORDINATOR',
          payload: expect.objectContaining({
            reason: 'leader_assignment',
            sourceMsgId: 'leader-assign-reviewer',
            nextRole: 'REVIEWER',
          }),
        }),
      }),
    );
    expect(
      latestCoordinationLedger(applyMutations(state, override.mutations))?.progress
        .instructionOrQuestion.answer,
    ).toBe('inspect the cache contract');

    const afterOverride = applyMutations(state, override.mutations);
    const normal = decide(afterOverride, { ...clock(), roster: FULL_ROSTER });
    expect(normal.route).toEqual({
      kind: 'worker',
      batch: [{ role: 'ARCHITECT' }],
      parallel: false,
    });
  });

  it('escalates when an applied Leader assignment becomes unavailable before consumption', () => {
    const state = applyMutations(requirementsReadyState(), [
      appendMutation('messages', {
        msgId: 'leader-assign-reviewer',
        channelId: 'main',
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: {
            kind: 'assign',
            targetRole: 'REVIEWER',
            instruction: 'inspect the cache contract',
          },
          action: { status: 'applied' },
        },
        display: '@REVIEWER inspect the cache contract',
        ts: 900,
      }),
      setMutation('nextRole', 'REVIEWER'),
    ]);
    const enabledRoster = FULL_ROSTER.filter((spec) => spec.role !== 'REVIEWER');

    const decision = decide(state, { ...clock(), roster: enabledRoster });
    const next = applyMutations(state, decision.mutations);

    expect(decision.route.kind).toBe('human_gate');
    if (decision.route.kind !== 'human_gate') throw new Error('unreachable guard for narrowing');
    expect(decision.route.request).toMatchObject({
      reason: 'required_role_unavailable:REVIEWER',
      options: ['retry'],
    });
    expect(next.humanGate).toBeUndefined();
    expect(next.messages.some((message) => message.payload.role === 'REVIEWER')).toBe(true);
  });

  it('treats older unapplied Leader assignments as superseded by the latest one', () => {
    const assignment = (msgId: string, targetRole: string, ts: number) =>
      appendMutation('messages', {
        msgId,
        channelId: 'main',
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: { kind: 'assign', targetRole, instruction: `activate ${targetRole}` },
          action: { status: 'applied' },
        },
        display: `@${targetRole} activate ${targetRole}`,
        ts,
      });
    const state = applyMutations(requirementsReadyState(), [
      assignment('older', 'PM', 100),
      assignment('latest', 'TESTER', 200),
      setMutation('nextRole', 'TESTER'),
    ]);

    const latest = decide(state, { ...clock(), roster: FULL_ROSTER });
    expect(latest.route).toEqual({
      kind: 'worker',
      batch: [{ role: 'TESTER' }],
      parallel: false,
    });
    const afterLatest = applyMutations(state, latest.mutations);
    const normal = decide(afterLatest, { ...clock(), roster: FULL_ROSTER });
    expect(normal.route).toEqual({
      kind: 'worker',
      batch: [{ role: 'ARCHITECT' }],
      parallel: false,
    });
  });

  it('routes PM from clarifying while the goal is ambiguous (no requirements yet)', () => {
    const decision = decide(createInitialAppState('t-1', '实现带 TTL 的 LRU 缓存'), clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('PM');

    const next = applyMutations(createInitialAppState('t-1', 'g'), decision.mutations);
    expect(next.phase).toBe('clarifying');
    expect(next.nextRole).toBe('PM');
    expect(next.subtasks).toHaveLength(0);
    expect(next.messages.filter((m) => m.type === 'announce')).toHaveLength(1);
  });

  it('routes ARCHITECT once requirements are distilled (需求已定) and moves to planning', () => {
    const state = requirementsReadyState();
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('ARCHITECT');

    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('planning');
    expect(next.nextRole).toBe('ARCHITECT');
    expect(next.messages.filter((m) => m.type === 'announce')).toHaveLength(1);
  });

  it('routes CODER once the design is complete (设计完成) and creates the subtask', () => {
    const state = designedState();
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('coding');
    expect(next.nextRole).toBe('CODER');
    expect(next.subtasks).toHaveLength(1);
    expect(next.subtasks[0]?.ownerRole).toBe('CODER');
    expect(next.subtasks[0]?.status).toBe('in_progress');
  });

  it('throws when planning finishes without an architecture slice (producer contract)', () => {
    const state = applyMutations(requirementsReadyState(), [setMutation('phase', 'planning')]);
    expect(() => decide(state)).toThrow(/architecture/);
  });

  it('routes REVIEWER once tests pass (测试通过) and moves to review', () => {
    const state = testingState(true);
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('REVIEWER');

    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('review');
    expect(next.nextRole).toBe('REVIEWER');
  });

  it('opens a review-bound completion confirmation gate when REVIEWER approves', () => {
    const decision = decide(reviewState('approved'), clock());
    expect(decision.route).toEqual({
      kind: 'human_gate',
      request: {
        triggerMsgId: 'rc-verdict-1',
        triggerTs: 1000,
        reason: 'completion_confirmation:rc-verdict-1',
        options: ['approve_completion', 'request_changes'],
        phase: 'review',
      },
    });
    expect(decision.mutations).toHaveLength(1);
    expect(decision.mutations[0]).toMatchObject({
      field: 'messages',
      op: 'append',
      value: { payload: { kind: COORDINATION_LEDGER_KIND, completionCandidate: true } },
    });
  });

  it('sends a changes_requested verdict back to CODER with the review feedback (评审回环)', () => {
    const state = reviewState('changes_requested', 0);
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');

    const next = applyMutations(state, decision.mutations);
    expect(next.iterationCount).toBe(1);
    expect(next.phase).toBe('coding');
    expect(next.nextRole).toBe('CODER');
    const feedback = next.messages.filter((m) => m.type === 'feedback');
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.payload.reason).toBe('review_changes_requested');
  });

  it('finalizes only after a canonical Leader approval and resumed marker', () => {
    const state = resolvedCompletionState('approve_completion');
    const decision = decide(state, clock());
    const next = applyMutations(state, decision.mutations);

    expect(decision.route.kind).toBe('finalize');
    expect(latestCoordinationLedger(next)?.progress.isRequestSatisfied).toEqual({
      reason: 'leader_completion_approved',
      answer: true,
      authority: 'leader',
    });
  });

  it('reopens all CODER work after a canonical Leader request_changes resolution', () => {
    const state = resolvedCompletionState('request_changes');
    const decision = decide(state, clock());
    const next = applyMutations(state, decision.mutations);

    expect(decision.route).toMatchObject({
      kind: 'worker',
      batch: [{ role: 'CODER', subtaskId: 't-1-sub-0' }],
    });
    expect(next.phase).toBe('coding');
    expect(next.nextRole).toBe('CODER');
    expect(next.subtasks[0]?.status).toBe('in_progress');
    expect(latestCoordinationLedger(next)?.progress.isRequestSatisfied.answer).toBe(false);
  });

  it('escalates to human_gate when the review loop reaches the iteration cap (评审回环超限升级)', () => {
    const capped = reviewState('changes_requested', MAX_ITERATIONS);
    const decision = decide(capped);

    expect(decision.route.kind).toBe('human_gate');
    if (decision.route.kind !== 'human_gate') throw new Error('unreachable guard for narrowing');
    const next = applyMutations(capped, decision.mutations);
    expect(decision.route.request).toMatchObject(expectedGate('review'));
    expect(next.humanGate).toBeUndefined();
    expect(next.iterationCount).toBe(MAX_ITERATIONS);
    expect(next.phase).toBe('review');
    const escalations = next.messages.filter((m) => m.type === 'escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.fromRole).toBe('COORDINATOR');
    expect(escalations[0]?.payload).toMatchObject({
      reason: 'iteration_limit',
      iterationCount: MAX_ITERATIONS,
      limit: MAX_ITERATIONS,
    });
  });

  it('throws when review finishes without a verdict entry (producer contract)', () => {
    const tested = testingState(true);
    const state = applyMutations(
      tested,
      decide(tested, { ...clock(), roster: FULL_ROSTER }).mutations,
    );
    expect(() => decide(state)).toThrow(/current review turn.*verdict/);
  });

  it('throws on an unknown verdict value instead of guessing a route', () => {
    const tested = testingState(true);
    const state = applyMutations(
      applyMutations(tested, decide(tested, { ...clock(), roster: FULL_ROSTER }).mutations),
      [appendMutation('reviewComments', { id: 'rc-1', kind: 'verdict', verdict: 'kinda-fine' })],
    );
    expect(() => decide(state)).toThrow(/verdict/);
  });

  it('does not reuse a verdict from before the current REVIEWER dispatch', () => {
    const tested = applyMutations(testingState(true), [
      appendMutation('reviewComments', {
        id: 'rc-old-approved',
        kind: 'verdict',
        verdict: 'approved',
      }),
    ]);
    const review = applyMutations(
      tested,
      decide(tested, { ...clock(), roster: FULL_ROSTER }).mutations,
    );

    expect(() => decide(review, { ...clock(), roster: FULL_ROSTER })).toThrow(
      /current review turn.*verdict/,
    );
  });

  it('does not reuse a deduplicated verdict id from an earlier REVIEWER turn', () => {
    const tested = applyMutations(testingState(true), [
      appendMutation('reviewComments', {
        id: 'rc-stable',
        kind: 'verdict',
        verdict: 'changes_requested',
      }),
    ]);
    const review = applyMutations(
      tested,
      decide(tested, { ...clock(), roster: FULL_ROSTER }).mutations,
    );
    const duplicate = applyMutations(review, [
      appendMutation('reviewComments', {
        id: 'rc-stable',
        kind: 'verdict',
        verdict: 'approved',
      }),
    ]);

    expect(() => decide(duplicate, { ...clock(), roster: FULL_ROSTER })).toThrow(
      /current review turn.*verdict/,
    );
  });

  it('advances to TESTING after the CODER worker finishes a coding round', () => {
    const state = codingState();
    const decision = decide(state);

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('TESTER');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('testing');
    expect(next.nextRole).toBe('TESTER');
  });

  it('sends failing results back to CODER and increments iterationCount to 1 (测试失败回环)', () => {
    const before = testingState(false, 0);
    const decision = decide(before, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');

    const next = applyMutations(before, decision.mutations);
    expect(next.iterationCount).toBe(1);
    expect(next.phase).toBe('coding');
    expect(next.nextRole).toBe('CODER');
    expect(next.messages.filter((m) => m.type === 'feedback')).toHaveLength(1);
  });

  it('routes failing tests back to CODER at MAX-1 and escalates at the cap (测试回环边界)', () => {
    const belowCap = testingState(false, MAX_ITERATIONS - 1);
    const loopDecision = decide(belowCap, clock());
    expect(loopDecision.route.kind).toBe('worker');
    if (loopDecision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(loopDecision.route.batch[0].role).toBe('CODER');

    const capped = testingState(false, MAX_ITERATIONS);
    const decision = decide(capped);
    expect(decision.route.kind).toBe('human_gate');
    if (decision.route.kind !== 'human_gate') throw new Error('unreachable guard for narrowing');
    const next = applyMutations(capped, decision.mutations);
    expect(decision.route.request).toMatchObject(expectedGate('testing'));
    expect(next.humanGate).toBeUndefined();
    expect(next.iterationCount).toBe(MAX_ITERATIONS);
    expect(next.phase).toBe('testing');
    const escalations = next.messages.filter((m) => m.type === 'escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.payload).toMatchObject({
      reason: 'iteration_limit',
      iterationCount: MAX_ITERATIONS,
      limit: MAX_ITERATIONS,
    });
    expect(MAX_ITERATIONS).toBe(8);
  });

  it('finalizes from done and keeps the integrating phase unroutable until Phase 9', () => {
    expect(decide(stateAtPhase('done')).route.kind).toBe('finalize');
    expect(() => decide(stateAtPhase('integrating'))).toThrow(/not routable/);
  });

  it('never returns integrate below the iteration cap and only gates approved completion candidates', () => {
    const decisions = [
      decide(createInitialAppState('t-1', 'g'), clock()),
      decide(requirementsReadyState(), clock()),
      decide(designedState(), clock()),
      decide(codingState()),
      decide(testingState(true)),
      decide(testingState(false, 2), clock()),
      decide(reviewState('approved')),
      decide(reviewState('changes_requested', 2), clock()),
    ];

    for (const decision of decisions) {
      expect(decision.route.kind).not.toBe('integrate');
      if (decision.route.kind === 'human_gate') {
        expect(decision.route.request.reason).toBe('completion_confirmation:rc-verdict-1');
      }
      if (decision.route.kind === 'worker') {
        expect(decision.route.parallel).toBe(false);
        expect(decision.route.batch).toHaveLength(1);
      }
    }
  });
});

describe('coordinator.decide · structured coordination artifacts (task 4.4 + DEF-012)', () => {
  it('appends one strict Ledger event for the chosen route without fabricating an initial handoff', () => {
    const state = createInitialAppState('t-1', '实现带 TTL 的 LRU 缓存');
    const decision = decide(state, { ...clock(), roster: FULL_ROSTER });
    const next = applyMutations(state, decision.mutations);

    const ledgers = next.messages.filter(
      (message) => message.payload.kind === COORDINATION_LEDGER_KIND,
    );
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]?.type).toBe('chat');
    expect(latestCoordinationLedger(next)).toMatchObject({
      kind: COORDINATION_LEDGER_KIND,
      revision: 1,
      progress: {
        nextSpeaker: { reason: 'coordinator_route', answer: 'PM' },
      },
    });
    expect(next.handoffPackets).toEqual([]);
  });

  it('generates a validated handoff for every real worker role switch with decision/file refs', () => {
    const failure = {
      test: 'ttl expires',
      message: 'expected undefined',
      file: 'src/cache.test.ts',
      line: 27,
    };
    const state = applyMutations(requirementsReadyState(), [
      setMutation('nextRole', 'PM'),
      appendMutation('decisionLedger', {
        id: 'leader-1',
        topic: 'cache-policy',
        decision: 'Use monotonic TTL',
        rationale: 'Avoid wall-clock jumps',
        authority: 'leader',
        by: 'leader',
        ts: 1,
      }),
      setMutation('testResults', {
        passed: false,
        total: 1,
        failed: 1,
        failures: [failure],
      }),
    ]);
    const decision = decide(state, { ...clock(), roster: FULL_ROSTER });
    const next = applyMutations(state, decision.mutations);

    expect(next.nextRole).toBe('ARCHITECT');
    expect(next.handoffPackets).toEqual([
      {
        fromRole: 'PM',
        toRole: 'ARCHITECT',
        done: expect.stringContaining('PM'),
        keyDecisions: ['leader-1'],
        openIssues: ['ttl expires: expected undefined'],
        fileRefs: ['src/cache.test.ts:27'],
        ts: 1000,
      },
    ]);
  });

  it('does not emit a handoff when the coordinator re-dispatches the same role', () => {
    const state = applyMutations(createInitialAppState('t-1', 'g'), [
      setMutation('nextRole', 'PM'),
    ]);
    const next = applyMutations(
      state,
      decide(state, { ...clock(), roster: FULL_ROSTER }).mutations,
    );

    expect(next.nextRole).toBe('PM');
    expect(next.handoffPackets).toEqual([]);
  });

  it('records the completion gate as a candidate but never self-approves the request', () => {
    const state = reviewState('approved');
    const decision = decide(state, { ...clock(), roster: FULL_ROSTER });
    const next = applyMutations(state, decision.mutations);
    const ledger = latestCoordinationLedger(next);

    expect(decision.route.kind).toBe('human_gate');
    expect(ledger?.completionCandidate).toBe(true);
    expect(ledger?.progress.isRequestSatisfied).toEqual({
      reason: 'awaiting_leader_confirmation',
      answer: false,
      authority: 'leader',
    });
    expect(ledger?.progress.nextSpeaker.answer).toBe('LEADER');
  });

  it('records human_gate with LEADER as the next speaker', () => {
    const state = testingState(false, MAX_ITERATIONS);
    const decision = decide(state, { ...clock(), roster: FULL_ROSTER });
    const next = applyMutations(state, decision.mutations);

    expect(decision.route.kind).toBe('human_gate');
    expect(latestCoordinationLedger(next)?.progress.nextSpeaker.answer).toBe('LEADER');
  });
});

describe('coordinator.decide · roster-gated dispatch (task 2.2 hot-plug semantics)', () => {
  it('keeps the Phase 0 fixed CODER dispatch when the roster has no PM (PHASE0_ROSTER)', () => {
    const decision = decide(createInitialAppState('t-1', '实现带 TTL 的 LRU 缓存'), {
      ...clock(),
      roster: PHASE0_ROSTER,
    });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(createInitialAppState('t-1', 'g'), decision.mutations);
    expect(next.phase).toBe('coding');
    expect(next.nextRole).toBe('CODER');
    expect(next.subtasks[0]?.id).toBe('t-1-sub-0');
  });

  it('gates for the Leader when the next required role is not enabled', () => {
    const pmOnlyRoster: RoleSpec[] = [
      {
        role: 'PM',
        executor: 'harness',
        systemPrompt: '',
        tools: [],
        projection: [],
        routeWhen: 'goalAmbiguous',
      },
    ];
    const decision = decide(requirementsReadyState(), {
      ...clock(),
      roster: pmOnlyRoster,
    });
    expect(decision.route.kind).toBe('human_gate');
    if (decision.route.kind !== 'human_gate') throw new Error('unreachable guard for narrowing');
    const next = applyMutations(requirementsReadyState(), decision.mutations);
    expect(decision.route.request).toMatchObject({
      reason: 'required_role_unavailable:CODER',
      options: ['retry'],
    });
    expect(next.humanGate).toBeUndefined();
    expect(next.messages.some((message) => message.payload.role === 'CODER')).toBe(true);
  });

  it('increments iterationCount on each PM dispatch so a silent PM loop stays bounded', () => {
    const state = applyMutations(createInitialAppState('t-1', '实现带 TTL 的 LRU 缓存'), [
      setMutation('iterationCount', 3),
    ]);
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('PM');

    const next = applyMutations(state, decision.mutations);
    expect(next.iterationCount).toBe(4);
    expect(next.phase).toBe('clarifying');
  });

  it('escalates to human_gate when the PM clarifying loop reaches the cap (PM 回环超限升级)', () => {
    const capped = applyMutations(createInitialAppState('t-1', 'g'), [
      setMutation('iterationCount', MAX_ITERATIONS),
    ]);
    const decision = decide(capped, clock());

    expect(decision.route.kind).toBe('human_gate');
    if (decision.route.kind !== 'human_gate') throw new Error('unreachable guard for narrowing');
    const next = applyMutations(capped, decision.mutations);
    expect(decision.route.request).toMatchObject(expectedGate('clarifying'));
    expect(next.humanGate).toBeUndefined();
    expect(next.iterationCount).toBe(MAX_ITERATIONS);
    expect(next.phase).toBe('clarifying');
    expect(next.messages.filter((m) => m.type === 'escalation')).toHaveLength(1);
  });

  it('finalizes on passing tests when the roster has no REVIEWER (Phase 0 slice)', () => {
    const state = testingState(true);
    const decision = decide(state, { ...clock(), roster: PHASE0_ROSTER });
    expect(decision.route.kind).toBe('finalize');
    // task 4.2: passing tests now close the subtask lifecycle (done) even on
    // the finalize leg — intended behavior change, not assertion weakening.
    const next = applyMutations(state, decision.mutations);
    expect(next.subtasks[0]?.status).toBe('done');
  });
});

describe('coordinator.decide · feedback escalation (task 4.3, spec §3)', () => {
  function afterFirstTestFailure(): AppState {
    const first = testingState(false, 0);
    return applyMutations(
      first,
      decide(first, {
        newId: () => 'first-failure-feedback',
        now: () => 900,
        roster: FULL_ROSTER,
      }).mutations,
    );
  }

  it('keeps the first consecutive test failure in the CODER repair loop', () => {
    const state = testingState(false, 0);
    const decision = decide(state, { ...clock(), roster: FULL_ROSTER });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
    const next = applyMutations(state, decision.mutations);
    expect(latestCoordinatorControlPayload(next)).toMatchObject({
      reason: 'tests_failed',
      failureStreak: 1,
    });
  });

  it('routes REVIEWER on the second consecutive test failure when rostered', () => {
    const state = nextFailedTestRound(afterFirstTestFailure());
    const decision = decide(state, { ...clock(), roster: FULL_ROSTER });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('REVIEWER');
    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('review');
    expect(next.nextRole).toBe('REVIEWER');
    expect(next.iterationCount).toBe(2);
    expect(latestCoordinatorControlPayload(next)).toMatchObject({
      reason: 'repeated_test_failures',
      failureStreak: 2,
    });
  });

  it('degrades visibly to CODER when the repeated-failure roster has no REVIEWER', () => {
    const state = nextFailedTestRound(afterFirstTestFailure());
    const decision = decide(state, { ...clock(), roster: PHASE0_ROSTER });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
    const next = applyMutations(state, decision.mutations);
    expect(latestCoordinatorControlPayload(next)).toMatchObject({
      reason: 'tests_failed',
      failureStreak: 2,
      degraded: true,
      degradedReason: 'reviewer_not_rostered',
    });
  });

  it('keeps iteration-limit humanGate above repeated-failure escalation', () => {
    const state = applyMutations(nextFailedTestRound(afterFirstTestFailure()), [
      setMutation('iterationCount', MAX_ITERATIONS),
    ]);
    expect(decide(state, { ...clock(), roster: FULL_ROSTER }).route.kind).toBe('human_gate');
  });

  it('defaults a missing issueScope to implementation and returns review changes to CODER', () => {
    const decision = decide(reviewState('changes_requested'), {
      ...clock(),
      roster: FULL_ROSTER,
    });
    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
  });

  it.each([
    { from: 0 as const, to: 1 as const },
    { from: 1 as const, to: 2 as const },
    { from: 2 as const, to: 2 as const },
  ])('upgrades architecture scope monotonically from Tier $from to $to', ({ from, to }) => {
    const base = applyMutations(
      reviewState('changes_requested', 0, {
        id: `rc-architecture-${from}`,
        issueScope: 'architecture',
        summary: 'boundary design is wrong',
      }),
      [setMutation('complexity', { tier: from, signals: { rule: 'test-fixture', keep: true } })],
    );
    const decision = decide(base, { ...clock(), roster: FULL_ROSTER });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('ARCHITECT');
    const next = applyMutations(base, decision.mutations);
    expect(next.phase).toBe('planning');
    expect(next.complexity).toEqual({
      tier: to,
      signals: {
        rule: 'test-fixture',
        keep: true,
        escalation: {
          reason: 'reviewer_architecture_issue',
          previousTier: from,
          reviewCommentId: `rc-architecture-${from}`,
        },
      },
    });
  });

  it('degrades visibly to CODER when architecture escalation has no ARCHITECT', () => {
    const state = reviewState('changes_requested', 0, {
      id: 'rc-architecture',
      issueScope: 'architecture',
    });
    const decision = decide(state, { ...clock(), roster: PHASE0_ROSTER });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
    const next = applyMutations(state, decision.mutations);
    expect(latestCoordinatorControlPayload(next)).toMatchObject({
      degraded: true,
      degradedReason: 'architect_not_rostered',
    });
  });

  it('rejects approved verdicts during a repeated-test-failure root-cause review', () => {
    const secondFailure = nextFailedTestRound(afterFirstTestFailure());
    const review = applyMutations(
      secondFailure,
      decide(secondFailure, { ...clock(), roster: FULL_ROSTER }).mutations,
    );
    const withVerdict = applyMutations(review, [
      appendMutation('reviewComments', {
        id: 'rc-invalid-approved',
        kind: 'verdict',
        verdict: 'approved',
      }),
    ]);

    expect(() => decide(withVerdict, { ...clock(), roster: FULL_ROSTER })).toThrow(
      /root-cause review.*changes_requested/,
    );
  });
});

describe('coordinator.decide · tier-aware topology routing (task 4.2, spec §3)', () => {
  function tiered(tier: 0 | 1 | 2, state: AppState): AppState {
    return applyMutations(state, [
      setMutation('complexity', { tier, signals: { rule: 'test-fixture' } }),
    ]);
  }

  function designedStateWithModules(modules: string[]): AppState {
    return applyMutations(requirementsReadyState(), [
      setMutation('phase', 'planning'),
      setMutation('nextRole', 'ARCHITECT'),
      setMutation('architecture', { modules }),
    ]);
  }

  function tier2SplitState(modules: string[] = ['cache', 'store', 'api']): AppState {
    const base = tiered(2, designedStateWithModules(modules));
    const decision = decide(base, clock());
    return applyMutations(base, decision.mutations);
  }

  function testingResults(passed: boolean): AppState['testResults'] {
    return { passed, total: 3, failed: passed ? 0 : 3, failures: [] };
  }

  it('Tier 0 skips PM and ARCH even when the roster has them (spec §3 直接小环)', () => {
    const state = tiered(0, createInitialAppState('t-1', '实现带 TTL 的 LRU 缓存'));
    const decision = decide(state, { ...clock(), roster: FULL_ROSTER });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('coding');
    expect(next.nextRole).toBe('CODER');
  });

  it('Tier 0 skips ARCH when requirements are ready (no planning leg)', () => {
    const state = tiered(0, requirementsReadyState());
    const decision = decide(state, { ...clock(), roster: FULL_ROSTER });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
  });

  it('Tier 0 still routes REVIEWER after passing tests when rostered (裁决①: spec only skips PM/ARCH)', () => {
    const decision = decide(tiered(0, testingState(true)), { ...clock(), roster: FULL_ROSTER });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('REVIEWER');
  });

  it('Tier 1 and unset complexity keep the full-machine head: PM first (drift-zero contract)', () => {
    const tieredOne = decide(tiered(1, createInitialAppState('t-1', 'g')), {
      ...clock(),
      roster: FULL_ROSTER,
    });
    expect(tieredOne.route.kind).toBe('worker');
    if (tieredOne.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(tieredOne.route.batch[0].role).toBe('PM');

    const unset = decide(createInitialAppState('t-1', 'g'), { ...clock(), roster: FULL_ROSTER });
    expect(unset.route.kind).toBe('worker');
    if (unset.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(unset.route.batch[0].role).toBe('PM');
  });

  it('Tier 2 splits architecture.modules into CODER subtasks and activates the first (拆分但不并行)', () => {
    const state = tiered(2, designedStateWithModules(['cache', 'store', 'api']));
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('coding');
    expect(next.subtasks).toHaveLength(3);
    expect(next.subtasks[0]).toMatchObject({
      id: 't-1-sub-0',
      title: 'cache',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'in_progress',
    });
    expect(next.subtasks[1]).toMatchObject({ id: 't-1-sub-1', status: 'todo', dependsOn: [] });
    expect(next.subtasks[2]).toMatchObject({ id: 't-1-sub-2', status: 'todo', dependsOn: [] });

    const announce = next.messages.find((m) => m.type === 'announce');
    expect(announce?.payload).toMatchObject({
      tier: 2,
      subtaskCount: 3,
      degraded: false,
      subtaskId: 't-1-sub-0',
    });
  });

  it('Tier 2 degrades to the single subtask when architecture has no modules (退化不静默)', () => {
    const state = tiered(
      2,
      applyMutations(requirementsReadyState(), [
        setMutation('phase', 'planning'),
        setMutation('architecture', {}),
      ]),
    );
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.subtasks).toHaveLength(1);
    const announce = next.messages.find((m) => m.type === 'announce');
    expect(announce?.payload).toMatchObject({ tier: 2, degraded: true });
  });

  it('Tier 2 marks the passed subtask done and activates the next in array order without burning an iteration', () => {
    const state = applyMutations(tier2SplitState(), [
      setMutation('phase', 'testing'),
      setMutation('nextRole', 'TESTER'),
      setMutation('testResults', testingResults(true)),
    ]);
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-1');

    const next = applyMutations(state, decision.mutations);
    expect(next.subtasks[0]?.status).toBe('done');
    expect(next.subtasks[1]?.status).toBe('in_progress');
    expect(next.subtasks[2]?.status).toBe('todo');
    expect(next.phase).toBe('coding');
    expect(next.iterationCount).toBe(0);
  });

  it('Tier 2 activation gates on dependsOn: dependents stay todo until deps are done (拓扑门控)', () => {
    const split = tier2SplitState();
    const state = applyMutations(split, [
      mergeByIdMutation('subtasks', 't-1-sub-2', { dependsOn: ['t-1-sub-1'] }),
      setMutation('phase', 'testing'),
      setMutation('nextRole', 'TESTER'),
      setMutation('testResults', testingResults(true)),
    ]);
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-1');

    const next = applyMutations(state, decision.mutations);
    expect(next.subtasks[1]?.status).toBe('in_progress');
    expect(next.subtasks[2]?.status).toBe('todo');
  });

  it('Tier 2 routes REVIEWER once the last subtask passes and closes its lifecycle', () => {
    const state = applyMutations(tier2SplitState(), [
      mergeByIdMutation('subtasks', 't-1-sub-0', { status: 'done' }),
      mergeByIdMutation('subtasks', 't-1-sub-1', { status: 'done' }),
      mergeByIdMutation('subtasks', 't-1-sub-2', { status: 'in_progress' }),
      setMutation('phase', 'testing'),
      setMutation('nextRole', 'TESTER'),
      setMutation('testResults', testingResults(true)),
    ]);
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('REVIEWER');

    const next = applyMutations(state, decision.mutations);
    expect(next.subtasks.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(next.phase).toBe('review');
  });

  it('Tier 2 failing tests return CODER to the same in_progress subtask (不跳号)', () => {
    const state = applyMutations(tier2SplitState(), [
      setMutation('phase', 'testing'),
      setMutation('nextRole', 'TESTER'),
      setMutation('testResults', testingResults(false)),
    ]);
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.iterationCount).toBe(1);
    expect(next.phase).toBe('coding');
    expect(next.subtasks[0]?.status).toBe('in_progress');
  });

  it('throws when more than one CODER subtask is in_progress (invariant enforcement)', () => {
    const state = applyMutations(tier2SplitState(), [
      mergeByIdMutation('subtasks', 't-1-sub-1', { status: 'in_progress' }),
      setMutation('phase', 'coding'),
    ]);
    expect(() => decide(state, clock())).toThrow(/exactly one in_progress CODER subtask/);
  });

  it('review changes_requested reopens all subtasks and re-activates the first (裁决③保守重开, DEF-013)', () => {
    const state = applyMutations(tier2SplitState(), [
      mergeByIdMutation('subtasks', 't-1-sub-0', { status: 'done' }),
      mergeByIdMutation('subtasks', 't-1-sub-1', { status: 'done' }),
      mergeByIdMutation('subtasks', 't-1-sub-2', { status: 'done' }),
      setMutation('phase', 'review'),
      setMutation('nextRole', 'REVIEWER'),
      appendMutation('messages', {
        msgId: 'tier2-review-dispatch',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        payload: { nextRole: 'REVIEWER', reviewCommentCursor: 0 },
        display: 'dispatch reviewer',
        ts: 1000,
      }),
      appendMutation('reviewComments', {
        id: 'rc-verdict-1',
        kind: 'verdict',
        verdict: 'changes_requested',
      }),
    ]);
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.subtasks.map((s) => s.status)).toEqual(['in_progress', 'todo', 'todo']);
    expect(next.iterationCount).toBe(1);
    expect(next.phase).toBe('coding');
  });

  it('Tier 2 with the Phase 0 roster keeps the single CODER dispatch (C4: no ARCH to split from)', () => {
    const decision = decide(tiered(2, createInitialAppState('t-1', 'g')), {
      ...clock(),
      roster: PHASE0_ROSTER,
    });

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');
    const next = applyMutations(tiered(2, createInitialAppState('t-1', 'g')), decision.mutations);
    expect(next.subtasks).toHaveLength(1);
  });
});
