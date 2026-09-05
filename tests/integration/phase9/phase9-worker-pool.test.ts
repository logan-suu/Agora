// Mock 原因（R11）：仅脚本化外部计费 LLM 的文本响应与并发屏障；本测试真实运行
// HarnessExecutor/Context/Agent loop、WorkerRuntime、GlobalScheduler、角色投影、Reducer
// 与 JsonTaskStateStore canonical commit/load 链。任务 9.1 明确不执行 worker 文件工具副作用。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  PHASE0_ROSTER,
} from '@agora/core-domain';
import { GlobalScheduler, WorkerRuntime } from '@agora/core-orchestration';
import { HarnessExecutor } from '@agora/runtime-executor';
import { JsonTaskStateStore } from '@agora/runtime-state';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

class ConcurrencyProbe {
  active = 0;
  maxActive = 0;
  started = 0;
  private releaseFirstWave = (): void => {};
  private readonly firstWave = new Promise<void>((resolve) => {
    this.releaseFirstWave = resolve;
  });

  async enter(): Promise<void> {
    this.active += 1;
    this.started += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.started === 2) this.releaseFirstWave();
    await this.firstWave;
  }

  leave(): void {
    this.active -= 1;
  }
}

class ConcurrentScriptAdapter extends LlmAdapter {
  constructor(
    private readonly probe: ConcurrencyProbe,
    private readonly reply: string,
  ) {
    super();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    await this.probe.enter();
    try {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: this.reply };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } };
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally {
      this.probe.leave();
    }
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 9 worker pool G5', () => {
  it('runs the complete batch through independent Harness executors and canonical JSON commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase9-worker-pool-'));
    roots.push(root);
    const scope = { projectId: 'project-a', taskId: 'parallel-task' };
    const store = new JsonTaskStateStore(root);
    const assignments = Array.from({ length: 5 }, (_, index) => ({
      workerId: `worker:phase9:${index}`,
      role: 'CODER' as const,
      subtaskId: `parallel-subtask-${index}`,
    }));
    const initial = applyMutations(
      createInitialAppState(scope.taskId, 'Run a side-effect-free parallel batch', scope.projectId),
      assignments.map((assignment) =>
        mergeByIdMutation('subtasks', assignment.subtaskId, {
          title: assignment.subtaskId,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ),
    );
    await store.initialize(scope, initial);
    const probe = new ConcurrencyProbe();
    const executors: HarnessExecutor[] = [];
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        loadState: () => store.load(scope),
        transition: async (_state, mutations) => (await store.commit(scope, mutations)).state,
        transitionStep: async (_state, _role, mutations) =>
          (await store.commit(scope, mutations)).state,
        buildExecutor: (spec, assignment) => {
          const executor = new HarnessExecutor(spec, {
            adapter: new ConcurrentScriptAdapter(probe, `completed ${assignment.workerId}`),
            provider: 'agora-phase9-g5',
          });
          executors.push(executor);
          return executor;
        },
      },
      new GlobalScheduler({ cap: 3 }),
      2,
    );

    try {
      const result = await runtime.runParallel(initial, assignments);
      const persisted = await store.load(scope);

      expect(probe.maxActive).toBe(2);
      expect(probe.started).toBe(5);
      expect(executors).toHaveLength(5);
      expect(result.workers).toHaveLength(5);
      expect(result.workers.every((worker) => worker.status === 'done')).toBe(true);
      expect(new Set(result.workers.map((worker) => worker.sessionId))).toEqual(
        new Set(assignments.map((assignment) => `session:${assignment.workerId}`)),
      );
      expect(result.messages).toHaveLength(5);
      expect(persisted).toEqual(result);
    } finally {
      await Promise.all(executors.map((executor) => executor.dispose()));
    }
  });
});
