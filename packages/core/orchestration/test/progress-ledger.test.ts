import {
  type AppState,
  createInitialAppState,
  type Message,
  type RoleId,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import {
  buildCoordinationLedger,
  COORDINATION_LEDGER_KIND,
  latestCoordinationLedger,
  MAX_STALLS,
  type ProgressObservation,
} from '../src/progress-ledger';

// Pure deterministic state evaluation: no mocks. The tests lock Agora's
// MagenticOne adaptation — structured ledgers, leader-only satisfaction, and
// maxStalls=3 replanning without adding an LLM coordinator.

function observation(overrides: Partial<ProgressObservation> = {}): ProgressObservation {
  return {
    nextSpeaker: 'CODER',
    instruction: 'Implement the active subtask',
    completionCandidate: false,
    availableRoles: ['COORDINATOR', 'PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER'],
    ...overrides,
  };
}

function ledgerMessage(
  payload: ReturnType<typeof buildCoordinationLedger>,
  index: number,
): Message {
  return {
    msgId: `ledger-${index}`,
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'chat',
    payload,
    display: `Coordinator ledger revision ${payload.revision}`,
    ts: index,
  };
}

function record(
  state: AppState,
  entry: ReturnType<typeof buildCoordinationLedger>,
  index: number,
): AppState {
  return { ...state, messages: [...state.messages, ledgerMessage(entry, index)] };
}

describe('buildCoordinationLedger (task 4.4, MagenticOne adaptation)', () => {
  it('initializes strict task/progress ledgers from structured State', () => {
    const state = {
      ...createInitialAppState('task-44', 'Build a cache'),
      complexity: { tier: 1 as const, signals: { rule: 'tier1.default' } },
    };
    const ledger = buildCoordinationLedger(state, observation());

    expect(ledger).toMatchObject({
      kind: COORDINATION_LEDGER_KIND,
      revision: 1,
      stallCount: 0,
      replanned: false,
      completionCandidate: false,
      progress: {
        isRequestSatisfied: {
          reason: 'task_incomplete',
          answer: false,
          authority: 'leader',
        },
        isInLoop: { reason: 'first_evaluation', answer: false },
        isProgressBeingMade: { reason: 'structured_state_advanced', answer: true },
        nextSpeaker: { reason: 'coordinator_route', answer: 'CODER' },
        instructionOrQuestion: {
          reason: 'coordinator_instruction',
          answer: 'Implement the active subtask',
        },
      },
    });
    expect(ledger.task.confirmedFacts).toEqual(
      expect.arrayContaining([
        { key: 'goal', value: 'Build a cache' },
        { key: 'complexityTier', value: 1 },
      ]),
    );
    expect(ledger.task.hypotheses).toEqual([]);
    expect(ledger.task.plan.map((step) => step.role)).toEqual([
      'PM',
      'ARCHITECT',
      'CODER',
      'TESTER',
      'REVIEWER',
    ]);
  });

  it('keeps request satisfaction leader-owned even when machine evidence is complete', () => {
    const ledger = buildCoordinationLedger(
      createInitialAppState('task-44', 'Build a cache'),
      observation({ nextSpeaker: null, instruction: 'Finalize', completionCandidate: true }),
    );

    expect(ledger.completionCandidate).toBe(true);
    expect(ledger.progress.isRequestSatisfied).toEqual({
      reason: 'awaiting_leader_confirmation',
      answer: false,
      authority: 'leader',
    });
    expect(ledger.progress.nextSpeaker.answer).toBeNull();
  });

  it('counts an explicit retry as a stall even when feedback changed State', () => {
    const initial = createInitialAppState('task-44', 'Build a cache');
    const first = buildCoordinationLedger(initial, observation());
    const state = record(
      {
        ...initial,
        phase: 'testing',
        testResults: {
          passed: false,
          total: 1,
          failed: 1,
          failures: [{ test: 'cache', message: 'failed', file: 'src/cache.test.ts', line: 9 }],
        },
      },
      first,
      1,
    );
    const stalled = buildCoordinationLedger(
      state,
      observation({ loopReason: 'tests_failed', instruction: 'Fix the failing test' }),
    );

    expect(stalled.stallCount).toBe(1);
    expect(stalled.progress.isInLoop).toEqual({ reason: 'tests_failed', answer: true });
    expect(stalled.progress.isProgressBeingMade.answer).toBe(false);
  });

  it('treats an unchanged structured progress marker as a stall without counting iterationCount', () => {
    const initial = createInitialAppState('task-44', 'Build a cache');
    const first = buildCoordinationLedger(initial, observation());
    const unchangedExceptIteration = record({ ...initial, iterationCount: 7 }, first, 1);
    const stalled = buildCoordinationLedger(unchangedExceptIteration, observation());

    expect(stalled.progressMarker).toBe(first.progressMarker);
    expect(stalled.progress.isInLoop).toEqual({ reason: 'no_structured_progress', answer: true });
    expect(stalled.stallCount).toBe(1);
  });

  it('rebuilds the outer task ledger on the third consecutive stall', () => {
    let state = createInitialAppState('task-44', 'Build a cache');
    let ledger = buildCoordinationLedger(state, observation());
    state = record(state, ledger, 1);

    for (let index = 1; index <= MAX_STALLS; index += 1) {
      ledger = buildCoordinationLedger(
        state,
        observation({ loopReason: 'review_changes_requested', instruction: `Rework ${index}` }),
      );
      state = record(state, ledger, index + 1);
    }

    expect(ledger.revision).toBe(2);
    expect(ledger.replanned).toBe(true);
    expect(ledger.replanReason).toBe('max_stalls_reached');
    expect(ledger.stallCount).toBe(0);
    expect(ledger.task.plan.every((step) => step.revision === 2)).toBe(true);
  });

  it('resets stalls when structured State advances and filters unavailable roles from the plan', () => {
    const initial = createInitialAppState('task-44', 'Build a cache');
    const first = buildCoordinationLedger(initial, observation({ loopReason: 'tests_failed' }));
    const advanced = record(
      {
        ...initial,
        phase: 'coding',
        requirements: [
          { id: 'req-1', story: 'Cache values', acceptance: ['get works'], nonGoals: [] },
        ],
      },
      first,
      1,
    );
    const recovered = buildCoordinationLedger(
      advanced,
      observation({ availableRoles: ['COORDINATOR', 'CODER', 'TESTER'] }),
    );

    expect(recovered.stallCount).toBe(0);
    expect(recovered.progress.isProgressBeingMade.answer).toBe(true);
    expect(recovered.task.plan.map((step) => step.role)).toEqual(['CODER', 'TESTER']);
  });

  it.each([
    {
      role: 'ARCHITECT',
      state: {
        ...createInitialAppState('task-44', 'Build a cache'),
        architecture: { modules: ['legacy-cache'] },
      },
    },
    {
      role: 'TESTER',
      state: {
        ...createInitialAppState('task-44', 'Build a cache'),
        testResults: { passed: true, total: 1, failed: 0, failures: [] },
      },
    },
  ])(
    'marks the currently routed $role plan step active even when old artifacts exist',
    ({ role, state }) => {
      const ledger = buildCoordinationLedger(
        state,
        observation({ nextSpeaker: role, instruction: `Run ${role} again` }),
      );

      expect(ledger.task.plan.find((step) => step.role === role)?.status).toBe('active');
    },
  );

  it('reads only well-shaped Coordinator ledger events from the append-only message stream', () => {
    const state = createInitialAppState('task-44', 'Build a cache');
    const ledger = buildCoordinationLedger(state, observation());
    const withNoise: AppState = {
      ...state,
      messages: [
        {
          msgId: 'noise',
          channelId: 'main',
          fromRole: 'PM',
          type: 'chat',
          payload: { kind: COORDINATION_LEDGER_KIND, revision: 999 },
          display: 'not authoritative',
          ts: 1,
        },
        ledgerMessage(ledger, 2),
      ],
    };

    expect(latestCoordinationLedger(withNoise)).toEqual(ledger);
  });

  it('rejects a nested Ledger event whose plan violates the strict JSON schema', () => {
    const state = createInitialAppState('task-44', 'Build a cache');
    const malformed = buildCoordinationLedger(state, observation());
    malformed.task.plan = [{ role: 'CODER' } as never];
    const withMalformed = record(state, malformed, 1);

    expect(latestCoordinationLedger(withMalformed)).toBeUndefined();
  });

  it('rejects undeclared fields at every Ledger object boundary', () => {
    const state = createInitialAppState('task-44', 'Build a cache');
    const valid = buildCoordinationLedger(state, observation());
    const withExtra = (
      mutate: (payload: ReturnType<typeof buildCoordinationLedger>) => void,
    ): ReturnType<typeof buildCoordinationLedger> => {
      const payload = structuredClone(valid);
      mutate(payload);
      return payload;
    };
    const malformed = [
      withExtra((payload) => Object.assign(payload, { rawLog: 'forbidden' })),
      withExtra((payload) => Object.assign(payload.task, { rawLog: 'forbidden' })),
      withExtra((payload) => {
        const fact = payload.task.confirmedFacts[0];
        if (fact === undefined) throw new Error('fixture requires a confirmed fact');
        Object.assign(fact, { rawLog: 'forbidden' });
      }),
      withExtra((payload) => {
        const step = payload.task.plan[0];
        if (step === undefined) throw new Error('fixture requires a plan step');
        Object.assign(step, { rawLog: 'forbidden' });
      }),
      withExtra((payload) => Object.assign(payload.progress, { rawLog: 'forbidden' })),
      withExtra((payload) =>
        Object.assign(payload.progress.isRequestSatisfied, { rawLog: 'forbidden' }),
      ),
      withExtra((payload) => Object.assign(payload.progress.isInLoop, { rawLog: 'forbidden' })),
      withExtra((payload) =>
        Object.assign(payload.progress.isProgressBeingMade, { rawLog: 'forbidden' }),
      ),
      withExtra((payload) => Object.assign(payload.progress.nextSpeaker, { rawLog: 'forbidden' })),
      withExtra((payload) =>
        Object.assign(payload.progress.instructionOrQuestion, { rawLog: 'forbidden' }),
      ),
    ];

    for (const [index, payload] of malformed.entries()) {
      expect(latestCoordinationLedger(record(state, payload, index))).toBeUndefined();
    }
  });

  it('uses camelCase ledger fields and JSON-safe role answers', () => {
    const speaker: RoleId = 'ARCHITECT';
    const ledger = buildCoordinationLedger(
      createInitialAppState('task-44', 'Build a cache'),
      observation({ nextSpeaker: speaker }),
    );
    const json = JSON.stringify(ledger);

    expect(json).toContain('isRequestSatisfied');
    expect(json).toContain('instructionOrQuestion');
    expect(json).not.toContain('is_request_satisfied');
    expect(JSON.parse(json)).toEqual(ledger);
  });
});
