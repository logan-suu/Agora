/** Pure selection of a repair cause. This never grants a writer capability;
 * the host must reprove native evidence, current authority and convergence. */

import { currentCompletionEvidence, deriveCompletionResolution } from './completion-resolution';
import { deliveryValidationDispatch } from './delivery-validation-dispatch';
import type { DeliveryRepairSource } from './local-delivery-repair';
import { isLocalReviewBinding, localValidationReceipt } from './local-validation';
import { canonicalJson, currentReviewDispatch } from './parallel-execution';
import type { AppState } from './state';

export function deliveryRepairSource(state: AppState): DeliveryRepairSource | undefined {
  const selected = deliveryValidationDispatch(state);
  if (!selected || !['testing', 'review'].includes(state.phase)) return undefined;
  const validationReceiptId = `workspace-validation:${selected.message.msgId}`;
  const facts = state.messages.filter((m) => m.msgId === validationReceiptId);
  if (!facts.length) return undefined;
  const receipt = localValidationReceipt(state, validationReceiptId);
  if (canonicalJson(state.testResults) !== canonicalJson(receipt.results))
    throw Error('delivery_repair_validation_changed');
  const base = {
    reviewId: null,
    roundId: selected.round.roundId,
    validationReceiptId,
    sourceWorkspaceId: receipt.sourceWorkspaceId,
    workspaceVersion: structuredClone(receipt.workspaceVersion),
    controlFingerprint: receipt.controlFingerprint,
  };
  const closed = () => {
    if (
      state.humanGate ||
      state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
    )
      throw Error('delivery_repair_run_not_closed');
    if (state.workers.find((w) => w.workerId === receipt.workerId)?.status !== 'done')
      throw Error('delivery_repair_validation_not_closed');
  };
  if (state.phase === 'testing') {
    if (receipt.results.passed) return undefined;
    if (state.nextRole !== 'TESTER') throw Error('delivery_repair_validation_changed');
    closed();
    return { ...base, reason: 'tests_failed' as const, triggerId: validationReceiptId };
  }
  const binding = currentCompletionEvidence(state);
  if (
    !isLocalReviewBinding(binding) ||
    binding.roundId !== base.roundId ||
    binding.validationReceiptId !== validationReceiptId
  )
    throw Error('delivery_repair_review_changed');
  const dispatch = currentReviewDispatch(state);
  const cursor = dispatch?.payload.reviewCommentCursor;
  if (
    typeof cursor !== 'number' ||
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor > state.reviewComments.length
  )
    throw Error('delivery_repair_review_changed');
  const verdicts = state.reviewComments.slice(cursor).filter((v) => v.kind === 'verdict');
  if (!verdicts.length) return undefined;
  const verdict = verdicts[0];
  if (
    verdicts.length !== 1 ||
    !verdict ||
    typeof verdict.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(verdict.id) ||
    state.reviewComments.filter((v) => v.id === verdict.id).length !== 1
  )
    throw Error('delivery_repair_review_changed');
  const reviewClosed = () => {
    closed();
    const reviewer = state.workers.find((w) => w.workerId === `worker:${dispatch?.msgId}:0`);
    if (
      state.nextRole !== 'REVIEWER' ||
      reviewer?.role !== 'REVIEWER' ||
      reviewer.status !== 'done'
    )
      throw Error('delivery_repair_review_not_closed');
  };
  if (verdict.verdict === 'approved') {
    const resolution = deriveCompletionResolution(state, verdict.id);
    if (resolution?.option !== 'request_changes') return undefined;
    if (!resolution.resumed) throw Error('delivery_repair_resolution_not_resumed');
    reviewClosed();
    return {
      ...base,
      reason: 'leader_completion_changes_requested' as const,
      triggerId: resolution.actionId,
      reviewId: verdict.id,
    };
  }
  if (verdict.verdict !== 'changes_requested') throw Error('delivery_repair_review_changed');
  if (verdict.issueScope !== undefined && verdict.issueScope !== 'implementation')
    throw Error('delivery_repair_scope_requires_decision');
  reviewClosed();
  return {
    ...base,
    reason: 'review_changes_requested' as const,
    triggerId: verdict.id,
    reviewId: verdict.id,
  };
}
