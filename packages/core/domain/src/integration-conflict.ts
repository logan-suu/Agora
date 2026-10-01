import type { IntegrationAcknowledgementInput } from './integration-acknowledgement';
import { selectIntegrationBranch } from './integration-selection';
import { isWorkspaceRelativePath } from './local-workspace';
import { canonicalJson } from './parallel-execution';
import { type Mutation, mergeByIdMutation, setMutation } from './reducer';
import { type AppState, type Integration, isIntegration } from './state';

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Pure serial conflict transition. The caller must prove native conflict paths,
 * the unchanged physical prefix and absence of MERGE_HEAD before committing. */
export function planIntegrationConflict(
  state: AppState,
  expected: IntegrationAcknowledgementInput,
  files: readonly string[],
): Mutation[] {
  if (
    expected.projectId !== state.projectId ||
    expected.taskId !== state.taskId ||
    !isIntegration(expected.integration) ||
    !isIntegration(state.integration) ||
    !Array.isArray(files) ||
    !files.length ||
    files.length > 4096 ||
    new Set(files).size !== files.length ||
    files.some((p) => !isWorkspaceRelativePath(p) || p.split('/').includes('.git'))
  )
    throw Error('integration_conflict_mismatch');
  const selection = selectIntegrationBranch(
    { ...state, integration: expected.integration },
    expected.integration.integrationId,
  );
  if (!equal(selection, expected.selection)) throw Error('integration_conflict_mismatch');
  const { branch } = selection;
  if (!branch.worktree.headCommit) throw Error('integration_conflict_mismatch');
  const next: Integration = structuredClone({
    ...expected.integration,
    status: 'conflict',
    conflicts: [
      {
        workerId: branch.workerId,
        subtaskId: branch.subtaskId,
        branch: branch.worktree.branch,
        headCommit: branch.worktree.headCommit,
        files: [...files],
      },
    ],
  });
  if (!isIntegration(next)) throw Error('integration_conflict_mismatch');
  if (equal(state.integration, next)) {
    if (state.subtasks.find((s) => s.id === branch.subtaskId)?.status !== 'blocked')
      throw Error('integration_conflict_mismatch');
    return [];
  }
  if (!equal(state.integration, expected.integration)) throw Error('integration_conflict_mismatch');
  return [
    setMutation('integration', next),
    mergeByIdMutation('subtasks', branch.subtaskId, { status: 'blocked' }),
  ];
}
