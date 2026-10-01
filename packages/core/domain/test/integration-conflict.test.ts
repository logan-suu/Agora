// Pure control planning; runtime must authenticate the native conflict and unchanged target.
import { expect, it } from 'vitest';
import { planIntegrationConflict } from '../src/integration-conflict';
import { selectIntegrationBranch } from '../src/integration-selection';
import { applyMutations } from '../src/reducer';
import { fixture } from './integration-fixture';

it('blocks only the next contribution without advancing the successful prefix', () => {
  const before = fixture();
  if (!before.integration) throw Error('missing integration');
  const expected = {
    projectId: before.projectId,
    taskId: before.taskId,
    integration: before.integration,
    selection: selectIntegrationBranch(before, 'integration'),
  };
  const after = applyMutations(before, planIntegrationConflict(before, expected, ['same.ts']));
  expect(after.integration).toEqual({
    ...before.integration,
    status: 'conflict',
    conflicts: [
      {
        workerId: 'worker-A',
        subtaskId: 'A',
        branch: 'A',
        headCommit: 'a'.repeat(40),
        files: ['same.ts'],
      },
    ],
  });
  expect(after.subtasks.find((s) => s.id === 'A')?.status).toBe('blocked');
  expect(after.workers).toEqual(before.workers);
  expect(after.humanGate).toBeUndefined();
  expect(planIntegrationConflict(after, expected, ['same.ts'])).toEqual([]);
  expect(() => planIntegrationConflict(after, expected, ['changed.ts'])).toThrow();
  expect(() =>
    planIntegrationConflict(before, { ...expected, taskId: 'foreign' }, ['same.ts']),
  ).toThrow();
});

it.each(
  [[], ['a', 'a'], ['../outside'], ['/absolute'], ['.git/config'], ['']].map((paths) => ({
    paths,
  })),
)('rejects unusable conflict paths: %j', ({ paths }) => {
  const state = fixture();
  if (!state.integration) throw Error('missing integration');
  const integration = state.integration;
  expect(() =>
    planIntegrationConflict(
      state,
      {
        projectId: state.projectId,
        taskId: state.taskId,
        integration,
        selection: selectIntegrationBranch(state, 'integration'),
      },
      paths,
    ),
  ).toThrow();
});

it('preserves a literal POSIX backslash without treating it as a directory separator', () => {
  const state = fixture();
  if (!state.integration) throw Error('missing integration');
  const next = applyMutations(
    state,
    planIntegrationConflict(
      state,
      {
        projectId: state.projectId,
        taskId: state.taskId,
        integration: state.integration,
        selection: selectIntegrationBranch(state, 'integration'),
      },
      ['a\\b'],
    ),
  );
  expect(next.integration?.conflicts[0]?.files).toEqual(['a\\b']);
});
