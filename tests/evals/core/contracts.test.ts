import { describe, expect, it } from 'vitest';

import { fingerprintTask, validateEvalTask } from './contracts';

const task = {
  schemaVersion: 1 as const,
  id: 'phase6/message-order',
  version: '1.0.0',
  source: 'agora',
  profiles: ['deterministic', 'model'] as const,
  goal: 'Preserve commit-before-publish ordering.',
  repository: { fixture: 'tests/evals/fixtures/message-order', revision: 'fixture-v1' },
  expectedOutcome: { assertions: ['message.persisted'] },
  expectedInvariants: ['process.commit-before-publish'],
  limits: {
    maxIterations: 8,
    maxDurationMs: 30_000,
    maxModelCalls: 8,
    maxToolCalls: 16,
  },
};

describe('Eval contracts', () => {
  it('fingerprints recursively sorted objects while preserving array order', () => {
    const reordered = {
      ...task,
      limits: {
        maxToolCalls: 16,
        maxModelCalls: 8,
        maxDurationMs: 30_000,
        maxIterations: 8,
      },
      repository: { revision: 'fixture-v1', fixture: 'tests/evals/fixtures/message-order' },
    };
    expect(fingerprintTask(task)).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintTask(reordered)).toBe(fingerprintTask(task));
    expect(fingerprintTask({ ...task, profiles: ['model', 'deterministic'] })).not.toBe(
      fingerprintTask(task),
    );
  });

  it('rejects empty profiles, moving revisions, invalid budgets, and duplicate invariants', () => {
    expect(() => validateEvalTask({ ...task, profiles: [] })).toThrow('profiles');
    expect(() =>
      validateEvalTask({ ...task, repository: { ...task.repository, revision: 'latest' } }),
    ).toThrow('revision');
    expect(() =>
      validateEvalTask({ ...task, limits: { ...task.limits, maxDurationMs: 0 } }),
    ).toThrow('maxDurationMs');
    expect(() =>
      validateEvalTask({ ...task, expectedInvariants: ['process.same', 'process.same'] }),
    ).toThrow('expectedInvariants');
  });
});
