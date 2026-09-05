import type { AppState, Message } from '@agora/core-domain';
import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import {
  buildCoordinationLedger,
  decide,
  evaluateComplexity,
  MAX_ITERATIONS,
  MAX_STALLS,
} from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { describe, expect, it } from 'vitest';

// Phase 4 cumulative release-gate integration: no mocks. These tests compose
// the real domain reducer, complexity evaluator, Coordinator, and progress
// Ledger. The full Harness/MCP/LocalTempSandbox chain remains covered by the
// Phase 0-4 exit/e2e suites that this gate runs cumulatively.

function clock() {
  let id = 0;
  return { newId: () => `phase4-exit-${++id}`, now: () => 4_600 };
}

function workerRole(decision: ReturnType<typeof decide>): string {
  expect(decision.route.kind).toBe('worker');
  if (decision.route.kind !== 'worker') throw new Error('expected a worker route');
  expect(decision.route.parallel).toBe(false);
  return decision.route.batch[0].role;
}

function failedResults(): AppState['testResults'] {
  return {
    passed: false,
    total: 1,
    failed: 1,
    failures: [{ test: 'cache', message: 'failed', file: 'src/cache.test.ts', line: 9 }],
  };
}

function firstFailureState(): AppState {
  return applyMutations(createInitialAppState('phase4-escalation', 'Implement a cache helper'), [
    setMutation('complexity', { tier: 0, signals: { rule: 'tier0.single_entity' } }),
    mergeByIdMutation('subtasks', 'phase4-escalation-sub-0', {
      title: 'Implement a cache helper',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'in_progress',
    }),
    setMutation('phase', 'testing'),
    setMutation('nextRole', 'TESTER'),
    setMutation('testResults', failedResults()),
  ]);
}

function completePendingWorkers(state: AppState): AppState {
  return applyMutations(
    state,
    state.workers
      .filter((worker) => worker.status === 'pending')
      .map((worker) => mergeByIdMutation('workers', worker.workerId, { status: 'done' })),
  );
}

function secondFailureScenario(): { state: AppState; scenarioClock: ReturnType<typeof clock> } {
  const scenarioClock = clock();
  const first = firstFailureState();
  const repair = completePendingWorkers(
    applyMutations(first, decide(first, { ...scenarioClock, roster: DEFAULT_ROSTER }).mutations),
  );
  const retest = completePendingWorkers(
    applyMutations(repair, decide(repair, { ...scenarioClock, roster: DEFAULT_ROSTER }).mutations),
  );
  return {
    state: applyMutations(retest, [setMutation('testResults', failedResults())]),
    scenarioClock,
  };
}

function ledgerMessage(
  payload: ReturnType<typeof buildCoordinationLedger>,
  index: number,
): Message {
  return {
    msgId: `phase4-ledger-${index}`,
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'chat',
    payload,
    display: `Coordinator Ledger r${payload.revision}`,
    ts: index,
  };
}

describe('Phase 4 cumulative exit gate', () => {
  it('audits Tier 0/1/2 classification and the corresponding sequential topology', () => {
    const scenarios = [
      { goal: 'Implement one function', tier: 0 as const, firstRole: 'CODER' },
      { goal: 'Improve checkout flow', tier: 1 as const, firstRole: 'PM' },
      { goal: 'Implement a REST API service', tier: 2 as const, firstRole: 'PM' },
    ];

    for (const scenario of scenarios) {
      const complexity = evaluateComplexity({ goal: scenario.goal });
      const state = applyMutations(createInitialAppState(`tier-${scenario.tier}`, scenario.goal), [
        setMutation('complexity', complexity),
      ]);
      const decision = decide(state, { ...clock(), roster: DEFAULT_ROSTER });

      expect(complexity.tier).toBe(scenario.tier);
      expect(workerRole(decision)).toBe(scenario.firstRole);
    }

    const tier2Planning = applyMutations(
      createInitialAppState('tier-2-split', 'Implement a REST API service'),
      [
        setMutation('complexity', { tier: 2, signals: { rule: 'tier2.multi_module' } }),
        mergeByIdMutation('requirements', 'req-1', {
          story: 'Expose a REST API',
          acceptance: ['responds successfully'],
          nonGoals: [],
        }),
        setMutation('architecture', { modules: ['api', 'service', 'store'] }),
        setMutation('phase', 'planning'),
        setMutation('nextRole', 'ARCHITECT'),
      ],
    );
    const split = decide(tier2Planning, { ...clock(), roster: DEFAULT_ROSTER });
    const splitState = applyMutations(tier2Planning, split.mutations);

    expect(workerRole(split)).toBe('CODER');
    expect(splitState.subtasks.map(({ title, status }) => ({ title, status }))).toEqual([
      { title: 'api', status: 'in_progress' },
      { title: 'service', status: 'todo' },
      { title: 'store', status: 'todo' },
    ]);
  });

  it('composes repeated-failure, architecture, and iteration-limit escalation precedence', () => {
    const { state: secondFailure, scenarioClock } = secondFailureScenario();
    const rootCauseReview = decide(secondFailure, {
      ...scenarioClock,
      roster: DEFAULT_ROSTER,
    });
    expect(workerRole(rootCauseReview)).toBe('REVIEWER');

    const reviewState = completePendingWorkers(
      applyMutations(secondFailure, rootCauseReview.mutations),
    );
    const architectureVerdict = applyMutations(reviewState, [
      appendMutation('reviewComments', {
        id: 'phase4-architecture-verdict',
        kind: 'verdict',
        verdict: 'changes_requested',
        issueScope: 'architecture',
        summary: 'The module boundary is wrong',
      }),
    ]);
    expect(architectureVerdict.workers.filter((worker) => worker.status === 'pending')).toEqual([]);
    expect(architectureVerdict.phase).toBe('review');
    const architectureEscalation = decide(architectureVerdict, {
      ...scenarioClock,
      roster: DEFAULT_ROSTER,
    });
    const redesigned = applyMutations(architectureVerdict, architectureEscalation.mutations);

    expect(workerRole(architectureEscalation)).toBe('ARCHITECT');
    expect(redesigned.phase).toBe('planning');
    expect(redesigned.complexity).toMatchObject({
      tier: 1,
      signals: { escalation: { reason: 'reviewer_architecture_issue', previousTier: 0 } },
    });

    const capped = applyMutations(secondFailure, [setMutation('iterationCount', MAX_ITERATIONS)]);
    const gate = decide(capped, { ...scenarioClock, roster: DEFAULT_ROSTER });
    const gated = applyMutations(capped, gate.mutations);

    expect(gate.route.kind).toBe('human_gate');
    expect(gated.humanGate).toBeUndefined();
    if (gate.route.kind !== 'human_gate') throw new Error('expected human_gate route');
    expect(gate.route.request).toMatchObject({
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'testing',
    });
  });

  it('replans after maxStalls while completion remains leader-owned', () => {
    let state = applyMutations(createInitialAppState('phase4-ledger', 'Build a cache'), [
      setMutation('complexity', { tier: 1, signals: { rule: 'tier1.default' } }),
    ]);
    let ledger = buildCoordinationLedger(state, {
      nextSpeaker: 'CODER',
      instruction: 'Implement the active subtask',
      completionCandidate: false,
    });
    state = applyMutations(state, [appendMutation('messages', ledgerMessage(ledger, 0))]);

    for (let index = 1; index <= MAX_STALLS; index += 1) {
      ledger = buildCoordinationLedger(state, {
        nextSpeaker: 'CODER',
        instruction: `Rework attempt ${index}`,
        completionCandidate: false,
        loopReason: 'review_changes_requested',
      });
      state = applyMutations(state, [appendMutation('messages', ledgerMessage(ledger, index))]);
    }

    expect(ledger).toMatchObject({
      revision: 2,
      replanned: true,
      replanReason: 'max_stalls_reached',
      stallCount: 0,
    });
    expect(ledger.task.plan.every((step) => step.revision === 2)).toBe(true);

    const completed = applyMutations(state, [setMutation('phase', 'done')]);
    const completion = buildCoordinationLedger(completed, {
      nextSpeaker: null,
      instruction: 'Finalize the task result',
      completionCandidate: true,
    });

    expect(completion.completionCandidate).toBe(true);
    expect(completion.progress.isRequestSatisfied).toEqual({
      reason: 'awaiting_leader_confirmation',
      answer: false,
      authority: 'leader',
    });
  });
});
