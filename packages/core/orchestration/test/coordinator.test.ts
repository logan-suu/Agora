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
    const state = testingState(true);
    const decision = decide(state, { ...clock(), roster: PHASE0_ROSTER });
    expect(decision.route.kind).toBe('finalize');
    // task 4.2: passing tests now close the subtask lifecycle (done) even on
    // the finalize leg — intended behavior change, not assertion weakening.
    const next = applyMutations(state, decision.mutations);
    expect(next.subtasks[0]?.status).toBe('done');
  });
});

describe('coordinator.decide · tier-aware topology routing (task 4.2, spec §3)', () => {
  // Full six-role machine built inline (core-domain only exports PHASE0_ROSTER;
  // roles-definitions is not an orchestration dependency — same pattern as the
  // pmOnlyRoster test above).
  const FULL_ROSTER: RoleSpec[] = (
    ['COORDINATOR', 'PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER'] as const
  ).map((role) => ({
    role,
    enabled: true,
    executor: 'harness' as const,
    systemPrompt: '',
    tools: [],
    projection: [],
    routeWhen: 'always',
  }));

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

  it('review changes_requested reopens all subtasks and re-activates the first (裁决③保守重开, DEF-013)', () => {
    const state = applyMutations(tier2SplitState(), [
      mergeByIdMutation('subtasks', 't-1-sub-0', { status: 'done' }),
      mergeByIdMutation('subtasks', 't-1-sub-1', { status: 'done' }),
      mergeByIdMutation('subtasks', 't-1-sub-2', { status: 'done' }),
      setMutation('phase', 'review'),
      setMutation('nextRole', 'REVIEWER'),
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
