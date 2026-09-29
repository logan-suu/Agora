/** Trusted TESTER completion selects the receipt protocol from canonical State. */
import {
  type AppState,
  deliveryValidationDispatch,
  isParallelExecution,
  type Mutation,
} from '@agora/core-domain';
import type { WorkspaceWorkerSession } from '@agora/runtime-sandbox';
import type { LocalGitWaveValidationService } from './local-git-wave-validation';
import type { LocalValidationService } from './local-validation';

type Services = {
  direct: Pick<LocalValidationService, 'complete'>;
  git?: Pick<LocalGitWaveValidationService, 'complete'>;
};

export async function completeLocalTesterAssignment(
  state: AppState,
  workerId: string,
  session: WorkspaceWorkerSession,
  services: Services,
): Promise<readonly Mutation[]> {
  const delivery = deliveryValidationDispatch(state);
  if (delivery) {
    if (
      delivery.workerId !== workerId ||
      session.workspace.mode !== 'direct' ||
      session.workspace.purpose !== 'validation'
    )
      throw Error('local_validation_assignment_mismatch');
    return services.direct.complete(state, workerId, session.workspace.workspaceId, session);
  }
  if (state.parallelExecution !== undefined || state.localExecution?.git !== undefined) {
    if (
      !isParallelExecution(state.parallelExecution) ||
      state.localExecution?.git === undefined ||
      !services.git
    )
      throw Error('local_git_wave_validation_unavailable');
    return services.git.complete(state, workerId, session);
  }
  const source = [...(state.localExecution?.workspaces ?? [])]
    .reverse()
    .find(
      (workspace) =>
        workspace.purpose === 'coding' &&
        workspace.rootId === session.workspace.rootId &&
        workspace.grantId === session.workspace.grantId,
    );
  if (!source) throw Error('local_validation_source_not_ready');
  return services.direct.complete(state, workerId, source.workspaceId, session);
}
