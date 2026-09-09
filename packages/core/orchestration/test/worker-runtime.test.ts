import type { Message, Mutation } from '@agora/core-domain';
import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  isWorktreeRef,
  mergeByIdMutation,
  PHASE0_ROSTER,
} from '@agora/core-domain';
import type { Executor, ProjectionView, StepResult } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { WorktreeRegistry } from '@agora/tools-fs';
import { initializeRegisteredWorktree, WorktreeGitService } from '@agora/tools-git';
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

  constructor(private readonly resultKind: StepResult['kind'] = 'llm') {
    this.stepStarted = new Promise<void>((resolve) => {
      this.markStepStarted = resolve;
    });
  }

  async step(): Promise<StepResult> {
    this.markStepStarted();
    await this.stepGate;
    return stepOf(this.resultKind, [
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

class ReprojectingExecutor implements Executor {
  readonly stepStarted: Promise<void>;
  readonly injected: ProjectionView[] = [];
  readonly safePointCalls: string[] = [];
  private markStepStarted = () => {};
  private releaseStep = () => {};
  private readonly stepGate = new Promise<void>((resolve) => {
    this.releaseStep = resolve;
  });
  private calls = 0;

  constructor() {
    this.stepStarted = new Promise<void>((resolve) => {
      this.markStepStarted = resolve;
    });
  }

  async step(): Promise<StepResult> {
    this.calls += 1;
    if (this.calls === 1) {
      this.markStepStarted();
      await this.stepGate;
      return stepOf('llm', [
        { field: 'messages', op: 'append', value: chatMessage('step-before-pause') },
      ]);
    }
    return stepOf('done', []);
  }

  release(): void {
    this.releaseStep();
  }

  async saveSafePoint(): Promise<string> {
    this.safePointCalls.push('safe:reproject');
    return 'safe:reproject';
  }

  async loadSafePoint(): Promise<void> {}

  injectInbox(view: ProjectionView): void {
    this.injected.push(view);
  }
}

class FailingSafePointExecutor extends ReprojectingExecutor {
  override async saveSafePoint(): Promise<string> {
    throw new Error('injected safe-point failure');
  }
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
    const fake = new FakeExecutor([stepOf('done', [])]);
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
    const paused = runtime.requestPause({
      scope: { projectId: 'default', taskId: 't-1' },
      actionId: 'change-context',
      reason: 'requirement_change',
      mode: 'reproject',
    });
    releaseContext();

    const receipt = await paused;
    expect(fake.stepCalls).toHaveLength(0);
    expect(fake.safePointCalls).toEqual(['cursor']);
    await runtime.completePause(receipt);
    await expect(running).resolves.toMatchObject({ taskId: 't-1' });
  });

  it('commits the current Step before checkpoint and keeps its lease across reproject', async () => {
    const executor = new ReprojectingExecutor();
    const scheduler = new GlobalScheduler({ cap: 1 });
    let canonical = createInitialAppState('t-1', 'g');
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        loadState: async () => canonical,
        transition: async (_state, mutations) => {
          canonical = applyMutations(canonical, mutations);
          return canonical;
        },
        buildExecutor: () => executor,
      },
      scheduler,
    );
    const running = runtime.runOne(canonical, assignment('CODER'));
    await executor.stepStarted;
    const paused = runtime.requestPause({
      scope: { projectId: canonical.projectId, taskId: canonical.taskId },
      actionId: 'change-1',
      reason: 'priority_change',
      mode: 'reproject',
    });
    executor.release();

    const receipt = await paused;
    expect(canonical.messages.map((message) => message.msgId)).toContain('step-before-pause');
    expect(canonical.workers[0]).toMatchObject({ status: 'paused', safePoint: 'safe:reproject' });
    expect(scheduler.activeCount).toBe(1);

    await runtime.completePause(receipt);
    await running;
    expect(executor.injected).toHaveLength(1);
    expect(canonical.workers[0]?.status).toBe('done');
    expect(scheduler.activeCount).toBe(0);
  });

  it('releases active leases and leaves undispatched workers pending for a human gate', async () => {
    const assignments = [
      { workerId: 'worker:gate:0', role: 'CODER' as const, subtaskId: 's-0' },
      { workerId: 'worker:gate:1', role: 'CODER' as const, subtaskId: 's-1' },
    ] as const;
    let canonical = applyMutations(
      createInitialAppState('t-gate', 'g'),
      assignments.map((entry) =>
        mergeByIdMutation('subtasks', entry.subtaskId, {
          title: entry.subtaskId,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ),
    );
    const executor = new GatedExecutor();
    const scheduler = new GlobalScheduler({ cap: 1 });
    let builds = 0;
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        loadState: async () => canonical,
        transition: async (_state, mutations) => {
          canonical = applyMutations(canonical, mutations);
          return canonical;
        },
        buildExecutor: () => {
          builds += 1;
          return builds === 1 ? executor : new FakeExecutor([stepOf('done', [])]);
        },
      },
      scheduler,
    );
    const running = runtime.runParallel(canonical, assignments);
    await executor.stepStarted;
    const paused = runtime.requestPause({
      scope: { projectId: canonical.projectId, taskId: canonical.taskId },
      actionId: 'gate-1',
      reason: 'iteration_limit',
      mode: 'human_gate',
    });
    executor.release();

    const receipt = await paused;
    expect(receipt.cohort).toEqual(['worker:gate:0']);
    expect(canonical.messages.map((message) => message.msgId)).toContain('committed-before-drain');
    expect(canonical.workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workerId: 'worker:gate:0', status: 'paused' }),
        expect.objectContaining({ workerId: 'worker:gate:1', status: 'pending' }),
      ]),
    );
    expect(scheduler.activeCount).toBe(1);

    await runtime.completePause(receipt);
    await expect(running).resolves.toMatchObject({ taskId: 't-gate' });
    expect(scheduler.activeCount).toBe(0);
    expect(builds).toBe(1);
  });

  it('does not install a pause epoch when its scope mismatches an active worker', async () => {
    const executor = new GatedExecutor('done');
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => executor,
    });
    const running = runtime.runOne(createInitialAppState('t-scope', 'g'), assignment('CODER'));
    await executor.stepStarted;

    await expect(
      runtime.requestPause({
        scope: { projectId: 'other-project', taskId: 't-scope' },
        actionId: 'wrong-scope',
        reason: 'requirement_change',
        mode: 'reproject',
      }),
    ).rejects.toThrow('pause scope does not match');
    expect(runtime.hasActivePause).toBe(false);

    executor.release();
    await expect(running).resolves.toMatchObject({ taskId: 't-scope' });
  });

  it('cleans up remaining paused workers when one cohort checkpoint fails', async () => {
    const failing = new FailingSafePointExecutor();
    const survivor = new ReprojectingExecutor();
    const assignments = [
      { workerId: 'worker:barrier:0', role: 'CODER' as const, subtaskId: 's-0' },
      { workerId: 'worker:barrier:1', role: 'CODER' as const, subtaskId: 's-1' },
    ];
    let canonical = applyMutations(
      createInitialAppState('t-barrier', 'g'),
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
        loadState: async () => canonical,
        transition: async (_state, mutations) => {
          canonical = applyMutations(canonical, mutations);
          return canonical;
        },
        buildExecutor: (_spec, assign) =>
          assign.workerId === 'worker:barrier:0' ? failing : survivor,
      },
      new GlobalScheduler({ cap: 2 }),
      2,
    );
    const running = runtime.runParallel(canonical, assignments);
    await Promise.all([failing.stepStarted, survivor.stepStarted]);
    const barrier = runtime.requestPause({
      scope: { projectId: canonical.projectId, taskId: canonical.taskId },
      actionId: 'failing-barrier',
      reason: 'requirement_change',
      mode: 'reproject',
    });
    failing.release();
    survivor.release();

    await expect(barrier).rejects.toThrow('injected safe-point failure');
    await expect(
      Promise.race([
        running.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
      ]),
    ).resolves.toBe('settled');
    expect(runtime.hasActivePause).toBe(false);
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

  it('preserves done when a drain is requested during a completing step', async () => {
    const fake = new GatedExecutor('done');
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => fake,
    });

    const running = runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));
    await fake.stepStarted;
    const draining = runtime.awaitRoleSafePoint('CODER');
    fake.release();

    const [result, drain] = await Promise.all([running, draining]);
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0]?.status).toBe('done');
    expect(drain).toEqual({ role: 'CODER', activeWorkers: 1, safePointRefs: ['safe-cursor'] });
    expect(fake.safePointCalls).toEqual(['safe-cursor']);
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

  it.each([
    { status: 'blocked' as const, ownerRole: 'CODER' },
    { status: 'done' as const, ownerRole: 'CODER' },
  ])(
    'rejects a $status subtask owned by $ownerRole before constructing an executor',
    async ({ status, ownerRole }) => {
      const state = applyMutations(createInitialAppState('t-1', 'g'), [
        mergeByIdMutation('subtasks', 'target', {
          title: 'target',
          ownerRole,
          dependsOn: [],
          status,
        }),
      ]);
      let builds = 0;
      const runtime = new WorkerRuntime({
        roster: PHASE0_ROSTER,
        buildExecutor: () => {
          builds += 1;
          return new FakeExecutor([stepOf('done', [])]);
        },
      });

      await expect(
        runtime.runOne(state, {
          workerId: `worker:invalid-subtask:${status}:${ownerRole}`,
          role: 'CODER',
          subtaskId: 'target',
        }),
      ).rejects.toThrow('is not executable');
      expect(builds).toBe(0);
    },
  );

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

  it.each(['provider', 'head_refresh', 'head_commit'] as const)(
    'classifies a %s failure after a real worker Git commit without losing recovery identity',
    async (failurePoint) => {
      // Only the provider failure is injected; worktree writes and Git commits are real.
      const sandbox = new LocalTempSandbox();
      const taskId = `failed-worker-head-${failurePoint}`;
      const worktree = await sandbox.createWorktree(taskId, 'CODER');
      const registry = new WorktreeRegistry();
      const git = new WorktreeGitService(registry);
      try {
        await initializeRegisteredWorktree(registry, worktree.path);
        const baseCommit = await git.headOf(worktree.path);
        const ref = {
          ...worktree,
          branch: await git.branchOf(worktree.path),
          baseCommit,
          headCommit: baseCommit,
        };
        let canonical = applyMutations(createInitialAppState(taskId, 'Implement A'), [
          mergeByIdMutation('subtasks', 'A', {
            title: 'Implement A',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress',
          }),
        ]);
        const runtime = new WorkerRuntime({
          roster: PHASE0_ROSTER,
          loadState: async () => canonical,
          transition: async (_state, mutations) => {
            if (
              failurePoint === 'head_commit' &&
              mutations.some(
                (mutation) =>
                  mutation.op === 'mergeById' &&
                  mutation.field === 'workers' &&
                  'worktree' in mutation.value &&
                  isWorktreeRef(mutation.value.worktree) &&
                  mutation.value.worktree.headCommit !== baseCommit,
              )
            )
              throw new Error('failed to persist refreshed HEAD');
            canonical = applyMutations(canonical, mutations);
            return canonical;
          },
          resolveWorktree: async () => ref,
          refreshWorktree: async (assigned) => {
            if (failurePoint === 'head_refresh') throw new Error('failed to inspect worker HEAD');
            return { ...assigned, headCommit: await git.headOf(assigned.path) };
          },
          buildExecutor: () => ({
            async step() {
              await sandbox.write(ref, 'business.mjs', 'export const answer = 42;\n');
              await git.applyPatch(ref.path, '');
              throw new Error('provider failed after git_applyPatch');
            },
            async saveSafePoint() {
              return 'unused';
            },
            async loadSafePoint() {},
            injectInbox() {},
          }),
        });
        const error = await runtime
          .runParallel(canonical, [{ workerId: 'worker:failed:0', role: 'CODER', subtaskId: 'A' }])
          .catch((caught: unknown) => caught);
        if (!(error instanceof ParallelBatchError)) throw new Error('expected batch failure');
        // A provider/unknown exception is not explicit TESTER or REVIEWER rework.
        expect(error.retryable).toBe(false);
        expect(error.state.workers[0]?.status).toBe('failed');
        const actualHead = await git.headOf(ref.path);
        expect(actualHead).not.toBe(baseCommit);
        if (failurePoint === 'provider') {
          expect(error.state.workers[0]?.worktree).toMatchObject({ headCommit: actualHead });
          expect(error.state.subtasks[0]?.worktree).toMatchObject({ headCommit: actualHead });
          expect(canonical.workers[0]?.worktree).toEqual(error.state.workers[0]?.worktree);
        }
      } finally {
        await git.dispose();
        await sandbox.teardown(taskId);
      }
    },
  );

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

  it('rejects a persisted external executor assignment in Phase 9', async () => {
    const assignment = {
      workerId: 'worker:external-assignment',
      role: 'CODER' as const,
      subtaskId: 's-0',
    };
    const state = applyMutations(createInitialAppState('t-1', 'g'), [
      mergeByIdMutation('subtasks', assignment.subtaskId, {
        title: 's-0',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
      }),
      mergeByIdMutation('workers', assignment.workerId, {
        workerId: assignment.workerId,
        role: assignment.role,
        executor: 'external',
        status: 'pending',
        subtaskId: assignment.subtaskId,
        startedTs: 1,
      }),
    ]);
    let builds = 0;
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => {
        builds += 1;
        return new FakeExecutor([stepOf('done', [])]);
      },
    });

    await expect(runtime.runOne(state, assignment)).rejects.toThrow(/executor conflicts/);
    expect(builds).toBe(0);
  });

  it('restarts a paused worker only when its workerId is declared by the resume receipt', async () => {
    const entry = {
      workerId: 'worker:resume:0',
      role: 'CODER' as const,
      subtaskId: 's-0',
    };
    const paused = applyMutations(createInitialAppState('t-1', 'g'), [
      mergeByIdMutation('subtasks', entry.subtaskId, {
        title: 's-0',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
      }),
      mergeByIdMutation('workers', entry.workerId, {
        workerId: entry.workerId,
        role: entry.role,
        executor: 'harness',
        status: 'paused',
        subtaskId: entry.subtaskId,
        safePoint: 'safe:resume',
        startedTs: 1,
      }),
    ]);
    const denied = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      buildExecutor: () => new FakeExecutor([stepOf('done', [])]),
    });
    await expect(denied.runOne(paused, entry)).rejects.toThrow('cannot start from status "paused"');

    const resumedExecutor = new FakeExecutor([stepOf('done', [])]);
    const allowed = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      resumingWorkers: [
        {
          workerId: entry.workerId,
          resumeSessionId: 'human-gate-resume:resolve-1:worker:resume:0',
        },
      ],
      buildExecutor: () => resumedExecutor,
    });
    await expect(allowed.runOne(paused, entry)).resolves.toMatchObject({
      workers: [
        expect.objectContaining({
          workerId: entry.workerId,
          status: 'done',
          sessionId: 'human-gate-resume:resolve-1:worker:resume:0',
        }),
      ],
    });
    expect(resumedExecutor.stepCalls[0]?.sessionId).toBe(
      'human-gate-resume:resolve-1:worker:resume:0',
    );
  });

  it('revalidates the canonical worker handle before executing a model step', async () => {
    const assignment = {
      workerId: 'worker:stale-before-step',
      role: 'CODER' as const,
      subtaskId: 's-0',
    };
    let canonical = applyMutations(createInitialAppState('t-1', 'g'), [
      mergeByIdMutation('subtasks', assignment.subtaskId, {
        title: 's-0',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
      }),
    ]);
    const executor = new FakeExecutor([stepOf('done', [])]);
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      loadState: async () => canonical,
      transition: async (_state, mutations) => {
        canonical = applyMutations(canonical, mutations);
        return canonical;
      },
      buildExecutor: () => {
        canonical = applyMutations(canonical, [
          mergeByIdMutation('workers', assignment.workerId, { status: 'failed' }),
        ]);
        return executor;
      },
    });

    await expect(runtime.runOne(canonical, assignment)).rejects.toThrow(/no longer a valid/);
    expect(executor.stepCalls).toHaveLength(0);
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
      name: 'model-authored worker assignment partition',
      mutation: mergeByIdMutation('workers', 'worker:boundary:0', { role: 'REVIEWER' }),
      message: 'cannot merge workers/worker:boundary:0',
    },
    {
      name: 'own subtask control-plane partition',
      mutation: mergeByIdMutation('subtasks', 's-0', { status: 'done' }),
      message: 'cannot merge subtasks/s-0',
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

  it('never saves safe points preemptively during an uninterrupted lifecycle', async () => {
    const fake = new FakeExecutor([stepOf('llm', []), stepOf('done', [])]);
    const runtime = runtimeWith([fake]);

    await runtime.runOne(createInitialAppState('t-1', 'g'), assignment('CODER'));

    expect(fake.safePointCalls).toHaveLength(0);
  });

  it('binds a workerId worktree before execution and persists its submitted HEAD on completion', async () => {
    const assigned = { workerId: 'worker:workspace:0', role: 'CODER' as const, subtaskId: 's-0' };
    const seed = applyMutations(createInitialAppState('t-1', 'g'), [
      mergeByIdMutation('subtasks', 's-0', {
        title: 'workspace',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
      }),
    ]);
    const allocated = {
      path: '/data/task/worktrees/worker-0',
      branch: 'worker-0',
      baseCommit: 'a'.repeat(40),
    };
    const submitted = { ...allocated, headCommit: 'b'.repeat(40) };
    let executorWorktree: typeof allocated | undefined;
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      resolveWorktree: async () => allocated,
      refreshWorktree: async () => submitted,
      buildExecutor: (_spec, _assignment, worktree) => {
        executorWorktree = worktree;
        return new FakeExecutor([stepOf('done', [])]);
      },
    });

    const result = await runtime.runOne(seed, assigned);

    expect(executorWorktree).toEqual(allocated);
    expect(result.workers[0]?.worktree).toEqual(submitted);
    expect(result.subtasks[0]?.worktree).toEqual(submitted);
  });

  it('accepts an equivalent persisted worktree regardless of object key insertion order', async () => {
    const assigned = {
      workerId: 'worker:workspace:order',
      role: 'CODER' as const,
      subtaskId: 's-0',
    };
    const persisted = {
      branch: 'worker-order',
      path: '/data/task/worktrees/worker-order',
      baseCommit: 'a'.repeat(40),
    };
    const resolved = {
      path: persisted.path,
      branch: persisted.branch,
      baseCommit: persisted.baseCommit,
    };
    const seed = applyMutations(createInitialAppState('t-1', 'g'), [
      mergeByIdMutation('subtasks', 's-0', {
        title: 'workspace',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
        worktree: persisted,
      }),
    ]);
    const runtime = new WorkerRuntime({
      roster: PHASE0_ROSTER,
      resolveWorktree: async () => resolved,
      buildExecutor: () => new FakeExecutor([stepOf('done', [])]),
    });

    await expect(runtime.runOne(seed, assigned)).resolves.toBeDefined();
  });
});

it('cancels the executor pause request on abort without injecting an uncommitted directive', async () => {
  class CancelableExecutor extends ReprojectingExecutor {
    pendingRequest = false;
    requestSafePoint() {
      this.pendingRequest = true;
    }
    cancelSafePoint() {
      this.pendingRequest = false;
    }
  }
  const executor = new CancelableExecutor();
  let canonical = createInitialAppState('abort-pause', 'g');
  const scheduler = new GlobalScheduler();
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => canonical,
      transition: async (state, mutations) => {
        canonical = applyMutations(state, mutations);
        return canonical;
      },
      buildExecutor: () => executor,
    },
    scheduler,
  );
  const running = runtime.runOne(canonical, assignment('CODER'));
  await executor.stepStarted;
  const pausing = runtime.requestPause({
    scope: { projectId: canonical.projectId, taskId: canonical.taskId },
    actionId: 'aborted',
    reason: 'decision_change',
    mode: 'reproject',
  });
  executor.release();
  const receipt = await pausing;
  expect(executor.pendingRequest).toBe(true);
  await runtime.abortPause(receipt);
  await running;
  expect(executor.pendingRequest).toBe(false);
  expect(executor.injected).toEqual([]);
  expect(canonical.workers[0]?.status).toBe('done');
  expect(scheduler.activeCount).toBe(0);
});
