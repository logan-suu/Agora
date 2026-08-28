import type { AppState, RoleSpec } from '@agora/core-domain';
import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  PHASE0_ROSTER,
  setMutation,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { decide, MAX_ITERATIONS } from '../src/index';

interface DeterministicClock {
  newId: () => string;
  now: () => number;
}

function expectedGate(phase: AppState['phase']): Record<string, unknown> {
  return { reason: 'iteration_limit', options: ['extend', 'take-over', 'abort'], phase };
}

function clock(): DeterministicClock {
  let counter = 0;
  return { newId: () => `id-${++counter}`, now: () => 1000 };
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

function testingState(passed: boolean, iterationCount = 0): AppState {
  return applyMutations(codingState(), [
    setMutation('phase', 'testing'),
    setMutation('nextRole', 'TESTER'),
    setMutation('iterationCount', iterationCount),
    setMutation('testResults', { passed, total: 3, failed: passed ? 0 : 3, failures: [] }),
  ]);
}

function reviewState(verdict: 'approved' | 'changes_requested', iterationCount = 0): AppState {
  return applyMutations(testingState(true, iterationCount), [
    setMutation('phase', 'review'),
    setMutation('nextRole', 'REVIEWER'),
    appendMutation('reviewComments', { id: 'rc-note-1', kind: 'comment', summary: 'naming' }),
    appendMutation('reviewComments', { id: 'rc-verdict-1', kind: 'verdict', verdict }),
  ]);
}

describe('coordinator.decide · conditional routing (task 2.2, spec §5.3)', () => {
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

  it('finalizes when the REVIEWER verdict is approved (评审通过, DEF-007 Phase 2 simplification)', () => {
    const decision = decide(reviewState('approved'));
    expect(decision.route.kind).toBe('finalize');
    expect(decision.mutations).toEqual([]);
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

  it('escalates to human_gate when the review loop reaches the iteration cap (评审回环超限升级)', () => {
    const capped = reviewState('changes_requested', MAX_ITERATIONS);
    const decision = decide(capped);

    expect(decision.route.kind).toBe('human_gate');
    const next = applyMutations(capped, decision.mutations);
    expect(next.humanGate).toEqual(expectedGate('review'));
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
    const state = applyMutations(testingState(true), [setMutation('phase', 'review')]);
    expect(() => decide(state)).toThrow(/verdict/);
  });

  it('throws on an unknown verdict value instead of guessing a route', () => {
    const state = applyMutations(testingState(true), [
      setMutation('phase', 'review'),
      appendMutation('reviewComments', { id: 'rc-1', kind: 'verdict', verdict: 'kinda-fine' }),
    ]);
    expect(() => decide(state)).toThrow(/verdict/);
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
    const next = applyMutations(capped, decision.mutations);
    expect(next.humanGate).toEqual(expectedGate('testing'));
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

  it('never returns integrate/human_gate routes below the iteration cap, and never parallel batches', () => {
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
      expect(['worker', 'finalize']).toContain(decision.route.kind);
      expect(decision.route.kind).not.toBe('integrate');
      expect(decision.route.kind).not.toBe('human_gate');
      if (decision.route.kind === 'worker') {
        expect(decision.route.parallel).toBe(false);
        expect(decision.route.batch).toHaveLength(1);
      }
    }
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

  it('skips PM when requirements are ready even if the roster has one, and skips ARCH when absent', () => {
    const pmOnlyRoster: RoleSpec[] = [
      {
        role: 'PM',
        enabled: true,
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
    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('CODER');
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
    const next = applyMutations(capped, decision.mutations);
    expect(next.humanGate).toEqual(expectedGate('clarifying'));
    expect(next.iterationCount).toBe(MAX_ITERATIONS);
    expect(next.phase).toBe('clarifying');
    expect(next.messages.filter((m) => m.type === 'escalation')).toHaveLength(1);
  });

  it('finalizes on passing tests when the roster has no REVIEWER (Phase 0 slice)', () => {
    const decision = decide(testingState(true), { ...clock(), roster: PHASE0_ROSTER });
    expect(decision.route.kind).toBe('finalize');
    expect(decision.mutations).toEqual([]);
  });
});
