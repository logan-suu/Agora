// Pure control validation; filesystem and publication proofs remain runtime responsibilities.
import { expect, it } from 'vitest';
import { planIntegrationAcknowledgement } from '../src/integration-acknowledgement';
import { planIntegrationCompletion } from '../src/integration-completion';
import { selectIntegrationBranch } from '../src/integration-selection';
import { applyMutations } from '../src/reducer';
import { fixture } from './integration-fixture';

function merged() {
  let state = fixture();
  for (const commit of ['c'.repeat(40), 'd'.repeat(40)]) {
    const integration = state.integration;
    if (!integration) throw Error('missing integration');
    state = applyMutations(
      state,
      planIntegrationAcknowledgement(
        state,
        {
          projectId: state.projectId,
          taskId: state.taskId,
          integration,
          selection: selectIntegrationBranch(state, integration.integrationId),
        },
        { previousCommit: integration.integrationWorktree.headCommit as string, commit },
      ),
    );
  }
  return state;
}

it('completes only the full ordered prefix and replays its exact complete State', () => {
  const before = merged(),
    copy = structuredClone(before);
  const changes = planIntegrationCompletion(before, before);
  const after = applyMutations(before, changes);
  expect(changes).toHaveLength(1);
  expect(after.integration?.status).toBe('done');
  expect(after.integration?.resultCommit).toBe('d'.repeat(40));
  expect({ ...after, integration: before.integration }).toEqual(before);
  expect(planIntegrationCompletion(after, before)).toEqual([]);
  expect(before).toEqual(copy);
});

it.each(['missing', 'empty', 'head', 'conflict', 'worker', 'dispatch', 'phase'] as const)(
  'rejects an invalid completion source: %s',
  (kind) => {
    const before = merged();
    if (!before.integration) throw Error('missing integration');
    if (kind === 'missing') before.integration.mergedBranches.pop();
    if (kind === 'empty') before.integration.pendingBranches = [];
    if (kind === 'head') before.integration.integrationWorktree.headCommit = 'e'.repeat(40);
    if (kind === 'conflict') before.integration.status = 'conflict';
    if (kind === 'worker' && before.workers[0]) before.workers[0].status = 'paused';
    if (kind === 'dispatch') before.messages = [];
    if (kind === 'phase') before.phase = 'coding';
    expect(() => planIntegrationCompletion(before, before)).toThrow();
  },
);

it.each(['message', 'result', 'earlier-merge', 'project'] as const)(
  'refuses completion replay after unrelated or forged State changes: %s',
  (kind) => {
    const before = merged();
    const after = structuredClone(
      applyMutations(before, planIntegrationCompletion(before, before)),
    );
    if (kind === 'message') {
      const message = after.messages[0];
      if (!message) throw Error('missing message');
      after.messages.push({ ...message, msgId: 'new' });
    }
    if (kind === 'result' && after.integration) after.integration.resultCommit = 'e'.repeat(40);
    if (kind === 'earlier-merge' && after.integration?.mergedBranches[0])
      after.integration.mergedBranches[0].mergeCommit = 'f'.repeat(40);
    if (kind === 'project') after.projectId = 'foreign';
    expect(() => planIntegrationCompletion(after, before)).toThrow();
  },
);
