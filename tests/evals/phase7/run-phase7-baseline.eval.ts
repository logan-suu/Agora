import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runEvalTask } from '../core/runner';
import { PHASE6_MODEL_CONFIG } from '../phase6/scenarios';
import {
  executePhase7DeterministicScenario,
  executePhase7ModelScenario,
  usesPhase7Docker,
} from './scenarios';
import { PHASE7_EVAL_TASKS } from './tasks';

const evalRoot = resolve('.data/evals');
const runnerVersion = 'phase7-v1';

describe('phase7 deterministic baseline', () => {
  for (const task of PHASE7_EVAL_TASKS) {
    it(task.id, async () => {
      const docker = usesPhase7Docker(task.id);
      const result = await runEvalTask({
        task,
        profile: 'deterministic',
        attempt: 1,
        evalRoot,
        runnerVersion,
        systemVariant: 'multi-agent-role-projection',
        modelConfig: { provider: 'scripted', model: 'phase7-fixture-v1', parameters: {} },
        environment: {
          sandbox: docker ? 'docker' : 'isolated-node',
          imageOrRuntime: docker ? 'node:20-slim' : process.version,
          platform: `${process.platform}-${process.arch}`,
        },
        execute: (context) => executePhase7DeterministicScenario(task, context),
      });
      expect(result.failure).toBeUndefined();
      expect(result.lifecycle).toBe('final');
      expect(result.overallStatus).toBe('pass');
    });
  }
});

describe('phase7 model baseline', () => {
  for (const task of PHASE7_EVAL_TASKS.filter((entry) => entry.profiles.includes('model'))) {
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
        execute: (context) => executePhase7ModelScenario(task, context),
      });
      expect(result.failure).toBeUndefined();
      expect(result.lifecycle).toBe('final');
      expect(result.overallStatus).toBe('pass');
    });
  }
});
