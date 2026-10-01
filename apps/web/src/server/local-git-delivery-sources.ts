/** Host-only Worktree delivery comparison. B, tested A and live U/index each
 * come from their own durable proof. Comparison grants no execution or write. */
import {
  type AppState,
  currentReviewDispatch,
  isLocalReviewBinding,
  isReviewBinding,
} from '@agora/core-domain';
import {
  LocalDeliveryComparisonStore,
  type LocalDeliverySources,
} from '../../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import { readLocalDeliveryGitBaseline } from '../../../../packages/runtime/sandbox/src/local-delivery-git-baseline';
import { readLocalDeliveryGitCurrent } from '../../../../packages/runtime/sandbox/src/local-delivery-git-current';
import type { LocalCodingBaselineOptions } from '../../../../packages/runtime/sandbox/src/local-git-workspaces';
import { localRecordHash } from '../../../../packages/runtime/sandbox/src/local-registry-records';
import type { LocalWorkspaceSessions } from '../../../../packages/runtime/sandbox/src/local-workspace-sessions';
import type { LocalGitWaveValidationService } from './local-git-wave-validation';
import type { LocalValidationService } from './local-validation';

/** Current round selection is exclusive: a missing or failed file proof must
 * never revive the older accepted Git candidate. Both verifiers remain trusted
 * full-evidence readers, not callbacks supplied by models or HTTP payloads. */
export async function selectLocalGitDeliveryArtifact(
  state: AppState,
  validation: Pick<LocalGitWaveValidationService, 'verifiedDeliveryVersion'>,
  rounds?: Pick<LocalValidationService, 'verifyCompletion'>,
) {
  const delivery = state.localExecution?.delivery;
  const payload = currentReviewDispatch(state)?.payload;
  if (!delivery || !payload || (payload.reviewBinding && payload.workspaceReviewBinding))
    throw Error('local_git_delivery_source_changed');
  if (delivery.currentRoundId !== null) {
    if (!rounds) throw Error('local_git_delivery_round_proof_required');
    const expected = payload.workspaceReviewBinding;
    if (!isLocalReviewBinding(expected) || expected.roundId !== delivery.currentRoundId)
      throw Error('local_git_delivery_source_changed');
    const binding = await rounds.verifyCompletion(state);
    if (
      localRecordHash(binding) !== localRecordHash(expected) ||
      binding.workspaceVersion.kind !== 'files'
    )
      throw Error('local_git_delivery_source_changed');
    return { binding, artifact: binding.workspaceVersion };
  }
  const binding = payload.reviewBinding;
  if (!isReviewBinding(binding)) throw Error('local_git_delivery_source_changed');
  const artifact = await validation.verifiedDeliveryVersion(state);
  if (artifact.kind !== 'git' || artifact.commit !== binding.commit)
    throw Error('local_git_delivery_source_changed');
  return { binding, artifact };
}

export function createLocalGitDeliveryComparisons(
  options: LocalCodingBaselineOptions,
  validation: Pick<LocalGitWaveValidationService, 'verifiedDeliveryVersion'>,
  rounds?: Pick<LocalValidationService, 'verifyCompletion'>,
  claims?: Pick<LocalWorkspaceSessions, 'verifyClosedClaim'>,
): LocalDeliveryComparisonStore {
  return new LocalDeliveryComparisonStore(
    options.objects,
    options.versions,
    async (scope): Promise<LocalDeliverySources> => {
      const state = await options.control.assertClosed(scope);
      const delivery = state.localExecution?.delivery;
      if (!delivery) throw Error('local_git_delivery_source_changed');
      const { binding, artifact } = await selectLocalGitDeliveryArtifact(state, validation, rounds);
      const baseline = await readLocalDeliveryGitBaseline(options, scope);
      const current = await readLocalDeliveryGitCurrent(
        options,
        scope,
        claims?.verifyClosedClaim.bind(claims),
      );
      if (
        delivery.rootId !== baseline.root.rootId ||
        delivery.rootId !== current.scope.rootId ||
        baseline.grant.grantId !== current.grantId ||
        baseline.grant.revision !== current.grantRevision ||
        localRecordHash(await options.control.assertClosed(scope)) !== localRecordHash(state)
      )
        throw Error('local_git_delivery_source_changed');
      await options.versions.read(artifact, current.scope);
      return {
        scope: current.scope,
        baseline: baseline.version,
        artifact,
        current: current.version,
        grantId: current.grantId,
        grantRevision: current.grantRevision,
        goal: delivery.goal,
        sourceReceipts: {
          baseline: baseline.sourceReceiptId,
          artifact: binding.validationReceiptId,
          current: current.sourceReceiptId,
        },
        targetIndexHash: current.targetIndexHash,
        controlFingerprint: binding.controlFingerprint,
      };
    },
  );
}
