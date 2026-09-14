import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { resolveLiveTestModel } from '../../../../tests/helpers/live-model';
import { HarnessExecutor } from '../src/harness-executor';
import { project } from '../src/project';

/** G5: real State projection, Harness turn and model reply folded into an append mutation. */
const liveModel = await resolveLiveTestModel();
const liveLabel = `${liveModel.options.provider}/${liveModel.model}`;

const CODER_SPEC = PHASE0_ROSTER.find((r) => r.role === 'CODER');
if (CODER_SPEC === undefined) throw new Error('CODER spec missing from PHASE0_ROSTER');

describe(`G5 real-chain: HarnessExecutor over live Harness provider (${liveLabel})`, () => {
  it('runs one real turn, returns a done StepResult with the model reply as a messages mutation', async () => {
    const spec = { ...CODER_SPEC, model: liveModel.model };
    const executor = new HarnessExecutor(spec, liveModel.options);
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
