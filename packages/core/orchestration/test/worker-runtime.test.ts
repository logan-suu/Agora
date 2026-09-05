import type { Message, Mutation } from '@agora/core-domain';
import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  PHASE0_ROSTER,
} from '@agora/core-domain';
import type { Executor, ProjectionView, StepResult } from '@agora/runtime-executor';
import { describe, expect, it } from 'vitest';
import {
  GlobalScheduler,
  ParallelBatchError,
  planObjectionMutations,
  WorkerRuntime,
} from '../src/index';

// Mock 原因（R11）：本文件用 FakeExecutor 隔离 Harness 执行器（0.5 才交付实现），
// 仅验证 WorkerRuntime 的步进归并/终止/角色装载等单元行为；
// 真实执行链路（Harness loop）的 G5 实测留待任务 0.5/0.6/0.7。
class FakeExecutor implements Executor {
  private readonly queue: StepResult[];
  public readonly stepCalls: StepContextLog[] = [];
  public readonly safePointCalls: string[] = [];

  constructor(steps: StepResult[]) {
    this.queue = [...steps];
  }

  async step(context: { sessionId: string; view: ProjectionView }): Promise<StepResult> {
    this.stepCalls.push({ sessionId: context.sessionId, view: context.view });
    const next = this.queue.shift();
    if (next === undefined) throw new Error('fake executor exhausted its scripted steps');
    return next;
  }

  async saveSafePoint(): Promise<string> {
    this.safePointCalls.push('cursor');
    return 'cursor';
  }

  async loadSafePoint(): Promise<void> {}

  injectInbox(): void {}
}

class GatedExecutor implements Executor {
  public readonly safePointCalls: string[] = [];
  public readonly stepStarted: Promise<void>;
  private markStepStarted = () => {};
  private releaseStep = () => {};
  private readonly stepGate = new Promise<void>((resolve) => {
    this.releaseStep = resolve;
  });

  constructor() {
    this.stepStarted = new Promise<void>((resolve) => {
      this.markStepStarted = resolve;
    });
  }

  async step(): Promise<StepResult> {
    this.markStepStarted();
    await this.stepGate;
    return stepOf('llm', [
      { field: 'messages', op: 'append', value: chatMessage('committed-before-drain') },
    ]);
  }

  release(): void {
    this.releaseStep();
  }

  async saveSafePoint(): Promise<string> {
    this.safePointCalls.push('safe-cursor');
    return 'safe-cursor';
  }

  async loadSafePoint(): Promise<void> {}

  injectInbox(): void {}
}

interface StepContextLog {
  sessionId: string;
  view: ProjectionView;
}

function chatMessage(msgId: string): Message {
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

function stepOf(kind: StepResult['kind'], mutations: StepResult['mutations']): StepResult {
  return { kind, output: {}, reachedSafeBoundary: true, mutations };
}

let workerSequence = 0;
function assignment(role: string): { workerId: string; role: string } {
  workerSequence += 1;
  return { workerId: `worker:test:${workerSequence}`, role };
}

function runtimeWith(fakes: FakeExecutor[]): WorkerRuntime {
  const pending = [...fakes];
  return new WorkerRuntime({
    roster: PHASE0_ROSTER,
    buildExecutor: () => {
      const next = pending.shift();
      if (next === undefined) throw new Error('no fake executor left for this assignment');
      return next;
    },
  });
}

describe('WorkerRuntime (Phase 0 degenerate single-worker path)', () => {
  it('derives fresh role-scoped ChannelContext before every worker step', async () => {
    const fake = new FakeExecutor([stepOf('llm', []), stepOf('done', [])]);
    let revision = 0;
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => fake,
      buildChannelContext: async (_state, role) => [
        { channelId: 'sub-a', role, revision: ++revision },
      ],
    });

    await runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));

    expect(fake.stepCalls.map((call) => call.view.slices.channels)).toEqual([
      [{ channelId: 'sub-a', role: 'CODER', revision: 1 }],
      [{ channelId: 'sub-a', role: 'CODER', revision: 2 }],
    ]);
  });

  it('honors a pause requested while asynchronous ChannelContext construction is pending', async () => {
    const fake = new FakeExecutor([]);
    let releaseContext = () => {};
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => fake,
      buildChannelContext: async () => {
        await contextGate;
        return [];
      },
    });

    const running = runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));
    await Promise.resolve();
    runtime.paused = true;
    releaseContext();

    await expect(running).resolves.toMatchObject({ taskId: 't-1' });
    expect(fake.stepCalls).toHaveLength(0);
    expect(fake.safePointCalls).toEqual(['cursor']);
  });

  it('honors a target drain requested while asynchronous ChannelContext construction is pending', async () => {
    const fake = new FakeExecutor([]);
    let releaseContext = () => {};
    let markContextStarted = () => {};
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => fake,
      buildChannelContext: async () => {
        markContextStarted();
        await contextGate;
        return [];
      },
    });

    const running = runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));
    await contextStarted;
    const draining = runtime.awaitRoleSafePoint('CODER');
    releaseContext();

    await expect(running).resolves.toMatchObject({ taskId: 't-1' });
    await expect(draining).resolves.toEqual({
      role: 'CODER',
      activeWorkers: 1,
      safePointRefs: ['cursor'],
    });
    expect(fake.stepCalls).toHaveLength(0);
    expect(fake.safePointCalls).toEqual(['cursor']);
  });

  it('merges every step mutation in order through applyMutations without mutating the input state', async () => {
    const fake = new FakeExecutor([
      stepOf('llm', [{ field: 'messages', op: 'append', value: chatMessage('m1') }]),
      stepOf('message', [{ field: 'messages', op: 'append', value: chatMessage('m2') }]),
      stepOf('done', [{ field: 'messages', op: 'append', value: chatMessage('m3') }]),
    ]);
    const runtime = runtimeWith([fake]);
    const input = createInitialAppState('t-1', 'g');

    const result = await runtime.runOne(input, assignment('CODER'));

    expect(result.messages.map((m) => m.msgId)).toEqual(['m1', 'm2', 'm3']);
    expect(input.messages).toEqual([]);
    expect(result).not.toBe(input);
    expect(fake.stepCalls).toHaveLength(3);
    for (const call of fake.stepCalls) {
      expect(call.sessionId).toBeTruthy();
    }
  });

  it('routes every worker step through the injected asynchronous state transition', async () => {
    const fake = new FakeExecutor([
      stepOf('llm', [{ field: 'messages', op: 'append', value: chatMessage('m1') }]),
      stepOf('done', [{ field: 'messages', op: 'append', value: chatMessage('m2') }]),
    ]);
    const transitions: readonly Mutation[][] = [];
    const mutableTransitions = transitions as Mutation[][];
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => fake,
      transition: async (state, mutations) => {
        mutableTransitions.push([...mutations]);
        return applyMutations(state, mutations);
      },
    });

    const result = await runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));

    const messageTransitions = transitions.filter((batch) => batch[0]?.field === 'messages');
    expect(messageTransitions).toHaveLength(2);
    expect(messageTransitions.map((batch) => batch[0]?.value)).toEqual([
      chatMessage('m1'),
      chatMessage('m2'),
    ]);
    expect(result.messages.map((entry) => entry.msgId)).toEqual(['m1', 'm2']);
  });

  it('handles structured step output before applying that step state transition', async () => {
    const fake = new FakeExecutor([
      {
        ...stepOf('done', [{ field: 'messages', op: 'append', value: chatMessage('m1') }]),
        output: { channelAction: { kind: 'close_sub_channel', channelId: 'sub-a' } },
      },
    ]);
    const order: string[] = [];
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => fake,
      handleOutput: async (_state, role, output) => {
        order.push(`output:${role}:${String('channelAction' in output)}`);
      },
      transition: async (state, mutations) => {
        order.push('transition');
        return applyMutations(state, mutations);
      },
    });

    await runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));

    expect(order.slice(-2)).toEqual(['output:CODER:true', 'transition']);
  });

  it('atomically combines a planned objection with its assistant message mutation', async () => {
    const message = {
      ...chatMessage('obj-1'),
      threadId: 'obj-1',
      fromRole: 'CODER',
      type: 'objection' as const,
      payload: {
        objection: {
          claim: 'contradiction',
          target: { kind: 'requirement', id: 'req-1' },
          argument: 'The implementation drops restart durability.',
        },
      },
    };
    const fake = new FakeExecutor([
      {
        ...stepOf('done', [appendMutation('messages', message)]),
        output: {
          objection: {
            id: 'obj-1',
            threadId: 'obj-1',
            claim: 'contradiction',
            target: { kind: 'requirement', id: 'req-1' },
            argument: 'The implementation drops restart durability.',
          },
        },
      },
    ]);
    const initial = applyMutations(createInitialAppState('t-1', 'g'), [
      mergeByIdMutation('requirements', 'req-1', {
        story: 'Persist tasks',
        acceptance: ['survives restart'],
        nonGoals: [],
      }),
    ]);
    const batches: string[][] = [];
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => fake,
      planOutput: planObjectionMutations,
      transition: async (state, mutations) => {
        batches.push(mutations.map((mutation) => mutation.field));
        return applyMutations(state, mutations);
      },
    });

    const result = await runtime.runOne(initial, assignment('CODER'));

    expect(batches.at(-1)).toEqual(['messages', 'objections', 'workers']);
    expect(result.messages).toContainEqual(message);
    expect(result.objections).toHaveLength(1);
    expect(result.objections[0]).toMatchObject({ id: 'obj-1', track: 'blocking' });
  });

  it('stops the loop exactly on a kind="done" step result', async () => {
    const fake = new FakeExecutor([stepOf('done', [])]);
    const runtime = runtimeWith([fake]);

    await runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));

    expect(fake.stepCalls).toHaveLength(1);
  });

  it('stops at the next step boundary when the assigned role becomes disabled', async () => {
    const fake = new FakeExecutor([stepOf('llm', [])]);
    let loads = 0;
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      loadRoster: async () => {
        loads += 1;
        return loads <= 5 ? PHASE0_ROSTER : PHASE0_ROSTER.filter((entry) => entry.role !== 'CODER');
      },
      buildExecutor: () => fake,
    });

    await runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));

    expect(fake.stepCalls).toHaveLength(1);
    expect(fake.safePointCalls).toEqual(['cursor']);
  });

  it('drains only the target role after its current step transition is committed', async () => {
    const fake = new GatedExecutor();
    const order: string[] = [];
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => fake,
      transition: async (state, mutations) => {
        order.push('transition');
        return applyMutations(state, mutations);
      },
    });

    const running = runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));
    await fake.stepStarted;

    let drainSettled = false;
    const draining = runtime.awaitRoleSafePoint('CODER').then((result) => {
      drainSettled = true;
      order.push('drained');
      return result;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    fake.release();

    const [result, drain] = await Promise.all([running, draining]);
    expect(result.messages.map((entry) => entry.msgId)).toEqual(['committed-before-drain']);
    expect(drain).toEqual({ role: 'CODER', activeWorkers: 1, safePointRefs: ['safe-cursor'] });
    expect(fake.safePointCalls).toEqual(['safe-cursor']);
    expect(order.at(-1)).toBe('drained');
    expect(order.slice(0, -1)).toEqual(['transition', 'transition', 'transition', 'transition']);
  });

  it('reports an immediate no-op drain when the target role has no active worker', async () => {
    const runtime = runtimeWith([]);

    await expect(runtime.awaitRoleSafePoint('TESTER')).resolves.toEqual({
      role: 'TESTER',
      activeWorkers: 0,
      safePointRefs: [],
    });
  });

  it('treats a naturally completed worker as quiescent without creating a late drain', async () => {
    const fake = new FakeExecutor([stepOf('done', [])]);
    const runtime = runtimeWith([fake]);

    await runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));

    await expect(runtime.awaitRoleSafePoint('CODER')).resolves.toEqual({
      role: 'CODER',
      activeWorkers: 0,
      safePointRefs: [],
    });
    expect(fake.safePointCalls).toHaveLength(0);
  });

  it('throws when the roster does not contain the requested role', async () => {
    const runtime = runtimeWith([new FakeExecutor([])]);

    await expect(
      runtime.runOne(createInitialAppState('t-1', 'g'), assignment('PM')),
    ).rejects.toThrow(/PM/);
  });

  it('reloads canonical state before dependency validation and before building an executor', async () => {
    const base = createInitialAppState('t-1', 'g');
    const stale = applyMutations(base, [
      mergeByIdMutation('subtasks', 'dependency', {
        title: 'dependency',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'done',
      }),
      mergeByIdMutation('subtasks', 'target', {
        title: 'target',
        ownerRole: 'CODER',
        dependsOn: ['dependency'],
        status: 'in_progress',
      }),
    ]);
    let canonical = applyMutations(base, [
      mergeByIdMutation('subtasks', 'dependency', {
        title: 'dependency',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'todo',
      }),
      mergeByIdMutation('subtasks', 'target', {
        title: 'target',
        ownerRole: 'CODER',
        dependsOn: ['dependency'],
        status: 'in_progress',
      }),
    ]);
    let executorBuilds = 0;
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      loadState: async () => canonical,
      transition: async (_state, mutations) => {
        canonical = applyMutations(canonical, mutations);
        return canonical;
      },
      buildExecutor: () => {
        executorBuilds += 1;
        return new FakeExecutor([stepOf('done', [])]);
      },
    });

    await expect(
      runtime.runOne(stale, {
        workerId: 'worker:canonical-dependency',
        role: 'CODER',
        subtaskId: 'target',
      }),
    ).rejects.toThrow(/unmet dependencies: dependency/);
    expect(executorBuilds).toBe(0);
  });

  it('runs the complete batch concurrently up to maxParallel without dropping the tail', async () => {
    const stats = { active: 0, max: 0, started: [] as string[] };
    const assignments = Array.from({ length: 5 }, (_, index) => ({
      workerId: `worker:batch:${index}`,
      role: 'CODER' as const,
      subtaskId: `s-${index}`,
    }));
    const seed = applyMutations(
      createInitialAppState('t-1', 'g'),
      assignments.map((assignment) =>
        mergeByIdMutation('subtasks', assignment.subtaskId, {
          title: assignment.subtaskId,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ),
    );
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        buildExecutor: (_spec, assignment) => ({
          async step(): Promise<StepResult> {
            stats.active += 1;
            stats.max = Math.max(stats.max, stats.active);
            stats.started.push(assignment.workerId);
            await Promise.resolve();
            stats.active -= 1;
            return stepOf('done', [
              {
                field: 'messages',
                op: 'append',
                value: { ...chatMessage(`message:${assignment.workerId}`), fromRole: 'CODER' },
              },
            ]);
          },
          async saveSafePoint(): Promise<string> {
            return assignment.workerId;
          },
          async loadSafePoint(): Promise<void> {},
          injectInbox(): void {},
        }),
      },
      new GlobalScheduler({ cap: 3 }),
      2,
    );

    const result = await runtime.runParallel(seed, assignments);

    expect(stats.max).toBe(2);
    expect(stats.started).toHaveLength(5);
    expect(new Set(stats.started)).toEqual(new Set(assignments.map((entry) => entry.workerId)));
    expect(result.messages).toHaveLength(5);
    expect(result.workers.map((worker) => worker.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
  });

  it('waits for an already-started sibling before returning an aggregate failure', async () => {
    let siblingStarted = false;
    let markSiblingStarted = (): void => {};
    let releaseSibling = (): void => {};
    const siblingStartedPromise = new Promise<void>((resolve) => {
      markSiblingStarted = resolve;
    });
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        buildExecutor: (_spec, assignment) => ({
          async step(): Promise<StepResult> {
            if (assignment.workerId === 'worker:failure:0') {
              await Promise.resolve();
              throw new Error('first worker failed');
            }
            siblingStarted = true;
            markSiblingStarted();
            await siblingGate;
            return stepOf('done', [
              {
                field: 'messages',
                op: 'append',
                value: chatMessage('sibling-committed'),
              },
            ]);
          },
          async saveSafePoint(): Promise<string> {
            return assignment.workerId;
          },
          async loadSafePoint(): Promise<void> {},
          injectInbox(): void {},
        }),
      },
      new GlobalScheduler({ cap: 2 }),
      2,
    );
    const assignments = [
      { workerId: 'worker:failure:0', role: 'CODER' as const, subtaskId: 's-0' },
      { workerId: 'worker:failure:1', role: 'CODER' as const, subtaskId: 's-1' },
      { workerId: 'worker:failure:2', role: 'CODER' as const, subtaskId: 's-2' },
    ] as const;
    const seed = applyMutations(
      createInitialAppState('t-1', 'g'),
      assignments.map((assignment) =>
        mergeByIdMutation('subtasks', assignment.subtaskId, {
          title: assignment.subtaskId,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ),
    );

    const running = runtime.runParallel(seed, assignments);
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await siblingStartedPromise;
    expect(siblingStarted).toBe(true);
    expect(settled).toBe(false);

    releaseSibling();
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ParallelBatchError);
    expect((error as ParallelBatchError).state.messages.map((message) => message.msgId)).toContain(
      'sibling-committed',
    );
    expect((error as ParallelBatchError).failures).toEqual([
      expect.objectContaining({ workerId: 'worker:failure:0', status: 'failed' }),
      {
        workerId: 'worker:failure:2',
        status: 'not_started_due_to_batch_failure',
        message: 'a sibling worker failed before this assignment acquired a slot',
      },
    ]);
  });

  it('fails fast on malformed batches before constructing an executor', async () => {
    let builds = 0;
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => {
        builds += 1;
        return new FakeExecutor([]);
      },
    });
    const state = applyMutations(createInitialAppState('t-1', 'g'), [
      mergeByIdMutation('subtasks', 's-0', {
        title: 's-0',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
      }),
    ]);

    await expect(runtime.runParallel(state, [])).rejects.toThrow(/non-empty/);
    await expect(
      runtime.runParallel(state, [
        { workerId: 'worker:duplicate', role: 'CODER', subtaskId: 's-0' },
        { workerId: 'worker:duplicate', role: 'CODER', subtaskId: 's-0' },
      ]),
    ).rejects.toThrow(/duplicate workerId/);
    await expect(
      runtime.runParallel(state, [
        { workerId: 'worker:same-subtask:0', role: 'CODER', subtaskId: 's-0' },
        { workerId: 'worker:same-subtask:1', role: 'CODER', subtaskId: 's-0' },
      ]),
    ).rejects.toThrow(/multiple workers/);
    await expect(
      runtime.runParallel(state, [
        { workerId: 'worker:no-subtask:0', role: 'CODER' },
        { workerId: 'worker:no-subtask:1', role: 'CODER' },
      ]),
    ).rejects.toThrow(/requires distinct subtaskId/);
    expect(builds).toBe(0);
  });

  it('rejects invalid local parallel limits before work can start', () => {
    const deps = { roster: PHASE0_ROSTER, buildExecutor: () => new FakeExecutor([]) };
    const scheduler = new GlobalScheduler({ cap: 2 });

    expect(() => new WorkerRuntime(deps, scheduler, 0)).toThrow(/positive integer/);
    expect(() => new WorkerRuntime(deps, scheduler, 1.5)).toThrow(/positive integer/);
    expect(() => new WorkerRuntime(deps, scheduler, 3)).toThrow(/cannot exceed/);
  });

  it('rejects a conflicting stable append identity instead of silently keeping the first value', async () => {
    const assignments = [
      { workerId: 'worker:collision:0', role: 'CODER' as const, subtaskId: 's-0' },
      { workerId: 'worker:collision:1', role: 'CODER' as const, subtaskId: 's-1' },
    ] as const;
    const seed = applyMutations(
      createInitialAppState('t-1', 'g'),
      assignments.map((entry) =>
        mergeByIdMutation('subtasks', entry.subtaskId, {
          title: entry.subtaskId,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ),
    );
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        buildExecutor: (_spec, entry) =>
          new FakeExecutor([
            stepOf('done', [
              {
                field: 'messages',
                op: 'append',
                value: {
                  ...chatMessage('shared-message-id'),
                  display: `written by ${entry.workerId}`,
                },
              },
            ]),
          ]),
      },
      new GlobalScheduler({ cap: 2 }),
      2,
    );

    const error = await runtime.runParallel(seed, assignments).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ParallelBatchError);
    expect((error as ParallelBatchError).state.messages).toHaveLength(1);
    expect((error as ParallelBatchError).failures).toEqual([
      expect.objectContaining({
        status: 'failed',
        message: expect.stringContaining('conflicts with canonical'),
      }),
    ]);
  });

  it.each([
    {
      name: 'global set',
      mutation: {
        field: 'testResults',
        op: 'set',
        value: { passed: true, total: 1, failed: 0, failures: [] },
      } satisfies Mutation,
      message: 'cannot submit set(testResults)',
    },
    {
      name: 'another subtask partition',
      mutation: mergeByIdMutation('subtasks', 's-1', { status: 'done' }),
      message: 'cannot merge subtasks/s-1',
    },
    {
      name: 'coordinator-owned requirement partition',
      mutation: mergeByIdMutation('requirements', 'req-1', {
        story: 'forbidden',
        acceptance: [],
        nonGoals: [],
      }),
      message: 'cannot merge requirements/req-1',
    },
  ])('rejects $name before it reaches the parallel commit', async ({ mutation, message }) => {
    const assignments = [
      { workerId: 'worker:boundary:0', role: 'CODER' as const, subtaskId: 's-0' },
      { workerId: 'worker:boundary:1', role: 'CODER' as const, subtaskId: 's-1' },
    ] as const;
    const seed = applyMutations(
      createInitialAppState('t-1', 'g'),
      assignments.map((entry) =>
        mergeByIdMutation('subtasks', entry.subtaskId, {
          title: entry.subtaskId,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ),
    );
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        buildExecutor: (_spec, entry) =>
          new FakeExecutor([stepOf('done', entry.workerId.endsWith(':0') ? [mutation] : [])]),
      },
      new GlobalScheduler({ cap: 2 }),
      2,
    );

    const error = await runtime.runParallel(seed, assignments).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ParallelBatchError);
    expect((error as ParallelBatchError).failures).toEqual([
      expect.objectContaining({
        workerId: 'worker:boundary:0',
        status: 'failed',
        message: expect.stringContaining(message),
      }),
    ]);
    expect((error as ParallelBatchError).state.testResults).toBeUndefined();
    expect((error as ParallelBatchError).state.requirements).toEqual([]);
    expect((error as ParallelBatchError).state.subtasks.map((entry) => entry.status)).toEqual([
      'in_progress',
      'in_progress',
    ]);
  });

  it('keeps paused false through the whole Phase 0 lifecycle and never saves safe points preemptively', async () => {
    const fake = new FakeExecutor([stepOf('llm', []), stepOf('done', [])]);
    const runtime = runtimeWith([fake]);

    expect(runtime.paused).toBe(false);
    await runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));

    expect(runtime.paused).toBe(false);
    expect(fake.safePointCalls).toHaveLength(0);
  });
});
