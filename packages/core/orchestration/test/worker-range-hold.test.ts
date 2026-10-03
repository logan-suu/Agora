// Executor decisions are gated doubles to test concurrency and failure ordering.
// Real Harness/file/process closure remains a separate G5 integration requirement.
import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  PHASE0_ROSTER,
} from '@agora/core-domain';
import { expect, it } from 'vitest';
import { GlobalScheduler } from '../src/global-scheduler';
import { WorkerRuntime } from '../src/worker-runtime';

function gated(doneAtBoundary = false) {
  let started = () => {};
  let release = () => {};
  const start = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  return {
    start,
    release: () => release(),
    executor: {
      async step() {
        calls++;
        if (calls === 1) {
          started();
          await gate;
        }
        return {
          kind: calls === 1 && !doneAtBoundary ? ('llm' as const) : ('done' as const),
          output: {},
          mutations: [],
          reachedSafeBoundary: true,
        };
      },
      async saveSafePoint() {
        return 'safe:range';
      },
      async loadSafePoint() {},
      injectInbox() {},
    },
  };
}

it('closes only selected workers at natural safe points and releases their leases while independent work continues', async () => {
  const first = gated(),
    independent = gated();
  let state = applyMutations(
    createInitialAppState('range-task', 'g'),
    ['one', 'two'].map((id) =>
      mergeByIdMutation('subtasks', id, {
        title: id,
        ownerRole: 'CODER',
        status: 'in_progress',
        dependsOn: [],
      }),
    ),
  );
  const scheduler = new GlobalScheduler({ cap: 2 });
  const closed: string[] = [];
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_old, mutations) => {
        state = applyMutations(state, mutations);
        return state;
      },
      buildExecutor: (_spec, assignment) =>
        assignment.workerId === 'one' ? first.executor : independent.executor,
      closeRangeExecutor: async (_executor, assignment) => {
        closed.push(assignment.workerId);
      },
    },
    scheduler,
  );
  const running = runtime.runParallel(state, [
    { workerId: 'one', role: 'CODER', subtaskId: 'one' },
    { workerId: 'two', role: 'CODER', subtaskId: 'two' },
  ]);
  await Promise.all([first.start, independent.start]);
  const request = {
    projectId: state.projectId,
    taskId: state.taskId,
    actionId: 'take',
    workerIds: ['one'],
  };
  const holding = runtime.holdRangeWorkers(request);
  expect(closed).toEqual([]);
  expect(scheduler.activeCount).toBe(2);
  expect(runtime.rangeActivity(request)).toMatchObject({
    activeWorkerIds: ['one', 'two'],
    leasedWorkerIds: ['one', 'two'],
  });
  first.release();
  const result = await holding;
  expect(result.workers[0]).toMatchObject({
    workerId: 'one',
    status: 'paused',
    safePointRef: 'safe:range',
    closed: true,
    leaseReleased: true,
  });
  expect(state.workers.find((w) => w.workerId === 'one')?.status).toBe('paused');
  expect(state.workers.find((w) => w.workerId === 'two')?.status).toBe('running');
  expect(scheduler.activeCount).toBe(1);
  expect(runtime.rangeActivity(request)).toMatchObject({
    activeWorkerIds: ['two'],
    leasedWorkerIds: ['two'],
  });
  expect(runtime.hasActivePause).toBe(false);
  expect(closed).toEqual(['one']);
  expect(await runtime.holdRangeWorkers(request)).toEqual(result);
  await expect(runtime.holdRangeWorkers({ ...request, workerIds: ['two'] })).rejects.toThrow(
    'range_hold_conflict',
  );
  independent.release();
  await running;
  expect(state.workers.find((w) => w.workerId === 'two')?.status).toBe('done');
  expect(scheduler.activeCount).toBe(0);
  expect(runtime.rangeActivity(request)).toMatchObject({
    activeWorkerIds: [],
    leasedWorkerIds: [],
    queuedWorkerIds: [],
  });
});

it('rechecks a queued assignment after acquiring a lease and keeps it pending when the persistent barrier appeared', async () => {
  let state = createInitialAppState('queued-range', 'g');
  const scheduler = new GlobalScheduler({ cap: 1 });
  const other = await scheduler.acquire('other-project', 'other-task', 'other-worker');
  let checks = 0;
  let built = false;
  let checked = () => {};
  const firstCheck = new Promise<void>((r) => {
    checked = r;
  });
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_old, mutations) => {
        state = applyMutations(state, mutations);
        return state;
      },
      rangeAdmission: {
        async canAcquire() {
          checks++;
          checked();
          return checks === 1;
        },
      },
      buildExecutor: () => {
        built = true;
        return gated().executor;
      },
    },
    scheduler,
  );
  const running = runtime.runOne(state, { workerId: 'queued', role: 'CODER' });
  await firstCheck;
  await scheduler.release(other);
  await running;
  expect(checks).toBe(2);
  expect(built).toBe(false);
  expect(state.workers.find((w) => w.workerId === 'queued')?.status).toBe('pending');
  expect(scheduler.activeCount).toBe(0);
});

it('defers completion tools and done qualification when the selected turn naturally finishes after a range hold', async () => {
  const current = gated(true);
  let state = createInitialAppState('range-completion', 'g');
  const scheduler = new GlobalScheduler();
  let completions = 0;
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_before, mutations) => {
        state = applyMutations(state, mutations);
        return state;
      },
      buildExecutor: () => current.executor,
      completeAssignment: async () => {
        completions++;
        return [];
      },
      closeRangeExecutor: async () => {},
    },
    scheduler,
  );
  const running = runtime.runOne(state, { workerId: 'one', role: 'CODER' });
  await current.start;
  const held = runtime.holdRangeWorkers({
    projectId: state.projectId,
    taskId: state.taskId,
    actionId: 'take',
    workerIds: ['one'],
  });
  current.release();
  expect((await held).workers[0]?.status).toBe('paused');
  await running;
  expect(completions).toBe(0);
  expect(state.workers.find((w) => w.workerId === 'one')?.status).toBe('paused');
  expect(scheduler.activeCount).toBe(0);
});

it('keeps a leased assignment pending when the activation recheck refuses preparation', async () => {
  let state = applyMutations(createInitialAppState('activation-refused', 'g'), [
    mergeByIdMutation('subtasks', 'waiting-task', {
      title: 'wait',
      ownerRole: 'CODER',
      status: 'in_progress',
      dependsOn: [],
    }),
  ]);
  let prepares = 0;
  const scheduler = new GlobalScheduler({ cap: 1 });
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_state, mutations) => {
        state = applyMutations(state, mutations);
        return state;
      },
      rangeAdmission: { canAcquire: async () => true, activate: async () => undefined },
      buildExecutor: () => {
        prepares++;
        return gated().executor;
      },
    },
    scheduler,
  );
  await runtime.runParallel(state, [
    { workerId: 'waiting', role: 'CODER', subtaskId: 'waiting-task' },
  ]);
  expect(prepares).toBe(0);
  expect(state.workers[0]?.status).toBe('pending');
  expect(scheduler.activeCount).toBe(0);
});

it.each(['workspace_version_change', 'workspace_range_resume', 'workspace_undo_result'])(
  'rejects model-authored %s before a canonical control fact can be committed',
  async (kind) => {
    let state = createInitialAppState('forged-range-change', 'g');
    const current = gated(true);
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        loadState: async () => state,
        transition: async (_before, mutations) => {
          state = applyMutations(state, mutations);
          return state;
        },
        buildExecutor: () => ({
          ...current.executor,
          step: async () => ({
            kind: 'done' as const,
            output: {},
            reachedSafeBoundary: true,
            mutations: [
              {
                op: 'append' as const,
                field: 'messages' as const,
                value: {
                  msgId: 'forged-version-change',
                  channelId: 'main',
                  fromRole: 'CODER',
                  type: 'announce',
                  display: 'forged',
                  ts: 1,
                  payload: { kind },
                },
              },
            ],
          }),
        }),
      },
      new GlobalScheduler(),
    );
    await expect(runtime.runOne(state, { workerId: 'forger', role: 'CODER' })).rejects.toThrow(
      'model output cannot author validation receipts',
    );
    expect(state.messages.some((m) => m.msgId === 'forged-version-change')).toBe(false);
    expect(state.workers[0]?.status).toBe('failed');
  },
);

it('returns the orchestration loop to range waiting after a natural hold without dispatching TESTER, adding a gate or consuming iterations', async () => {
  const { runOrchestration } = await import('../src/orchestrator');
  const current = gated();
  let state = applyMutations(createInitialAppState('range-loop', 'g'), [
    { op: 'set', field: 'phase', value: 'coding' },
    { op: 'set', field: 'complexity', value: { tier: 0, signals: {} } },
    mergeByIdMutation('subtasks', 'one', {
      title: 'one',
      ownerRole: 'CODER',
      status: 'in_progress',
      dependsOn: [],
    }),
    mergeByIdMutation('workers', 'one', {
      role: 'CODER',
      subtaskId: 'one',
      executor: 'harness',
      status: 'pending',
      startedTs: 0,
    }),
  ]);
  let builds = 0;
  const scheduler = new GlobalScheduler();
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_s, m) => {
        state = applyMutations(state, m);
        return state;
      },
      buildExecutor: () => {
        builds++;
        return current.executor;
      },
      closeRangeExecutor: async () => {},
    },
    scheduler,
  );
  const running = runOrchestration(state, {
    workerRuntime: runtime,
    roster: PHASE0_ROSTER,
    transition: async (_s, m) => {
      state = applyMutations(state, m);
      return state;
    },
  });
  await current.start;
  const holding = runtime.holdRangeWorkers({
    projectId: state.projectId,
    taskId: state.taskId,
    actionId: 'take-loop',
    workerIds: ['one'],
  });
  current.release();
  await holding;
  const result = await running;
  expect(result.phase).toBe('coding');
  expect(result.humanGate).toBeUndefined();
  expect(result.iterationCount).toBe(0);
  expect(result.workers).toHaveLength(1);
  expect(builds).toBe(1);
  expect(result.workers[0]?.status).toBe('paused');
  expect(scheduler.activeCount).toBe(0);
});

it('continues the existing independent batch and then waits without routing a held worker into validation', async () => {
  const { runOrchestration } = await import('../src/orchestrator');
  const first = gated(),
    independent = gated(true);
  let state = applyMutations(createInitialAppState('range-independent-loop', 'g'), [
    { op: 'set', field: 'phase', value: 'coding' },
    { op: 'set', field: 'complexity', value: { tier: 0, signals: {} } },
    ...['one', 'two'].flatMap((id) => [
      mergeByIdMutation('subtasks', id, {
        title: id,
        ownerRole: 'CODER',
        status: 'in_progress',
        dependsOn: [],
      }),
      mergeByIdMutation('workers', id, {
        role: 'CODER',
        subtaskId: id,
        executor: 'harness',
        status: 'pending',
        startedTs: 0,
      }),
    ]),
  ]);
  const scheduler = new GlobalScheduler({ cap: 2 }),
    built: string[] = [];
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_s, m) => {
        state = applyMutations(state, m);
        return state;
      },
      buildExecutor: (_r, a) => {
        built.push(a.workerId);
        return a.workerId === 'one' ? first.executor : independent.executor;
      },
      closeRangeExecutor: async () => {},
    },
    scheduler,
  );
  const running = runOrchestration(state, {
    workerRuntime: runtime,
    roster: PHASE0_ROSTER,
    transition: async (_s, m) => {
      state = applyMutations(state, m);
      return state;
    },
  });
  await Promise.all([first.start, independent.start]);
  const holding = runtime.holdRangeWorkers({
    projectId: state.projectId,
    taskId: state.taskId,
    actionId: 'take-independent',
    workerIds: ['one'],
  });
  first.release();
  await holding;
  expect(state.workers.find((w) => w.workerId === 'two')?.status).toBe('running');
  independent.release();
  const result = await running;
  expect(result.phase).toBe('coding');
  expect(result.humanGate).toBeUndefined();
  expect(result.iterationCount).toBe(0);
  expect(built).toEqual(['one', 'two']);
  expect(result.workers.find((w) => w.workerId === 'one')?.status).toBe('paused');
  expect(result.workers.find((w) => w.workerId === 'two')?.status).toBe('done');
  expect(scheduler.activeCount).toBe(0);
});

it('waits for a durable range barrier with no active cohort while retaining a queued pending assignment', async () => {
  const { runOrchestration } = await import('../src/orchestrator');
  const state = applyMutations(createInitialAppState('range-queued-loop', 'g'), [
    { op: 'set', field: 'phase', value: 'coding' },
    { op: 'set', field: 'complexity', value: { tier: 0, signals: {} } },
    mergeByIdMutation('subtasks', 'one', {
      title: 'one',
      ownerRole: 'CODER',
      status: 'in_progress',
      dependsOn: [],
    }),
    mergeByIdMutation('workers', 'one', {
      role: 'CODER',
      subtaskId: 'one',
      executor: 'harness',
      status: 'pending',
      startedTs: 0,
    }),
  ]);
  let built = false;
  const scheduler = new GlobalScheduler();
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      rangeAdmission: { isBlocked: async () => true, canAcquire: async () => false },
      buildExecutor: () => {
        built = true;
        return gated().executor;
      },
    },
    scheduler,
  );
  const result = await runOrchestration(state, { workerRuntime: runtime, roster: PHASE0_ROSTER });
  expect(result).toEqual(state);
  expect(built).toBe(false);
  expect(scheduler.activeCount).toBe(0);
});

it('registers a trusted range Fork without execution and takes a fresh lease only for its first admitted run', async () => {
  let state = applyMutations(createInitialAppState('range-fork', 'g'), [
    mergeByIdMutation('workers', 'one', {
      workerId: 'one',
      role: 'CODER',
      executor: 'harness',
      status: 'paused',
      sessionId: 'parent',
      safePoint: 'safe:parent',
      startedTs: 1,
    }),
  ]);
  const scheduler = new GlobalScheduler({ cap: 1 });
  let builds = 0,
    verifies = 0;
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_old, mutations) => {
        state = applyMutations(state, mutations);
        return state;
      },
      rangeAdmission: { canAcquire: async () => true },
      buildExecutor: () => {
        builds++;
        expect(scheduler.activeCount).toBe(1);
        return {
          ...gated().executor,
          step: async () => ({
            kind: 'done',
            output: {},
            mutations: [],
            reachedSafeBoundary: true,
          }),
        };
      },
    },
    scheduler,
  );
  const permit = {
    projectId: state.projectId,
    taskId: state.taskId,
    actionId: 'take',
    workers: [
      {
        workerId: 'one',
        sourceSessionId: 'parent',
        sourceSafePointRef: 'safe:parent',
        resumeSessionId: 'child',
      },
    ],
  };
  await runtime.registerRangeResumes(permit, async () => {
    verifies++;
  });
  expect(state.workers[0]?.status).toBe('paused');
  expect(builds).toBe(0);
  expect(scheduler.activeCount).toBe(0);
  const after = await runtime.runOne(state, { workerId: 'one', role: 'CODER' });
  expect(after.workers[0]).toMatchObject({ status: 'done', sessionId: 'child' });
  expect(verifies).toBeGreaterThanOrEqual(3);
  expect(builds).toBe(1);
  expect(scheduler.activeCount).toBe(0);
  await expect(runtime.registerRangeResumes(permit, async () => {})).rejects.toThrow(
    'range_resume_conflict',
  );
});

it('keeps range recovery paused when verification fails after a queued new lease and never bypasses a human gate', async () => {
  let state = applyMutations(createInitialAppState('range-fork-refused', 'g'), [
    mergeByIdMutation('workers', 'one', {
      workerId: 'one',
      role: 'CODER',
      executor: 'harness',
      status: 'paused',
      sessionId: 'parent',
      safePoint: 'safe:parent',
      startedTs: 1,
    }),
  ]);
  const scheduler = new GlobalScheduler({ cap: 1 });
  let verifies = 0;
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      rangeAdmission: { canAcquire: async () => true },
      buildExecutor: () => {
        throw Error('must not build');
      },
    },
    scheduler,
  );
  const permit = {
    projectId: state.projectId,
    taskId: state.taskId,
    actionId: 'take',
    workers: [
      {
        workerId: 'one',
        sourceSessionId: 'parent',
        sourceSafePointRef: 'safe:parent',
        resumeSessionId: 'child',
      },
    ],
  };
  await runtime.registerRangeResumes(permit, async () => {
    if (++verifies === 3) throw Error('grant_revoked');
  });
  await expect(runtime.runOne(state, { workerId: 'one', role: 'CODER' })).rejects.toThrow(
    'grant_revoked',
  );
  expect(state.workers[0]?.status).toBe('paused');
  expect(scheduler.activeCount).toBe(0);
  state = applyMutations(state, [
    {
      op: 'set',
      field: 'humanGate',
      value: {
        gateId: 'gate',
        reason: 'iteration_limit',
        options: ['continue'],
        safePointRefs: [],
        openedTs: 1,
        phase: 'coding',
      },
    },
  ]);
  await expect(
    runtime.registerRangeResumes({ ...permit, actionId: 'other' }, async () => {}),
  ).rejects.toThrow('range_resume_conflict');
});

it('removes a range-blocked pending worker from the global queue before writer closure', async () => {
  let state = createInitialAppState('review-queued-range', 'g');
  let blocked = false;
  const scheduler = new GlobalScheduler({ cap: 1 });
  const other = await scheduler.acquire('other-project', 'other-task', 'other-worker');
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_old, mutations) => {
        state = applyMutations(state, mutations);
        return state;
      },
      rangeAdmission: { canAcquire: async () => !blocked, isBlocked: async () => blocked },
      closeRangeExecutor: async () => {},
      buildExecutor: () => {
        throw Error('must_not_build');
      },
    },
    scheduler,
  );
  const running = runtime.runOne(state, { workerId: 'queued', role: 'CODER' });
  try {
    for (let i = 0; i < 100 && !runtime.rangeActivity(state).queuedWorkerIds.length; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.rangeActivity(state).queuedWorkerIds).toEqual(['queued']);
    blocked = true;
    // deriveLocalRangeTargets excludes pending workers from the running cohort.
    await runtime.settleRangeQueue(state);
    expect(state.workers[0]?.status).toBe('pending');
    expect(runtime.rangeActivity(state).queuedWorkerIds).toEqual([]);
  } finally {
    await scheduler.release(other);
    await running;
    expect(scheduler.activeCount).toBe(0);
  }
});

it('settles a barrier arriving during the first admission read before a scheduler request exists', async () => {
  let state = createInitialAppState('range-before-queue', 'g');
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const scheduler = new GlobalScheduler({ cap: 1 });
  const other = await scheduler.acquire('other-project', 'other-task', 'other-worker');
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_old, mutations) => {
        state = applyMutations(state, mutations);
        return state;
      },
      rangeAdmission: {
        async canAcquire() {
          if (++reads === 1) {
            await gate;
            return true;
          }
          return false;
        },
      },
      buildExecutor: () => {
        throw Error('must_not_build');
      },
    },
    scheduler,
  );
  const running = runtime.runOne(state, { workerId: 'queued', role: 'CODER' });
  try {
    await expect.poll(() => reads).toBe(1);
    const settled = runtime.settleRangeQueue(state);
    await expect.poll(() => reads).toBe(2);
    release();
    await settled;
    await running;
    expect(runtime.rangeActivity(state).queuedWorkerIds).toEqual([]);
    expect(state.workers[0]?.status).toBe('pending');
    expect(scheduler.activeCount).toBe(1);
  } finally {
    release();
    await scheduler.release(other);
    await running;
  }
});

it.each([1, 2])(
  'cancels only the blocked pending admission with cap %i and preserves independent batch work',
  async (cap) => {
    let state = applyMutations(
      createInitialAppState('range-independent-queue', 'g'),
      ['one', 'two'].map((id) =>
        mergeByIdMutation('subtasks', id, {
          title: id,
          ownerRole: 'CODER',
          status: 'in_progress',
          dependsOn: [],
        }),
      ),
    );
    let blocked = false;
    const independent = gated(true);
    independent.release();
    const scheduler = new GlobalScheduler({ cap });
    const others = await Promise.all(
      Array.from({ length: cap }, (_, i) =>
        scheduler.acquire('other-project', 'other-task', `other-${i}`),
      ),
    );
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        loadState: async () => state,
        transition: async (_old, mutations) => {
          state = applyMutations(state, mutations);
          return state;
        },
        rangeAdmission: { canAcquire: async (scope) => !blocked || scope.workerId === 'two' },
        buildExecutor: (_spec, assignment) => {
          if (assignment.workerId !== 'two') throw Error('blocked_worker_must_not_build');
          return independent.executor;
        },
      },
      scheduler,
    );
    const running = runtime.runParallel(state, [
      { workerId: 'one', role: 'CODER', subtaskId: 'one' },
      { workerId: 'two', role: 'CODER', subtaskId: 'two' },
    ]);
    try {
      await expect
        .poll(() => runtime.rangeActivity(state).queuedWorkerIds)
        .toEqual(cap === 1 ? ['one'] : ['one', 'two']);
      blocked = true;
      await runtime.settleRangeQueue(state);
      await expect.poll(() => runtime.rangeActivity(state).queuedWorkerIds).toEqual(['two']);
      expect(state.workers.find((w) => w.workerId === 'one')?.status).toBe('pending');
    } finally {
      for (const lease of others) await scheduler.release(lease);
      await running;
    }
    expect(state.workers.find((w) => w.workerId === 'two')?.status).toBe('done');
    expect(scheduler.activeCount).toBe(0);
  },
);
