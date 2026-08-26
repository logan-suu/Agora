import type { AppState } from '@agora/core-domain';
import { applyMutations, createInitialAppState } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { decide, IterationLimitError, MAX_ITERATIONS } from '../src/index';

interface DeterministicClock {
  newId: () => string;
  now: () => number;
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

function testingState(passed: boolean, iterationCount = 0): AppState {
  return stateAtPhase('testing', {
    iterationCount,
    nextRole: 'TESTER',
    subtasks: [
      {
        id: 't-1-sub-0',
        title: '实现带 TTL 的 LRU 缓存',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'done',
      },
    ],
    testResults: { passed, total: 3, failed: passed ? 0 : 3, failures: [] },
  });
}

describe('coordinator.decide (Phase 0 fixed routing)', () => {
  it('routes CODER first from clarifying: creates the subtask, announces, sets nextRole/phase', () => {
    const state = createInitialAppState('t-1', '实现带 TTL 的 LRU 缓存');
    const decision = decide(state, clock());

    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.parallel).toBe(false);
    expect(decision.route.batch[0].role).toBe('CODER');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('coding');
    expect(next.nextRole).toBe('CODER');
    expect(next.subtasks).toHaveLength(1);
    expect(next.subtasks[0]?.id).toBe('t-1-sub-0');
    expect(next.subtasks[0]?.ownerRole).toBe('CODER');
    expect(next.subtasks[0]?.status).toBe('in_progress');
    expect(next.messages.filter((m) => m.type === 'announce')).toHaveLength(1);

    expect(state.phase).toBe('clarifying');
    expect(state.subtasks).toHaveLength(0);
    expect(state.messages).toHaveLength(0);
  });

  it('advances to TESTING after the CODER worker finishes a coding round', () => {
    const state = stateAtPhase('coding', {
      nextRole: 'CODER',
      subtasks: [
        { id: 't-1-sub-0', title: 'g', ownerRole: 'CODER', dependsOn: [], status: 'in_progress' },
      ],
    });

    const decision = decide(state);
    expect(decision.route.kind).toBe('worker');
    if (decision.route.kind !== 'worker') throw new Error('unreachable guard for narrowing');
    expect(decision.route.batch[0].role).toBe('TESTER');
    expect(decision.route.batch[0].subtaskId).toBe('t-1-sub-0');

    const next = applyMutations(state, decision.mutations);
    expect(next.phase).toBe('testing');
    expect(next.nextRole).toBe('TESTER');
  });

  it('returns the finalize route when TESTER reports passing results', () => {
    const decision = decide(testingState(true));
    expect(decision.route.kind).toBe('finalize');
    expect(decision.mutations).toEqual([]);
  });

  it('sends failing results back to CODER and increments iterationCount to 1', () => {
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

  it('throws IterationLimitError instead of looping silently once iterationCount reaches the cap', () => {
    const capped = testingState(false, MAX_ITERATIONS);
    expect(() => decide(capped)).toThrow(IterationLimitError);
    expect(MAX_ITERATIONS).toBe(8);
  });

  it('never returns integrate/human_gate routes or parallel batches in the Phase 0 slice', () => {
    const decisions = [
      decide(createInitialAppState('t-1', 'g'), clock()),
      decide(
        stateAtPhase('coding', {
          nextRole: 'CODER',
          subtasks: [
            {
              id: 't-1-sub-0',
              title: 'g',
              ownerRole: 'CODER',
              dependsOn: [],
              status: 'in_progress',
            },
          ],
        }),
      ),
      decide(testingState(true)),
      decide(testingState(false, 2), clock()),
      decide(stateAtPhase('done')),
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

  it('throws an explicit error for phases unreachable under the Phase 0 fixed sequence', () => {
    for (const phase of ['planning', 'review', 'integrating'] as const) {
      expect(() => decide(stateAtPhase(phase))).toThrow(/not routable/);
    }
  });
});
