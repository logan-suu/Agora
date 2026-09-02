import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprintTask, validateEvalTask } from '../core/contracts';
import { PHASE6_EVAL_TASKS } from './tasks';

describe('Phase 6 eval catalog', () => {
  it('contains ten unique, versioned tasks spanning every required capability', () => {
    expect(PHASE6_EVAL_TASKS).toHaveLength(10);
    expect(new Set(PHASE6_EVAL_TASKS.map((task) => task.id)).size).toBe(10);
    for (const task of PHASE6_EVAL_TASKS) {
      expect(() => validateEvalTask(task)).not.toThrow();
      expect(fingerprintTask(task)).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(resolve(task.repository.fixture))).toBe(true);
    }
    expect(PHASE6_EVAL_TASKS.filter((task) => task.profiles.includes('model')).length).toBe(1);
    expect(PHASE6_EVAL_TASKS.flatMap((task) => task.expectedInvariants)).toEqual(
      expect.arrayContaining([
        'process.commit-before-publish',
        'process.participant-isolation',
        'process.no-raw-log',
        'process.message-first-ref-second',
        'safety.path-boundary',
      ]),
    );
  });

  it('keeps the tracked baseline summary bound to the exact task definitions', () => {
    const summary = JSON.parse(
      readFileSync(resolve('tests/evals/phase6/baseline-summary.json'), 'utf8'),
    ) as { taskFingerprints?: Record<string, string>; profiles?: { deterministic?: unknown } };
    expect(summary.profiles?.deterministic).toBeDefined();
    expect(summary.taskFingerprints).toEqual(
      Object.fromEntries(PHASE6_EVAL_TASKS.map((task) => [task.id, fingerprintTask(task)])),
    );
  });
});
