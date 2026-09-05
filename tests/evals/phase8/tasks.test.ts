import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprintTask, validateEvalTask } from '../core/contracts';
import { executePhase8DeterministicScenario } from './scenarios';
import { PHASE8_EVAL_TASKS, PHASE8_INCREMENT_TASKS } from './tasks';

describe('Phase 8 cumulative eval catalog', () => {
  it('extends the fifteen Phase 7 tasks with eight versioned Phase 8 scenarios', () => {
    expect(PHASE8_EVAL_TASKS).toHaveLength(23);
    expect(PHASE8_INCREMENT_TASKS.map((task) => task.id)).toEqual([
      'phase8/completion-approval',
      'phase8/completion-rework',
      'phase8/iteration-limit-replay',
      'phase8/blocking-resolution',
      'phase8/advisory-resolution',
      'phase8/durable-restart-fork',
      'phase8/resource-release',
      'phase8/trace-sanitization-integrity',
    ]);
    expect(new Set(PHASE8_EVAL_TASKS.map((task) => task.id)).size).toBe(23);
    for (const task of PHASE8_EVAL_TASKS) {
      expect(() => validateEvalTask(task)).not.toThrow();
      expect(fingerprintTask(task)).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(resolve(task.repository.fixture))).toBe(true);
    }
  });

  it('declares every D16, D4, D14, and D15 Phase 8 exit scenario', () => {
    const assertions = PHASE8_INCREMENT_TASKS.flatMap(
      (task) => task.expectedOutcome.assertions ?? [],
    );
    expect(assertions).toEqual(
      expect.arrayContaining([
        'completion.approved',
        'completion.rework-routed',
        'iteration-limit.continued',
        'objection.blocking-resolved',
        'objection.advisory-resolved',
        'resume.lineage-child-created',
        'resources.released',
        'trace.safe',
      ]),
    );
    expect(PHASE8_INCREMENT_TASKS.every((task) => task.profiles.includes('deterministic'))).toBe(
      true,
    );
  });

  it('binds the tracked cumulative baseline to every exact task definition', () => {
    const summary = JSON.parse(
      readFileSync(resolve('tests/evals/phase8/baseline-summary.json'), 'utf8'),
    ) as { taskFingerprints?: Record<string, string>; profiles?: { deterministic?: unknown } };
    expect(summary.profiles?.deterministic).toBeDefined();
    expect(summary.taskFingerprints).toEqual(
      Object.fromEntries(PHASE8_EVAL_TASKS.map((task) => [task.id, fingerprintTask(task)])),
    );
  });

  it('fails fast when a Phase 8 task has no deterministic driver', async () => {
    const source = PHASE8_INCREMENT_TASKS[0];
    if (source === undefined) throw new Error('expected Phase 8 fixture task');
    await expect(
      executePhase8DeterministicScenario(
        { ...source, id: 'phase8/unmapped' },
        {
          runRoot: '/tmp/unmapped',
          dataRoot: '/tmp/unmapped/data',
          workspaceRoot: '/tmp/unmapped/workspace',
          registerCleanup: () => undefined,
        },
      ),
    ).rejects.toThrow('no Phase 8 driver');
  });
});
