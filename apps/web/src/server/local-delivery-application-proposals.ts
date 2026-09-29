/** Immutable, reviewed application previews. These objects grant no file access:
 * the Leader apply controller must recheck them before acquiring write authority. */
import {
  type AppState,
  currentApprovedReviewId,
  currentLocalDeliveryCandidate,
} from '@agora/core-domain';
import type { LocalControlObjects } from '../../../../packages/runtime/sandbox/src/local-control-objects';
import type { LocalDeliveryComparisonStore } from '../../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import { localRecordHash } from '../../../../packages/runtime/sandbox/src/local-registry-records';

type Scope = { projectId: string; taskId: string };
export class LocalDeliveryApplicationProposals {
  constructor(
    private readonly objects: LocalControlObjects,
    private readonly comparisons: LocalDeliveryComparisonStore,
    private readonly loadState: (scope: Scope) => Promise<AppState | undefined>,
  ) {}

  private async current(scope: Scope, comparisonId: string, live = true) {
    const state = await this.loadState(scope);
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('delivery_application_scope_changed');
    const comparison = live
      ? await this.comparisons.verifyCurrent(comparisonId)
      : await this.comparisons.readHistorical(comparisonId);
    const { evidence, version, roundId } = currentLocalDeliveryCandidate(state);
    const reviewId = currentApprovedReviewId(state);
    const delivery = state.localExecution?.delivery;
    if (
      !delivery ||
      comparison.source.scope.projectId !== scope.projectId ||
      comparison.source.scope.taskId !== scope.taskId ||
      delivery.rootId !== comparison.source.scope.rootId ||
      delivery.goal !== comparison.source.goal ||
      comparison.comparison.status !== 'matches_artifact' ||
      evidence.validationReceiptId !== comparison.source.sourceReceipts.artifact ||
      evidence.controlFingerprint !== comparison.source.controlFingerprint ||
      localRecordHash(version) !== localRecordHash(comparison.source.artifact) ||
      roundId !== delivery.currentRoundId
    )
      throw Error('delivery_application_requires_reviewed_candidate');
    if (localRecordHash(await this.loadState(scope)) !== localRecordHash(state))
      throw Error('delivery_application_state_changed');
    return {
      schemaVersion: 'local-delivery-application-proposal-v1' as const,
      projectId: scope.projectId,
      taskId: scope.taskId,
      deliveryComparisonId: comparisonId,
      comparisonInputHash: comparison.inputHash,
      roundId: delivery.currentRoundId,
      reviewId,
      evidence,
      source: comparison.source,
      planHash: comparison.planHash,
      candidateTreeHash: comparison.candidateTreeHash,
    };
  }

  async prepare(scope: Scope, comparisonId: string) {
    const body = await this.current(scope, comparisonId);
    const inputHash = localRecordHash(body);
    const record = { ...body, inputHash };
    const objectHash = await this.objects.put(record);
    const result = await this.verifyCurrent(scope, `proposal:${objectHash}`, inputHash);
    return result;
  }

  async verifyCurrent(scope: Scope, proposalId: string, inputHash: string) {
    return this.verify(scope, proposalId, inputHash, true);
  }

  /** A claim already fixes the original U. This proves the immutable proposal
   * and current review only; transaction readers must separately prove target bytes. */
  async verifyBinding(scope: Scope, proposalId: string, inputHash: string) {
    return this.verify(scope, proposalId, inputHash, false);
  }

  private async verify(scope: Scope, proposalId: string, inputHash: string, live: boolean) {
    if (!/^proposal:[a-f0-9]{64}$/.test(proposalId) || !/^[a-f0-9]{64}$/.test(inputHash))
      throw Error('invalid_delivery_application_proposal');
    const saved = await this.objects.get(proposalId.slice(9));
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      !('deliveryComparisonId' in saved) ||
      typeof saved.deliveryComparisonId !== 'string'
    )
      throw Error('invalid_delivery_application_proposal');
    const body = await this.current(scope, saved.deliveryComparisonId, live);
    const expected = { ...body, inputHash: localRecordHash(body) };
    if (expected.inputHash !== inputHash || localRecordHash(saved) !== localRecordHash(expected))
      throw Error('delivery_application_proposal_changed');
    return { ...expected, deliveryProposalId: proposalId };
  }
}
