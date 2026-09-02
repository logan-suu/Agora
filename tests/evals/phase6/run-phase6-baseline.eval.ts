import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runEvalTask } from '../core/runner';
import {
  executeDeterministicScenario,
  executeModelScenario,
  PHASE6_DOCKER_CONFIG,
  PHASE6_MODEL_CONFIG,
  usesPhase6Docker,
} from './scenarios';
import { PHASE6_EVAL_TASKS } from './tasks';

const evalRoot = resolve('.data/evals');
const runnerVersion = 'phase6-v2';

describe('phase6 deterministic baseline', () => {
  for (const task of PHASE6_EVAL_TASKS) {
    it(task.id, async () => {
      const result = await runEvalTask({
        task,
        profile: 'deterministic',
        attempt: 1,
        evalRoot,
        runnerVersion,
        systemVariant: 'multi-agent-role-projection',
        modelConfig: { provider: 'scripted', model: 'phase6-fixture-v1', parameters: {} },
        environment: {
          sandbox: usesPhase6Docker(task.id) ? PHASE6_DOCKER_CONFIG.sandbox : 'isolated-node',
          imageOrRuntime: usesPhase6Docker(task.id)
            ? PHASE6_DOCKER_CONFIG.imageOrRuntime
            : process.version,
          platform: `${process.platform}-${process.arch}`,
        },
        execute: (context) => executeDeterministicScenario(task, context),
      });
      expect(result.failure).toBeUndefined();
      expect(result.lifecycle).toBe('final');
      expect(result.overallStatus).toBe('pass');
    });
  }
});

describe('phase6 model baseline', () => {
  for (const task of PHASE6_EVAL_TASKS.filter((entry) => entry.profiles.includes('model'))) {
    it(task.id, async () => {
      if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required');
      const result = await runEvalTask({
        task,
        profile: 'model',
        attempt: 1,
        evalRoot,
        runnerVersion,
        systemVariant: 'multi-agent-role-projection',
        modelConfig: PHASE6_MODEL_CONFIG,
        environment: {
          sandbox: 'no-tools-harness',
          imageOrRuntime: process.version,
          platform: `${process.platform}-${process.arch}`,
        },
        execute: (context) => executeModelScenario(task, context),
      });
      expect(result.failure).toBeUndefined();
      expect(result.lifecycle).toBe('final');
      expect(result.overallStatus).toBe('pass');
    });
  }
});
