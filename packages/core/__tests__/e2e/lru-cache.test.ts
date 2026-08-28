import { readdirSync } from 'node:fs';
import { PHASE0_ROSTER } from '@agora/core-domain';
import { runOrchestration } from '@agora/core-orchestration';
import { describe, expect, it } from 'vitest';
import { createPhase0Runtime } from './phase0-runtime';

/**
 * G5 执行链路实测（R11：真实依赖优先，非 mock）——Phase 0 出口验证基线。
 * 仅当环境变量 DEEPSEEK_API_KEY 存在时运行；缺 key 时 skip（CI 无 key 保持绿）。
 *
 * 跑通即证明三件事成立（《详细设计方案》§9 / AGENTS.md 验证基线）：
 *   1. State 传递：真实 AppState 经 project() 构造投影视图，WorkerRuntime 逐轮喂给真实 LLM；
 *   2. Harness 接入：真实 agent loop（ctx.agents.create + followup→whenIdle）驱动 CODER 写码、
 *      TESTER 跑测试（工具经 ctx.tools.register 注册的 fs.read/fs.write/sandbox.run 函数工具）；
 *   3. 投影覆写：模型只看到结构化切片（D1 pre-step 覆写 + tool 交换消息保留），
 *      且 TESTER 的 test-results.json 经 readTestResults 回填为 set('testResults') 突变。
 */
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== '';

describe.skipIf(!hasKey)(
  'G5 e2e: LRU cache task over live DeepSeek (Phase 0 exit baseline)',
  () => {
    it('runs Coordinator → CODER → TESTER to done with passing testResults and sandbox output', async () => {
      const runtime = await createPhase0Runtime({
        taskId: 'lru-1',
        goal: '实现一个带 TTL 的 LRU 缓存类，包含 get/set/delete 方法，并编写单元测试',
        deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
        model: 'deepseek-v4-flash',
      });
      try {
        const final = await runOrchestration(runtime.initialState, {
          workerRuntime: runtime.workerRuntime,
          roster: PHASE0_ROSTER,
        });

        expect(final.phase).toBe('done');
        expect(final.testResults?.passed).toBe(true);
        expect(final.subtasks[0]?.status).toBe('done');
        const tsFiles = readdirSync(runtime.worktree.path).filter((file) => file.endsWith('.ts'));
        expect(tsFiles.length).toBeGreaterThan(0);
        expect(final.messages.some((m) => m.fromRole === 'CODER')).toBe(true);
        expect(final.messages.some((m) => m.fromRole === 'TESTER')).toBe(true);
      } finally {
        await runtime.dispose();
      }
    }, 600_000);
  },
);
