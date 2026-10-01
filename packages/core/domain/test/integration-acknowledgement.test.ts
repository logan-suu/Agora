// Pure control transitions only; publication evidence must be verified by runtime.
import { expect, it } from 'vitest';
import { planIntegrationAcknowledgement } from '../src/integration-acknowledgement';
import { selectIntegrationBranch } from '../src/integration-selection';
import { applyMutations } from '../src/reducer';
import { type AppState, isIntegration } from '../src/state';
import { fixture } from './integration-fixture';

function input(state: AppState) {
  if (!state.integration) throw Error('missing integration');
  return {
    projectId: state.projectId,
    taskId: state.taskId,
    selection: selectIntegrationBranch(state, state.integration.integrationId),
    integration: structuredClone(state.integration),
  };
}
const publication = { previousCommit: 'a'.repeat(40), commit: 'c'.repeat(40) };

it('acknowledges one exact prefix through the reducer and replays without another mutation', () => {
  const state = fixture(),
    before = structuredClone(state),
    expected = input(state);
  const mutations = planIntegrationAcknowledgement(state, expected, publication);
  expect(state).toEqual(before);
  expect(mutations).toHaveLength(1);
  const next = applyMutations(state, mutations);
  expect(next.integration?.mergedBranches).toEqual([
    {
      workerId: 'worker-A',
      subtaskId: 'A',
      branch: 'A',
      headCommit: 'a'.repeat(40),
      mergeCommit: publication.commit,
    },
  ]);
  expect(next.integration?.integrationWorktree.headCommit).toBe(publication.commit);
  expect({ ...next, integration: state.integration }).toEqual(state);
  expect(next.integration?.status).toBe('merging');
  expect(next.integration).not.toHaveProperty('resultCommit');
  expect(planIntegrationAcknowledgement(next, expected, publication)).toEqual([]);
  expect(state).toEqual(before);
  expect(selectIntegrationBranch(next, 'integration').position).toBe(1);
  const second = input(next);
  const last = { previousCommit: publication.commit, commit: 'd'.repeat(40) };
  const complete = applyMutations(next, planIntegrationAcknowledgement(next, second, last));
  expect(complete.integration?.mergedBranches).toHaveLength(2);
  expect(complete.integration?.status).toBe('merging');
  expect(planIntegrationAcknowledgement(complete, second, last)).toEqual([]);
  expect(() => planIntegrationAcknowledgement(complete, expected, publication)).toThrow();
});

it.each([
  [
    'project',
    (x: ReturnType<typeof input>) => {
      x.projectId = 'other';
    },
  ],
  [
    'task',
    (x: ReturnType<typeof input>) => {
      x.taskId = 'other';
    },
  ],
  [
    'position',
    (x: ReturnType<typeof input>) => {
      x.selection.position++;
    },
  ],
  [
    'attempt',
    (x: ReturnType<typeof input>) => {
      x.selection.attempt++;
    },
  ],
  [
    'wave',
    (x: ReturnType<typeof input>) => {
      x.selection.waveId = 'stale';
    },
  ],
  [
    'plan',
    (x: ReturnType<typeof input>) => {
      x.selection.planId = 'stale';
    },
  ],
  [
    'source',
    (x: ReturnType<typeof input>) => {
      x.selection.branch.workerId = 'other';
    },
  ],
  [
    'target',
    (x: ReturnType<typeof input>) => {
      x.selection.target.path = '/other';
    },
  ],
] as const)('rejects a stale or substituted acknowledgement: %s', (_name, change) => {
  const state = fixture(),
    expected = input(state),
    before = structuredClone(state);
  change(expected);
  expect(() => planIntegrationAcknowledgement(state, expected, publication)).toThrow();
  expect(state).toEqual(before);
});

it.each([
  { previousCommit: 'b'.repeat(40), commit: 'c'.repeat(40) },
  { previousCommit: 'a'.repeat(40), commit: 'a'.repeat(40) },
  { previousCommit: 'a'.repeat(40), commit: 'not-a-commit' },
  { previousCommit: 'a'.repeat(40), commit: 'c'.repeat(64) },
])('rejects a publication outside the exact old HEAD and object format', (receipt) => {
  const state = fixture();
  expect(() => planIntegrationAcknowledgement(state, input(state), receipt)).toThrow();
});

it('rejects an earlier prefix rewrite even when the latest HEAD is unchanged', () => {
  const state = fixture(['A', 'B', 'C']),
    first = input(state);
  const next = applyMutations(state, planIntegrationAcknowledgement(state, first, publication));
  const second = { previousCommit: publication.commit, commit: 'd'.repeat(40) };
  const later = applyMutations(next, planIntegrationAcknowledgement(next, input(next), second));
  const expected = input(later),
    drifted = structuredClone(later);
  const prior = drifted.integration?.mergedBranches[0];
  if (!prior) throw Error('missing merged branch');
  prior.mergeCommit = 'f'.repeat(40);
  expect(isIntegration(drifted.integration)).toBe(true);
  expect(drifted.integration?.integrationWorktree).toEqual(later.integration?.integrationWorktree);
  expect(() =>
    planIntegrationAcknowledgement(drifted, expected, {
      previousCommit: second.commit,
      commit: 'e'.repeat(40),
    }),
  ).toThrow();
});

it.each(['phase', 'worker', 'dispatch', 'gate'] as const)(
  'does not let an exact repeated prefix bypass current control: %s',
  (change) => {
    const state = fixture(),
      expected = input(state);
    const next = applyMutations(
      state,
      planIntegrationAcknowledgement(state, expected, publication),
    );
    if (change === 'phase') next.phase = 'coding';
    if (change === 'worker' && next.workers[0]) next.workers[0].status = 'paused';
    if (change === 'dispatch') next.messages = [];
    if (change === 'gate')
      next.humanGate = {
        gateId: 'stop',
        reason: 'iteration_limit',
        options: ['stop'],
        phase: 'integrating',
        openedTs: 1,
        safePointRefs: [],
      };
    expect(() => planIntegrationAcknowledgement(next, expected, publication)).toThrow();
  },
);

it('returns detached mutations without changing or retaining caller-owned records', () => {
  const state = fixture(),
    expected = input(state),
    before = structuredClone(state);
  const mutations = planIntegrationAcknowledgement(state, expected, publication);
  const branch = expected.integration.pendingBranches[0];
  if (!branch) throw Error('missing branch');
  branch.worktree.path = '/changed-after-planning';
  expected.selection.branch.worktree.path = '/changed-after-planning';
  const next = applyMutations(state, mutations);
  expect(next.integration?.pendingBranches[0]?.worktree.path).toBe('/owned/A');
  expect(state).toEqual(before);
});
