import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';
import { project } from '../src/project';

/**
 * G5 执行链路实测（R11：真实依赖优先，非 mock）。
 * 仅当环境变量 DEEPSEEK_API_KEY 存在时运行；缺 key 时 skip（CI 无 key 保持绿）。
 * 验证「State 传递 + Harness 接入 + 投影覆写」三件事真实成立：
 *   1. State 传递：projection 视图由真实 AppState 构造并经 pre-step 覆写喂给真实 LLM；
 *   2. Harness 接入：真实 agent loop（ctx.agents.create + followup→whenIdle）跑通一次完整 turn；
 *   3. 投影覆写：真实模型回复被捕获并折叠为 messages append mutation（R1）。
 */
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== '';

const CODER_SPEC = PHASE0_ROSTER.find((r) => r.role === 'CODER');
if (CODER_SPEC === undefined) throw new Error('CODER spec missing from PHASE0_ROSTER');

describe.skipIf(!hasKey)('G5 real-chain: HarnessExecutor over live DeepSeek', () => {
  it('runs one real turn, returns a done StepResult with the model reply as a messages mutation', async () => {
    const spec = { ...CODER_SPEC, model: 'deepseek-v4-flash' };
    const executor = new HarnessExecutor(spec, { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } });
    try {
      const state = {
        ...createInitialAppState('g5-lru', 'Answer in one short sentence: what is 2+2?'),
        phase: 'coding' as const,
      };
      const view = project(state, 'CODER', PHASE0_ROSTER);

      const result = await executor.step({ sessionId: 'g5-ses', view });

      expect(result.kind).toBe('done');
      expect(result.reachedSafeBoundary).toBe(true);
      const text = (result.output as { text?: string }).text;
      expect(typeof text).toBe('string');
      expect(text?.length).toBeGreaterThan(0);
      expect(result.mutations).toHaveLength(1);
      expect(result.mutations[0]).toMatchObject({ field: 'messages', op: 'append' });
    } finally {
      await executor.dispose();
    }
  }, 120_000);
});
