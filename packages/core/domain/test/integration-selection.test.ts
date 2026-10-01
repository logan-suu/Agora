// Pure canonical control facts; filesystem and completion evidence are tested separately.
import { expect, it } from 'vitest';
import { selectIntegrationBranch } from '../src/integration-selection';
import type { AppState } from '../src/state';
import { base, fixture } from './integration-fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('missing fixture value');
  return value;
}

it('selects the next exact prefix member without changing canonical state', () => {
  const state = fixture(),
    before = structuredClone(state);
  const first = selectIntegrationBranch(state, 'integration');
  expect(first.branch.workerId).toBe('worker-A');
  expect(first.position).toBe(0);
  expect(first.attempt).toBe(1);
  expect(state).toEqual(before);
  first.branch.worktree.path = '/mutated';
  expect(state).toEqual(before);
  const integration = required(state.integration);
  const branch = required(integration.pendingBranches[0]);
  integration.mergedBranches.push({
    workerId: branch.workerId,
    subtaskId: branch.subtaskId,
    branch: branch.worktree.branch,
    headCommit: required(branch.worktree.headCommit),
    mergeCommit: 'c'.repeat(40),
  });
  integration.integrationWorktree.headCommit = 'c'.repeat(40);
  const next = selectIntegrationBranch(state, 'integration');
  expect(next.branch.workerId).toBe('worker-B');
  expect(next.position).toBe(1);
  expect(next.target.headCommit).toBe('c'.repeat(40));
});

it.each([
  [
    'missing-wave',
    (s: AppState) => {
      delete s.parallelExecution;
    },
  ],
  [
    'wrong-phase',
    (s: AppState) => {
      s.phase = 'coding';
    },
  ],
  [
    'wrong-wave',
    (s: AppState) => {
      required(s.integration).waveId = 'stale';
    },
  ],
  [
    'wrong-base',
    (s: AppState) => {
      required(required(s.parallelExecution).activeWave).base = { ...base, branch: 'other' };
    },
  ],
  [
    'missing-member',
    (s: AppState) => {
      required(s.integration).pendingBranches.pop();
    },
  ],
  [
    'foreign-member',
    (s: AppState) => {
      required(required(s.parallelExecution).activeWave).coderWorkerIds[1] = 'foreign';
    },
  ],
  [
    'head-drift',
    (s: AppState) => {
      required(required(s.integration).pendingBranches[0]).worktree.headCommit = 'd'.repeat(40);
    },
  ],
  [
    'subtask-drift',
    (s: AppState) => {
      required(s.subtasks[0]).worktree = required(required(s.subtasks[1]).worktree);
    },
  ],
  [
    'worker-not-done',
    (s: AppState) => {
      required(s.workers[1]).status = 'paused';
    },
  ],
  [
    'wrong-rank',
    (s: AppState) => {
      required(required(s.integration).pendingBranches[1]).topologicalRank = 1;
    },
  ],
  [
    'reordered',
    (s: AppState) => {
      required(s.integration).pendingBranches.reverse();
    },
  ],
  [
    'non-prefix',
    (s: AppState) => {
      const b = required(required(s.integration).pendingBranches[1]);
      required(s.integration).mergedBranches.push({
        workerId: b.workerId,
        subtaskId: b.subtaskId,
        branch: b.worktree.branch,
        headCommit: required(b.worktree.headCommit),
        mergeCommit: base.commit,
      });
    },
  ],
  [
    'target-drift',
    (s: AppState) => {
      required(s.integration).integrationWorktree.headCommit = 'd'.repeat(40);
    },
  ],
  [
    'dispatch-channel',
    (s: AppState) => {
      required(s.messages[1]).channelId = 'sub';
    },
  ],
  [
    'dispatch-plan',
    (s: AppState) => {
      required(s.messages[1]).payload.planId = 'other';
    },
  ],
  [
    'duplicate-dispatch',
    (s: AppState) => {
      s.messages.push(structuredClone(required(s.messages[1])));
    },
  ],
] as const)('rejects inconsistent selection: %s', (_name, mutate) => {
  const state = fixture();
  mutate(state);
  expect(() => selectIntegrationBranch(state, 'integration')).toThrow();
});

it('rejects stale integration requests and exhausted merging progress', () => {
  const state = fixture();
  expect(() => selectIntegrationBranch(state, 'old')).toThrow();
  for (const b of required(state.integration).pendingBranches)
    required(state.integration).mergedBranches.push({
      workerId: b.workerId,
      subtaskId: b.subtaskId,
      branch: b.worktree.branch,
      headCommit: required(b.worktree.headCommit),
      mergeCommit: base.commit,
    });
  expect(() => selectIntegrationBranch(state, 'integration')).toThrow(
    'integration_source_exhausted',
  );
});

it('keeps the canonical current attempt and base rather than assuming every repair uses accepted', () => {
  const state = fixture();
  required(required(state.parallelExecution).activeWave).attempt = 2;
  const repairedBase = { branch: 'failed-validation', commit: 'e'.repeat(40) };
  required(required(state.parallelExecution).activeWave).base = repairedBase;
  required(state.integration).base = repairedBase;
  required(state.integration).integrationWorktree.baseCommit = repairedBase.commit;
  required(state.integration).integrationWorktree.headCommit = repairedBase.commit;
  for (const branch of required(state.integration).pendingBranches)
    branch.worktree.baseCommit = repairedBase.commit;
  for (const worker of state.workers)
    if (typeof worker.worktree === 'object') worker.worktree.baseCommit = repairedBase.commit;
  for (const task of state.subtasks)
    if (typeof task.worktree === 'object') task.worktree.baseCommit = repairedBase.commit;
  const selected = selectIntegrationBranch(state, 'integration');
  expect(selected.attempt).toBe(2);
  expect(selected.base).toEqual(repairedBase);
  // This is a control selection only, not proof that the repair baseline is admissible.
  expect(selected).not.toHaveProperty('version');
});
