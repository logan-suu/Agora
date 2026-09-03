import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprintTask, validateEvalTask } from '../core/contracts';
import { executePhase7DeterministicScenario } from './scenarios';
import { PHASE7_EVAL_TASKS, PHASE7_INCREMENT_TASKS } from './tasks';

describe('Phase 7 cumulative eval catalog', () => {
  it('extends the ten Phase 6 tasks with five versioned role-lifecycle scenarios', () => {
    expect(PHASE7_EVAL_TASKS).toHaveLength(15);
    expect(PHASE7_INCREMENT_TASKS.map((task) => task.id)).toEqual([
      'phase7/role-registration',
      'phase7/forced-handoff',
      'phase7/onboarding-recovery',
      'phase7/orphan-escalation',
      'phase7/coordinator-protection',
    ]);
    expect(new Set(PHASE7_EVAL_TASKS.map((task) => task.id)).size).toBe(15);
    for (const task of PHASE7_EVAL_TASKS) {
      expect(() => validateEvalTask(task)).not.toThrow();
      expect(fingerprintTask(task)).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(resolve(task.repository.fixture))).toBe(true);
    }
  });

  it('declares outcome and process checks for every Phase 7 exit requirement', () => {
    const assertions = PHASE7_INCREMENT_TASKS.flatMap(
      (task) => task.expectedOutcome.assertions ?? [],
    );
    const invariants = PHASE7_INCREMENT_TASKS.flatMap((task) => task.expectedInvariants);

    expect(assertions).toEqual(
      expect.arrayContaining([
        'roster.role-added',
        'handoff.completed',
        'onboarding.recovered',
        'orphan.escalated',
        'coordinator.protected',
      ]),
    );
    expect(invariants).toEqual(
      expect.arrayContaining([
        'process.roster-channel-atomic',
        'process.departing-before-drain',
        'process.safe-point-before-handoff',
        'process.responsibility-before-departed',
        'process.action-replay-idempotent',
        'process.onboarding-from-persisted-state',
        'process.no-raw-log',
        'process.awaiting-replacement',
        'process.leader-human-gate',
        'process.coordinator-always-enabled',
      ]),
    );
  });

  it('keeps the tracked cumulative baseline bound to every exact task definition', () => {
    const summary = JSON.parse(
      readFileSync(resolve('tests/evals/phase7/baseline-summary.json'), 'utf8'),
    ) as { taskFingerprints?: Record<string, string>; profiles?: { deterministic?: unknown } };
    expect(summary.profiles?.deterministic).toBeDefined();
    expect(summary.taskFingerprints).toEqual(
      Object.fromEntries(PHASE7_EVAL_TASKS.map((task) => [task.id, fingerprintTask(task)])),
    );
  });

  it('fails fast when a Phase 7 task has no mapped deterministic scenario', async () => {
    const source = PHASE7_INCREMENT_TASKS[0];
    if (source === undefined) throw new Error('expected Phase 7 fixture task');
    await expect(
      executePhase7DeterministicScenario(
        { ...source, id: 'phase7/unmapped' },
        {
          runRoot: '/tmp/unmapped',
          dataRoot: '/tmp/unmapped/data',
          workspaceRoot: '/tmp/unmapped/workspace',
          registerCleanup: () => undefined,
        },
      ),
    ).rejects.toThrow('no Phase 7 driver');
  });
});
