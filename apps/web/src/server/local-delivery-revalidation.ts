/** Trusted task-serial registration of an explicitly requested fixed-C round.
 * This service records work; it does not start a model or obtain a worker lease. */
import { type AppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import { buildCoordinationLedger } from '../../../../packages/core/orchestration/src/progress-ledger';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalDeliveryCandidates } from '../../../../packages/runtime/sandbox/src/local-delivery-candidates';
import type { LocalDeliveryComparisonStore } from '../../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import {
  assertLocalControlMessage,
  isLocalBindingOperation,
  localRecordHash,
} from '../../../../packages/runtime/sandbox/src/local-registry-records';

type Scope = { projectId: string; taskId: string };
export class LocalDeliveryRevalidation {
  constructor(
    private readonly control: Pick<
      LocalBindingCoordinator,
      'snapshot' | 'recover' | 'assertClosed' | 'commitBinding'
    >,
    private readonly comparisons: Pick<LocalDeliveryComparisonStore, 'verifyCurrent'>,
    private readonly candidates: Pick<LocalDeliveryCandidates, 'materialize'>,
    private readonly loadState: (scope: Scope) => Promise<AppState | undefined>,
    /** Must prove engine eligibility, run/admission/lease convergence and absence
     * of unresolved side effects. The caller owns the existing Leader queue. */
    private readonly assertReady: (state: AppState) => Promise<void>,
  ) {}
  async commit(scope: Scope, sourceMessage: Message): Promise<AppState> {
    scope = structuredClone(scope);
    const message = structuredClone(sourceMessage);
    const intent = parseWorkspaceControl(message.display);
    if (intent?.verb !== 'revalidate') throw Error('workspace_control_not_available');
    assertLocalControlMessage(message, {
      ...scope,
      actionId: intent.actionId,
      sourceMessageId: message.msgId,
      expectedRevision: intent.expectedRevision,
    });
    const registry = await this.control.snapshot();
    const existing = registry.operations.find((entry) => entry.actionId === intent.actionId);
    if (existing) {
      if (
        !isLocalBindingOperation(existing) ||
        !existing.sourceMessage ||
        existing.projectId !== scope.projectId ||
        existing.taskId !== scope.taskId ||
        existing.preparedRevision !== intent.expectedRevision + 1 ||
        existing.deliveryTransition?.kind !== 'delivery-round-start-v1' ||
        localRecordHash(existing.sourceMessage) !==
          localRecordHash({ ...message, ts: existing.sourceMessage.ts })
      )
        throw Error('operation_conflict');
      if (existing.stage === 'prepared') {
        const state = await this.loadState(scope);
        if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
          throw Error('workspace_task_scope_mismatch');
        if (
          !state.localExecution?.receipts.some(
            (receipt) => receipt.receiptId === existing.receiptId,
          )
        ) {
          // Prepared registry state prevents ordinary source admission. Do not
          // bypass that barrier or close an action against unchecked current U.
          throw Error('delivery_revalidation_recovery_required');
        }
      }
      // Never run readiness/commands/models again for a committed old action.
      await this.control.recover(existing.actionId, existing.inputHash);
      return this.control.assertClosed(scope);
    }
    if (registry.revision !== intent.expectedRevision) throw Error('registry_revision_conflict');
    const state = await this.control.assertClosed(scope);
    await this.assertReady(state);
    const compared = await this.comparisons.verifyCurrent(intent.deliveryComparisonId);
    const source = compared.source;
    if (
      compared.inputHash !== intent.inputHash ||
      source.scope.projectId !== scope.projectId ||
      source.scope.taskId !== scope.taskId ||
      !state.localExecution?.delivery ||
      source.scope.rootId !== state.localExecution.delivery.rootId ||
      source.goal !== state.localExecution.delivery.goal
    )
      throw Error('delivery_revalidation_scope_changed');
    if (compared.comparison.status !== 'requires_validation')
      throw Error('delivery_revalidation_not_required');
    const candidate = await this.candidates.materialize(intent.deliveryComparisonId);
    const suffix = localRecordHash({
      ...scope,
      actionId: intent.actionId,
      inputHash: intent.inputHash,
    });
    const roundId = `round:${suffix}`;
    const dispatchId = `delivery-test:${suffix}`;
    const next = structuredClone(state.localExecution);
    if (!next.delivery) throw Error('delivery_revalidation_scope_changed');
    next.delivery.currentRoundId = roundId;
    next.delivery.rounds.push({
      roundId,
      actionId: intent.actionId,
      deliveryComparisonId: intent.deliveryComparisonId,
      inputHash: intent.inputHash,
      grantId: source.grantId,
      grantRevision: source.grantRevision,
      sourceReceiptId: source.sourceReceipts.artifact,
      sourceVersion: source.artifact,
      candidateVersion: candidate.version,
      targetVersion: source.current,
      targetIndexHash: source.targetIndexHash,
      controlFingerprint: source.controlFingerprint,
    });
    const ledger: Message = {
      msgId: `delivery-ledger:${suffix}`,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'chat',
      ts: message.ts,
      display: 'Validate the fixed delivery candidate',
      payload: buildCoordinationLedger(
        { ...state, phase: 'testing' },
        {
          nextSpeaker: 'TESTER',
          instruction: 'Validate the fixed delivery candidate and preserve cumulative tests',
          completionCandidate: false,
          requestSatisfied: false,
        },
      ),
    };
    const dispatch: Message = {
      msgId: dispatchId,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: message.ts,
      display: 'Validate the fixed delivery candidate',
      payload: {
        kind: 'delivery_validation_dispatch',
        nextRole: 'TESTER',
        roundId,
        workerIds: [`worker:${dispatchId}:0`],
        workspaceVersion: candidate.version,
      },
    };
    await this.assertReady(state);
    await this.comparisons.verifyCurrent(intent.deliveryComparisonId);
    if (localRecordHash(await this.control.assertClosed(scope)) !== localRecordHash(state))
      throw Error('delivery_transition_state_changed');
    await this.control.commitBinding({
      ...scope,
      actionId: intent.actionId,
      sourceMessageId: message.msgId,
      sourceMessage: message,
      expectedRevision: intent.expectedRevision,
      nextLocalExecution: next,
      records: {
        roots: registry.roots,
        grants: registry.grants,
        workspaces: registry.workspaces,
        claims: registry.claims,
        ...(registry.linkedRoots ? { linkedRoots: registry.linkedRoots } : {}),
      },
      deliveryTransition: {
        kind: 'delivery-round-start-v1',
        beforeStateHash: localRecordHash(state),
        ledger,
        dispatch,
      },
    });
    return this.control.assertClosed(scope);
  }
}
