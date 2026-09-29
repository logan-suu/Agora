import { planIntegrationAcknowledgement } from './integration-acknowledgement';
import { selectIntegrationBranch } from './integration-selection';
import { canonicalJson } from './parallel-execution';
import { applyMutations, type Mutation, setMutation } from './reducer';
import { type AppState, isIntegration } from './state';

/** Validate the complete control prefix. This never attests physical evidence. */
export function planIntegrationCompletion(state: AppState, before: AppState): Mutation[] {
  const integration = before.integration;
  if (
    !isIntegration(integration) ||
    integration.status !== 'merging' ||
    integration.resultCommit !== undefined ||
    integration.conflicts.length ||
    !integration.pendingBranches.length ||
    integration.mergedBranches.length !== integration.pendingBranches.length
  )
    throw Error('integration_completion_mismatch');
  let cursor: AppState = {
    ...before,
    integration: {
      ...integration,
      mergedBranches: [],
      integrationWorktree: {
        ...integration.integrationWorktree,
        headCommit: integration.base.commit,
      },
    },
  };
  for (const entry of integration.mergedBranches) {
    const original = cursor.integration;
    if (!original) throw Error('integration_completion_mismatch');
    cursor = applyMutations(
      cursor,
      planIntegrationAcknowledgement(
        cursor,
        {
          projectId: before.projectId,
          taskId: before.taskId,
          integration: original,
          selection: selectIntegrationBranch(cursor, integration.integrationId),
        },
        {
          previousCommit: original.integrationWorktree.headCommit as string,
          commit: entry.mergeCommit,
        },
      ),
    );
  }
  if (canonicalJson(cursor) !== canonicalJson(before))
    throw Error('integration_completion_mismatch');
  const resultCommit = integration.mergedBranches.at(-1)?.mergeCommit;
  if (!resultCommit) throw Error('integration_completion_mismatch');
  const changes = [
    setMutation('integration', structuredClone({ ...integration, resultCommit, status: 'done' })),
  ];
  const after = applyMutations(before, changes);
  if (canonicalJson(state) === canonicalJson(after)) return [];
  if (canonicalJson(state) !== canonicalJson(before))
    throw Error('integration_completion_mismatch');
  return changes;
}
