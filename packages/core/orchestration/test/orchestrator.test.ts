// Mock 原因（R11）：Harness 薄执行器在任务 0.5 才交付，本文件注入 FakeExecutor（实现 Executor 端口）
// 以单元级验证编排主循环的固定路由/失败回环/finalize 与纯函数性；
// 不以 test double 替代真实链路验收——G5 实测留待 0.5（HarnessExecutor）/0.6（LRU e2e）/0.7（集成）。

import { createInitialAppState, mergeByIdMutation, PHASE0_ROSTER } from '@agora/core-domain';
import type { Executor, StepResult } from '@agora/runtime-executor';
import { describe, expect, it } from 'vitest';
import type { OrchestrationDeps } from '../src/index';
import { runOrchestration, WorkerRuntime } from '../src/index';

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
    {
      kind: 'done',
      output: {},
      reachedSafeBoundary: true,
      mutations: [mergeByIdMutation('subtasks', SUBTASK_ID, { status: 'done' })],
    },
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
});
