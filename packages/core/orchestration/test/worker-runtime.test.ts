import type { Message, Mutation } from '@agora/core-domain';
import { applyMutations, createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import type { Executor, ProjectionView, StepResult } from '@agora/runtime-executor';
import { describe, expect, it } from 'vitest';
import { WorkerRuntime } from '../src/index';

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

    await runtime.runOne(createInitialAppState('t-1', 'g'), { role: 'CODER' });

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

    const running = runtime.runOne(createInitialAppState('t-1', 'g'), { role: 'CODER' });
    await Promise.resolve();
    runtime.paused = true;
    releaseContext();

    await expect(running).resolves.toMatchObject({ taskId: 't-1' });
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

    const result = await runtime.runOne(input, { role: 'CODER', subtaskId: 's-1' });

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

    const result = await runtime.runOne(createInitialAppState('t-1', 'g'), {
      role: 'CODER',
      subtaskId: 's-1',
    });

    expect(transitions).toHaveLength(2);
    expect(transitions.map((batch) => batch[0]?.value)).toEqual([
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

    await runtime.runOne(createInitialAppState('t-1', 'g'), { role: 'CODER' });

    expect(order).toEqual(['output:CODER:true', 'transition']);
  });

  it('stops the loop exactly on a kind="done" step result', async () => {
    const fake = new FakeExecutor([stepOf('done', [])]);
    const runtime = runtimeWith([fake]);

    await runtime.runOne(createInitialAppState('t-1', 'g'), { role: 'CODER' });

    expect(fake.stepCalls).toHaveLength(1);
  });

  it('throws when the roster does not contain the requested role', async () => {
    const runtime = runtimeWith([new FakeExecutor([])]);

    await expect(runtime.runOne(createInitialAppState('t-1', 'g'), { role: 'PM' })).rejects.toThrow(
      /PM/,
    );
  });

  it('keeps runParallel as a sequential fold with the same terminal state as chained runOne calls', async () => {
    const buildFakes = (): FakeExecutor[] => [
      new FakeExecutor([
        stepOf('llm', [{ field: 'messages', op: 'append', value: chatMessage('coder-a') }]),
        stepOf('done', [{ field: 'messages', op: 'append', value: chatMessage('coder-b') }]),
      ]),
      new FakeExecutor([
        stepOf('tool', [{ field: 'messages', op: 'append', value: chatMessage('tester-a') }]),
        stepOf('done', []),
      ]),
    ];
    const sequential = runtimeWith(buildFakes());
    const parallel = runtimeWith(buildFakes());
    const seed = createInitialAppState('t-1', 'g');

    const afterCoder = await sequential.runOne(seed, { role: 'CODER' });
    const sequentialResult = await sequential.runOne(afterCoder, { role: 'TESTER' });
    const parallelResult = await parallel.runParallel(seed, [
      { role: 'CODER' },
      { role: 'TESTER' },
    ]);

    expect(parallelResult.messages.map((m) => m.msgId)).toEqual(
      sequentialResult.messages.map((m) => m.msgId),
    );
    expect(parallelResult.messages).toEqual(sequentialResult.messages);
  });

  it('keeps paused false through the whole Phase 0 lifecycle and never saves safe points preemptively', async () => {
    const fake = new FakeExecutor([stepOf('llm', []), stepOf('done', [])]);
    const runtime = runtimeWith([fake]);

    expect(runtime.paused).toBe(false);
    await runtime.runOne(createInitialAppState('t-1', 'g'), { role: 'CODER' });

    expect(runtime.paused).toBe(false);
    expect(fake.safePointCalls).toHaveLength(0);
  });
});
