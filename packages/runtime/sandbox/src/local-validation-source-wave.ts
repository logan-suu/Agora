/** Bind an initial validation source to the current wave's cumulative base.
 * Physical completion, Git version and the durable dispatch are proved elsewhere. */
import { type AppState, validationReceipt } from '@agora/core-domain';

export function assertValidationSourceWave(
  state: AppState,
  sourceWorkspaceId: string,
  sourceBaseCommit: string,
): void {
  const execution = state.parallelExecution;
  const integration = state.integration;
  const initialWorkspaceId = state.localExecution?.git?.initialWorkspaceId;
  if (!execution || !integration || !initialWorkspaceId)
    throw Error('workspace_validation_source_mismatch');
  const acceptedId = execution.acceptedReceiptId;
  if (acceptedId === undefined) {
    if (
      sourceWorkspaceId !== initialWorkspaceId ||
      sourceBaseCommit !== execution.initialBase.commit ||
      integration.base.commit !== execution.initialBase.commit
    )
      throw Error('workspace_validation_source_mismatch');
    return;
  }
  const accepted = validationReceipt(state, acceptedId);
  if (
    !accepted.results.passed ||
    sourceWorkspaceId === initialWorkspaceId ||
    sourceBaseCommit !== accepted.worktree.headCommit ||
    integration.base.branch !== accepted.worktree.branch ||
    integration.base.commit !== accepted.worktree.headCommit
  )
    throw Error('workspace_validation_source_mismatch');
}
