import { selectIntegrationBranch } from './integration-selection';
import { canonicalJson } from './parallel-execution';
import { type Mutation, setMutation } from './reducer';
import { type AppState, type Integration, isIntegration } from './state';

export type IntegrationAcknowledgementInput = {
  projectId: string;
  taskId: string;
  selection: ReturnType<typeof selectIntegrationBranch>;
  integration: Integration;
};
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const objectId = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

/** Plan a serial control mutation, never attest filesystem or publication evidence.
 * The trusted caller must verify the original durable application and physical
 * version, then commit through its task queue without releasing that admission.
 * Replay is limited to this exact prefix; later progress needs historical proof.
 */
export function planIntegrationAcknowledgement(
  state: AppState,
  expected: IntegrationAcknowledgementInput,
  publication: { previousCommit: string; commit: string },
): Mutation[] {
  if (
    expected.projectId !== state.projectId ||
    expected.taskId !== state.taskId ||
    !isIntegration(expected.integration) ||
    !isIntegration(state.integration) ||
    !objectId(publication.previousCommit) ||
    !objectId(publication.commit) ||
    publication.previousCommit.length !== publication.commit.length ||
    publication.previousCommit === publication.commit
  )
    throw Error('integration_acknowledgement_mismatch');
  // Reconstruct only the original integration to validate its complete prefix
  // against current dispatch, plan, assignments, worker and subtask facts.
  const selection = selectIntegrationBranch(
    { ...state, integration: expected.integration },
    expected.integration.integrationId,
  );
  if (
    !equal(selection, expected.selection) ||
    publication.previousCommit !== (selection.target.headCommit ?? selection.target.baseCommit)
  )
    throw Error('integration_acknowledgement_mismatch');
  const { branch } = selection;
  if (!objectId(branch.worktree.headCommit)) throw Error('integration_acknowledgement_mismatch');
  const next: Integration = structuredClone({
    ...expected.integration,
    integrationWorktree: {
      ...expected.integration.integrationWorktree,
      headCommit: publication.commit,
    },
    mergedBranches: [
      ...expected.integration.mergedBranches,
      {
        workerId: branch.workerId,
        subtaskId: branch.subtaskId,
        branch: branch.worktree.branch,
        headCommit: branch.worktree.headCommit,
        mergeCommit: publication.commit,
      },
    ],
  });
  if (!isIntegration(next)) throw Error('integration_acknowledgement_mismatch');
  if (equal(state.integration, next)) return [];
  if (!equal(state.integration, expected.integration))
    throw Error('integration_acknowledgement_mismatch');
  return [setMutation('integration', next)];
}
