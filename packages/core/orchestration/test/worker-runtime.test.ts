import type { Message } from '@agora/core-domain';
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import type { Executor, StepResult } from '@agora/runtime-executor';
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

  async step(context: { sessionId: string }): Promise<StepResult> {
    this.stepCalls.push({ sessionId: context.sessionId });
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
