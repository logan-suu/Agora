// Mock 原因（R11）：Harness 薄执行器在任务 0.5 才交付，本文件注入 FakeExecutor（实现 Executor 端口）
// 以单元级验证编排主循环的固定路由/失败回环/finalize 与纯函数性；
// 不以 test double 替代真实链路验收——G5 实测留待 0.5（HarnessExecutor）/0.6（LRU e2e）/0.7（集成）。

import type { AppState } from '@agora/core-domain';
import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  PHASE0_ROSTER,
  setMutation,
} from '@agora/core-domain';
import type { Executor, StepResult } from '@agora/runtime-executor';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ITERATIONS } from '../src/coordinator';
import type { OrchestrationDeps } from '../src/index';
import { entry, GlobalScheduler, runOrchestration, WorkerRuntime } from '../src/index';

class FakeExecutor implements Executor {
  private readonly queue: StepResult[];

  constructor(steps: StepResult[]) {
    this.queue = [...steps];
  }

  async step(): Promise<StepResult> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('fake executor exhausted its scripted steps');
    return next;
  }

  async saveSafePoint(): Promise<string> {
    return 'cursor';
  }

  async loadSafePoint(): Promise<void> {}

  injectInbox(): void {}
}

const SUBTASK_ID = 'lru-1-sub-0';

function coderRound(round: number): FakeExecutor {
  return new FakeExecutor([
    {
      kind: 'llm',
      output: {},
      reachedSafeBoundary: true,
      mutations: [
        mergeByIdMutation('subtasks', SUBTASK_ID, { status: 'in_progress' }),
        {
          field: 'messages',
          op: 'append',
          value: message(`coder-code-r${round}`),
        },
      ],
    },
    { kind: 'tool', output: {}, reachedSafeBoundary: true, mutations: [] },
    // task 4.2: subtask lifecycle is coordinator-owned (done is set by the
    // coordinator on test pass) — the worker no longer self-marks done.
    { kind: 'done', output: {}, reachedSafeBoundary: true, mutations: [] },
  ]);
}

function testerRound(passed: boolean): FakeExecutor {
  return new FakeExecutor([
    {
      kind: 'tool',
      output: {},
      reachedSafeBoundary: true,
      mutations: [
        {
          field: 'testResults',
          op: 'set',
          value: { passed, total: 2, failed: passed ? 0 : 1, failures: [] },
        },
      ],
    },
    { kind: 'done', output: {}, reachedSafeBoundary: true, mutations: [] },
  ]);
}

function message(msgId: string): {
  msgId: string;
  channelId: string;
  fromRole: string;
  type: 'chat';
  payload: Record<string, unknown>;
  display: string;
  ts: number;
} {
  return {
    msgId,
    channelId: 'main',
    fromRole: 'CODER',
    type: 'chat',
    payload: {},
    display: msgId,
    ts: 1,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function orchestrationWith(coders: FakeExecutor[], testers: FakeExecutor[]): OrchestrationDeps {
  let coderCursor = 0;
  let testerCursor = 0;
  const workerRuntime = new WorkerRuntime({
    roster: PHASE0_ROSTER,
    buildExecutor: (_spec, assign) => {
      if (assign.role === 'CODER') {
        const fake = coders[coderCursor];
        coderCursor += 1;
        if (fake === undefined) throw new Error('no scripted CODER round left');
        return fake;
      }
      if (assign.role === 'TESTER') {
        const fake = testers[testerCursor];
        testerCursor += 1;
        if (fake === undefined) throw new Error('no scripted TESTER round left');
        return fake;
      }
      throw new Error(`unexpected role assignment: ${assign.role}`);
    },
  });
  return { workerRuntime, roster: PHASE0_ROSTER };
}

describe('runOrchestration (Phase 0 fixed loop)', () => {
  it('bounds retries for a failed singleton CODER in a parallel plan', async () => {
    let canonical = applyMutations(createInitialAppState('single-failure', 'Implement one unit'), [
      setMutation('complexity', { tier: 2, signals: {} }),
      setMutation('phase', 'planning'),
      setMutation('architecture', {
        executionPlan: { version: 1, subtasks: [{ id: 'A', title: 'Only unit', dependsOn: [] }] },
      }),
    ]);
    let calls = 0;
    const transition: NonNullable<OrchestrationDeps['transition']> = async (_state, mutations) =>
      (canonical = applyMutations(canonical, mutations));
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      loadState: async () => canonical,
      transition,
      buildExecutor: () => ({
        async step() {
          calls += 1;
          throw new Error('controlled CODER failure');
        },
        async saveSafePoint() {
          return 'controlled-safe-point';
        },
        async loadSafePoint() {},
        injectInbox() {},
      }),
    });
    const result = await runOrchestration(canonical, {
      workerRuntime: runtime,
      transition,
      parallelContext: async () => ({
        initialBase: { branch: 'main', commit: 'a'.repeat(40) },
        controlFingerprint: 'f'.repeat(64),
      }),
    });
    expect(result.humanGate?.reason).toBe('iteration_limit');
    expect(result.iterationCount).toBe(MAX_ITERATIONS);
    expect(calls).toBe(MAX_ITERATIONS + 1);
    expect(new Set(result.workers.map((worker) => worker.workerId)).size).toBe(calls);
    expect(result.workers.every((worker) => worker.status === 'failed')).toBe(true);
  });

  it('retries the whole failed and not-started batch with new identities at capacity one', async () => {
    let canonical = applyMutations(
      createInitialAppState('capacity-one-retry', 'Implement independent units'),
      [
        setMutation('complexity', { tier: 2, signals: {} }),
        setMutation('phase', 'planning'),
        setMutation('architecture', {
          executionPlan: {
            version: 1,
            subtasks: ['A', 'B', 'C'].map((id) => ({ id, title: id, dependsOn: [] })),
          },
        }),
      ],
    );
    const transition: NonNullable<OrchestrationDeps['transition']> = async (_state, mutations) =>
      (canonical = applyMutations(canonical, mutations));
    const attempts: { workerId: string; subtaskId: string }[] = [];
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        loadState: async () => canonical,
        transition,
        buildExecutor: (_spec, assignment) => ({
          async step() {
            if (assignment.subtaskId === undefined) throw new Error('missing coding subtask');
            attempts.push({ workerId: assignment.workerId, subtaskId: assignment.subtaskId });
            if (attempts.length === 1)
              throw new Error('first CODER failed before siblings started');
            return { kind: 'done' as const, output: {}, reachedSafeBoundary: true, mutations: [] };
          },
          async saveSafePoint() {
            return 'safe';
          },
          async loadSafePoint() {},
          injectInbox() {},
        }),
      },
      new GlobalScheduler({ cap: 1 }),
    );
    // Stop at the real orchestration integration route; this test isolates retry ownership.
    const integrate = vi.fn(async () => {
      throw new Error('reached integration after retry');
    });
    await expect(
      runOrchestration(canonical, {
        workerRuntime: runtime,
        transition,
        integrate,
        parallelContext: async () => ({
          initialBase: { branch: 'main', commit: 'a'.repeat(40) },
          controlFingerprint: 'f'.repeat(64),
        }),
      }),
    ).rejects.toThrow('reached integration after retry');
    expect(integrate).toHaveBeenCalledOnce();
    const original = canonical.messages.find((message) => message.payload.kind === 'coding_wave')
      ?.payload.workerIds;
    if (!Array.isArray(original)) throw new Error('expected original coding wave');
    expect(attempts.map((attempt) => attempt.subtaskId)).toEqual(['A', 'A', 'B', 'C']);
    expect(attempts.slice(1).every((attempt) => !original.includes(attempt.workerId))).toBe(true);
    expect(canonical.iterationCount).toBe(1);
    expect(canonical.parallelExecution?.activeWave?.coderWorkerIds).toEqual(
      attempts.slice(1).map((attempt) => attempt.workerId),
    );
  });

  it.each(['workspace', 'completion', 'lease'] as const)(
    'does not retry a singleton infrastructure failure at %s',
    async (boundary) => {
      let canonical = applyMutations(
        createInitialAppState('single-infrastructure-failure', 'Implement one unit'),
        [
          setMutation('complexity', { tier: 2, signals: {} }),
          setMutation('phase', 'planning'),
          setMutation('architecture', {
            executionPlan: {
              version: 1,
              subtasks: [{ id: 'A', title: 'Only unit', dependsOn: [] }],
            },
          }),
        ],
      );
      const transition: NonNullable<OrchestrationDeps['transition']> = async (_state, mutations) =>
        (canonical = applyMutations(canonical, mutations));
      const scheduler = new GlobalScheduler();
      if (boundary === 'lease')
        vi.spyOn(scheduler, 'release').mockRejectedValueOnce(
          new Error('lease infrastructure failure'),
        );
      const runtime = new WorkerRuntime(
        {
          roster: PHASE0_ROSTER,
          loadState: async () => canonical,
          transition,
          ...(boundary === 'workspace'
            ? {
                resolveWorktree: async () => {
                  throw new Error('workspace infrastructure failure');
                },
              }
            : {}),
          ...(boundary === 'completion'
            ? {
                completeAssignment: async () => {
                  throw new Error('completion infrastructure failure');
                },
              }
            : {}),
          buildExecutor: () =>
            new FakeExecutor([
              { kind: 'done', output: {}, reachedSafeBoundary: true, mutations: [] },
            ]),
        },
        scheduler,
      );
      await expect(
        runOrchestration(canonical, {
          workerRuntime: runtime,
          transition,
          parallelContext: async () => ({
            initialBase: { branch: 'main', commit: 'a'.repeat(40) },
            controlFingerprint: 'f'.repeat(64),
          }),
        }),
      ).rejects.toThrow(`${boundary} infrastructure failure`);
      expect(canonical.iterationCount).toBe(0);
      expect(canonical.workers).toHaveLength(1);
      expect(canonical.phase).toBe('coding');
    },
  );

  it('dispatches a recovered multi-worker route through runParallel', async () => {
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => new FakeExecutor([]),
    });
    const runParallel = vi.spyOn(runtime, 'runParallel').mockImplementation(async (state) => ({
      ...state,
      phase: 'done',
    }));
    const runOne = vi.spyOn(runtime, 'runOne');
    const state = applyMutations(createInitialAppState('parallel-route', 'g'), [
      mergeByIdMutation('workers', 'worker:dispatch:0', {
        workerId: 'worker:dispatch:0',
        role: 'CODER',
        executor: 'harness',
        status: 'pending',
        sessionId: 'session:worker:dispatch:0',
        startedTs: 1,
      }),
      mergeByIdMutation('workers', 'worker:dispatch:1', {
        workerId: 'worker:dispatch:1',
        role: 'TESTER',
        executor: 'harness',
        status: 'pending',
        sessionId: 'session:worker:dispatch:1',
        startedTs: 1,
      }),
    ]);

    await expect(runOrchestration(state, { workerRuntime: runtime })).resolves.toMatchObject({
      phase: 'done',
    });
    expect(runParallel).toHaveBeenCalledOnce();
    expect(runParallel.mock.calls[0]?.[1].map((entry) => entry.workerId)).toEqual([
      'worker:dispatch:0',
      'worker:dispatch:1',
    ]);
    expect(runOne).not.toHaveBeenCalled();
  });

  it('runs the full CODER→TESTER loop, retries once on failure, and finalizes on pass', async () => {
    const deps = orchestrationWith(
      [coderRound(1), coderRound(2)],
      [testerRound(false), testerRound(true)],
    );
    const initial = createInitialAppState('lru-1', '实现带 TTL 的 LRU 缓存');

    const final = await runOrchestration(initial, deps);

    expect(final.phase).toBe('done');
    expect(final.iterationCount).toBe(1);
    expect(final.testResults?.passed).toBe(true);
    expect(final.subtasks[0]?.status).toBe('done');
    expect(final.nextRole).toBe('TESTER');
    expect(final.messages.filter((m) => m.type === 'announce')).toHaveLength(1);
    expect(final.messages.filter((m) => m.type === 'feedback')).toHaveLength(1);
    expect(final.messages.some((m) => m.msgId === 'coder-code-r1')).toBe(true);
    expect(final.messages.some((m) => m.msgId === 'coder-code-r2')).toBe(true);
  });

  it('treats the incoming state as immutable input (pure orchestration)', async () => {
    const deps = orchestrationWith([coderRound(1)], [testerRound(true)]);
    const initial = deepFreeze(createInitialAppState('lru-1', 'LRU 缓存'));

    const final = await runOrchestration(initial, deps);

    expect(initial.phase).toBe('clarifying');
    expect(initial.messages).toHaveLength(0);
    expect(initial.subtasks).toHaveLength(0);
    expect(final).not.toBe(initial);
    expect(final.phase).toBe('done');
  });

  it('writes shared state exclusively through applyMutations semantics (frozen input survives untouched)', async () => {
    // 直接赋值式写入会在严格模式对 frozen 对象抛 TypeError：
    // 全链路能在深度冻结的入参上跑完，即证明编排层零直接赋值、全部经合并函数。
    const deps = orchestrationWith(
      [coderRound(1), coderRound(2)],
      [testerRound(false), testerRound(true)],
    );
    const initial = deepFreeze(createInitialAppState('lru-1', 'LRU 缓存'));

    const final = await runOrchestration(initial, deps);

    expect(Object.isFrozen(initial)).toBe(true);
    expect(final.iterationCount).toBe(1);
    expect(final.phase).toBe('done');
  });

  it('routes entry, coordinator, and finalize mutations through the injected transition', async () => {
    const batches: string[][] = [];
    const deps = orchestrationWith([coderRound(1)], [testerRound(true)]);
    deps.transition = async (state, mutations) => {
      batches.push(mutations.map((mutation) => mutation.field));
      return applyMutations(state, mutations);
    };

    const final = await runOrchestration(
      createInitialAppState('lru-1', '实现带 TTL 的 LRU 缓存'),
      deps,
    );

    expect(batches[0]).toEqual(['complexity']);
    expect(batches.some((batch) => batch.includes('subtasks'))).toBe(true);
    expect(batches.at(-1)).toEqual(['phase']);
    expect(final.phase).toBe('done');
  });
});

describe('runOrchestration · human_gate escalation hook (task 2.3)', () => {
  function cappedTestingState(): AppState {
    return applyMutations(createInitialAppState('lru-1', 'LRU 缓存'), [
      mergeByIdMutation('subtasks', SUBTASK_ID, {
        title: 'LRU 缓存',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
      }),
      setMutation('phase', 'testing'),
      setMutation('nextRole', 'TESTER'),
      setMutation('iterationCount', MAX_ITERATIONS),
      setMutation('testResults', { passed: false, total: 2, failed: 1, failures: [] }),
    ]);
  }

  it('halts on a seeded capped state without running any worker and records the escalation', async () => {
    const deps = orchestrationWith([], []);
    const initial = deepFreeze(cappedTestingState());

    const final = await runOrchestration(initial, deps);

    expect(final.phase).toBe('testing');
    expect(final.humanGate).toEqual({
      gateId: expect.stringMatching(/^human-gate:/),
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'testing',
      openedTs: expect.any(Number),
      safePointRefs: [],
    });
    expect(final.iterationCount).toBe(MAX_ITERATIONS);
    const escalations = final.messages.filter((m) => m.type === 'escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.fromRole).toBe('COORDINATOR');
    expect(escalations[0]?.payload).toMatchObject({
      reason: 'iteration_limit',
      iterationCount: MAX_ITERATIONS,
      limit: MAX_ITERATIONS,
    });
  });

  it('survives the full capped CODER↔TESTER loop: exactly MAX loop-backs, then human_gate (no silent loop)', async () => {
    const deps = orchestrationWith(
      Array.from({ length: MAX_ITERATIONS + 1 }, () => coderRound(1)),
      Array.from({ length: MAX_ITERATIONS + 1 }, () => testerRound(false)),
    );
    const final = await runOrchestration(
      createInitialAppState('lru-1', '实现带 TTL 的 LRU 缓存'),
      deps,
    );

    expect(final.phase).toBe('testing');
    expect(final.iterationCount).toBe(MAX_ITERATIONS);
    expect(final.testResults?.passed).toBe(false);
    expect(final.humanGate?.reason).toBe('iteration_limit');
    expect(final.humanGate?.phase).toBe('testing');
    expect(final.messages.filter((m) => m.type === 'feedback')).toHaveLength(MAX_ITERATIONS);
    expect(final.messages.filter((m) => m.type === 'escalation')).toHaveLength(1);
  });
});

describe('entry · complexity evaluation (task 4.1, spec §3)', () => {
  it('evaluates and writes the complexity slice exactly once for a Tier 0 goal', () => {
    const entered = entry(createInitialAppState('lru-1', '实现带 TTL 的 LRU 缓存'));
    expect(entered.complexity?.tier).toBe(0);
    expect(entered.complexity?.signals.rule).toBe('tier0.single_entity');
  });

  it('preserves an already-set complexity untouched so replays stay idempotent', () => {
    const seeded = applyMutations(createInitialAppState('lru-1', 'g'), [
      setMutation('complexity', { tier: 2, signals: { rule: 'tier2.multi_module' } }),
    ]);
    const entered = entry(seeded);
    expect(entered).toBe(seeded);
    expect(entered.complexity).toEqual({ tier: 2, signals: { rule: 'tier2.multi_module' } });
  });

  it('touches nothing besides complexity (writes go through applyMutations only)', () => {
    const initial = createInitialAppState('lru-1', '实现带 TTL 的 LRU 缓存');
    const entered = entry(initial);
    const { complexity, ...rest } = entered;
    expect(complexity).toBeDefined();
    expect(rest).toEqual(initial);
  });
});
