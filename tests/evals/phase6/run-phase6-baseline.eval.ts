import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runEvalTask } from '../core/runner';
import { executeDeterministicScenario, executeModelScenario } from './scenarios';
import { PHASE6_EVAL_TASKS } from './tasks';

const evalRoot = resolve('.data/evals');
const runnerVersion = 'phase6-v1';

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
          sandbox: task.expectedInvariants.includes('safety.sandbox-only')
            ? 'docker'
            : 'isolated-node',
          imageOrRuntime: task.expectedInvariants.includes('safety.sandbox-only')
            ? 'node:20-slim'
            : process.version,
          platform: `${process.platform}-${process.arch}`,
        },
        execute: (context) => executeDeterministicScenario(task, context),
      });
      expect(result.failure).toBeUndefined();
      expect(result.checks.filter((check) => check.status === 'fail')).toEqual([]);
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
        modelConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash', parameters: {} },
        environment: {
          sandbox: 'no-tools-harness',
          imageOrRuntime: process.version,
          platform: `${process.platform}-${process.arch}`,
        },
        execute: (context) => executeModelScenario(task, context),
      });
      expect(result.failure).toBeUndefined();
      expect(result.checks.filter((check) => check.status === 'fail')).toEqual([]);
    });
  }
});
