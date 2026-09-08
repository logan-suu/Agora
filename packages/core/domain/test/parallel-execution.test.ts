import { describe, expect, it } from 'vitest';
import {
  applyMutations,
  createInitialAppState,
  executionPlanFromArchitecture,
  isExecutionPlan,
  isParallelExecution,
  isWaveValidationReceipt,
  reopenClosure,
  setMutation,
} from '../src/index';

const plan = {
  version: 1 as const,
  subtasks: [
    { id: 'C', title: 'Compose A and B', dependsOn: ['A', 'B'] },
    { id: 'A', title: 'Implement A', dependsOn: [] },
    { id: 'B', title: 'Implement B', dependsOn: [] },
  ],
};

describe('parallel execution contracts', () => {
  it('accepts forward references and rejects cycles, unknown dependencies and extra fields', () => {
    expect(isExecutionPlan(plan)).toBe(true);
    for (const subtasks of [
      [...plan.subtasks, plan.subtasks[0]],
      [{ id: 'A', title: 'A', dependsOn: ['missing'] }],
      [{ id: 'A', title: 'A', dependsOn: ['A'] }],
      [
        { id: 'A', title: 'A', dependsOn: ['B'] },
        { id: 'B', title: 'B', dependsOn: ['A'] },
      ],
      [{ id: 'A', title: 'A', dependsOn: [], status: 'done' }],
    ])
      expect(isExecutionPlan({ version: 1, subtasks })).toBe(false);
    expect(() =>
      applyMutations(createInitialAppState('t', 'g'), [
        setMutation('architecture', { executionPlan: { ...plan, version: 2 } }),
      ]),
    ).toThrow(/executionPlan/);
  });

  it('only degrades absent plans and serializes legacy modules', () => {
    expect(executionPlanFromArchitecture({ modules: ['A', 'B'] })).toEqual({
      degraded: true,
      plan: {
        version: 1,
        subtasks: [
          { id: 'module-1', title: 'A', dependsOn: [] },
          { id: 'module-2', title: 'B', dependsOn: ['module-1'] },
        ],
      },
    });
    expect(() => executionPlanFromArchitecture({ executionPlan: null, modules: ['A'] })).toThrow();
    expect(executionPlanFromArchitecture({ executionPlan: plan }).degraded).toBe(false);
  });

  it('reopens transitive successors even when they were already completed', () => {
    expect(reopenClosure(plan, ['A'])).toEqual(['A', 'C']);
    expect(() => reopenClosure(plan, ['unknown'])).toThrow();
    expect(() => reopenClosure(plan, [])).toThrow();
    expect(() => reopenClosure(plan, ['A', 'A'])).toThrow();
  });

  it('rejects empty, duplicate and cross-paired wave membership', () => {
    const execution = {
      version: 1,
      planId: 'plan-1',
      initialBase: { branch: 'base', commit: 'a'.repeat(40) },
      activeWave: {
        waveId: 'wave-1',
        attempt: 1,
        base: { branch: 'base', commit: 'a'.repeat(40) },
        subtaskIds: ['A', 'B'],
        coderWorkerIds: ['worker:w:0', 'worker:w:1'],
      },
    };
    expect(isParallelExecution(execution)).toBe(true);
    expect(
      isParallelExecution({
        ...execution,
        activeWave: { ...execution.activeWave, coderWorkerIds: ['worker:w:0'] },
      }),
    ).toBe(false);
    expect(
      isParallelExecution({ ...execution, activeWave: { ...execution.activeWave, attempt: 0 } }),
    ).toBe(false);
    expect(
      isParallelExecution({
        ...execution,
        activeWave: { ...execution.activeWave, preparationWorkerId: 'worker:w:0' },
      }),
    ).toBe(false);
  });

  it('requires a complete consistent report and safe evidence for a validation receipt', () => {
    const receipt = {
      kind: 'wave_validation',
      version: 1,
      planId: 'plan-1',
      waveId: 'wave-1',
      attempt: 1,
      dispatchId: 'dispatch-1',
      workerId: 'worker:dispatch-1:0',
      integrationId: 'integration-1',
      inputCommit: 'a'.repeat(40),
      worktree: {
        path: '/data/t/validation',
        branch: 'validation',
        baseCommit: 'a'.repeat(40),
        headCommit: 'b'.repeat(40),
      },
      subtaskIds: ['A'],
      controlFingerprint: 'c'.repeat(64),
      results: { passed: true, total: 2, failed: 0, failures: [] },
      evidence: {
        path: 'validation/dispatch-1.json',
        sha256: 'd'.repeat(64),
        exitCode: 0,
        timedOut: false,
      },
    };
    expect(isWaveValidationReceipt(receipt)).toBe(true);
    for (const patch of [
      { results: { passed: true, total: 0, failed: 0, failures: [] } },
      { results: { passed: true, total: 2, failed: 1, failures: [] } },
      { evidence: { ...receipt.evidence, exitCode: 1 } },
      { evidence: { ...receipt.evidence, path: '../escape.json' } },
      { worktree: { ...receipt.worktree, headCommit: undefined } },
    ])
      expect(isWaveValidationReceipt({ ...receipt, ...patch })).toBe(false);
  });
});
