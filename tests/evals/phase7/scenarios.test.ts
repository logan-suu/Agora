import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runEvalTask } from '../core/runner';
import { executePhase7DeterministicScenario } from './scenarios';
import { PHASE7_INCREMENT_TASKS } from './tasks';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 7 deterministic Eval scenarios', () => {
  for (const task of PHASE7_INCREMENT_TASKS) {
    it(`${task.id} produces a final fail-closed result with hashed evidence`, async () => {
      const root = resolve('.data', `phase7-eval-test-${crypto.randomUUID()}`);
      roots.push(root);
      const result = await runEvalTask({
        task,
        profile: 'deterministic',
        attempt: 1,
        evalRoot: join(root, '.data', 'evals'),
        runnerVersion: 'phase7-v1',
        systemVariant: 'multi-agent-role-projection',
        modelConfig: { provider: 'scripted', model: 'phase7-fixture-v1', parameters: {} },
        environment: {
          sandbox: 'isolated-node',
          imageOrRuntime: process.version,
          platform: `${process.platform}-${process.arch}`,
        },
        execute: (context) => executePhase7DeterministicScenario(task, context),
      });

      expect(result).toMatchObject({
        lifecycle: 'final',
        overallStatus: 'pass',
        profile: 'deterministic',
        taskId: task.id,
      });
      expect(result.failure).toBeUndefined();
      expect(result.checks.filter((check) => check.category !== 'efficiency')).not.toContainEqual(
        expect.objectContaining({ status: 'unknown' }),
      );
      for (const evidence of result.artifactRefs) {
        const bytes = await readFile(join(root, '.data', 'evals', result.runId, evidence.path));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(evidence.sha256);
      }
    });
  }
});
