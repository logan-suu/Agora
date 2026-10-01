import {
  type DeliveryRepairCandidate,
  deliveryRepairAssignment,
  isDeliveryRepairCandidate,
} from './local-delivery-repair';
import { isLocalValidationReceipt } from './local-validation';
import { canonicalJson } from './parallel-execution';
import type { AppState, Message } from './state';
import { parseWorkspaceControl } from './workspace-control';

/** Canonical references only. Registry closure and private candidate proof are
 * independently required before a worker obtains any filesystem capability. */
export function deliveryValidationDispatch(
  state: AppState,
  historicalRoundId?: string,
  historicalDispatchId?: string,
) {
  const local = state.localExecution;
  const round =
    historicalRoundId === undefined
      ? local?.delivery?.rounds.at(-1)
      : local?.delivery?.rounds.find((entry) => entry.roundId === historicalRoundId);
  const fail = (): never => {
    throw Error('delivery_dispatch_invalid');
  };
  if (!round) return historicalRoundId === undefined ? undefined : fail();
  if (historicalRoundId === undefined && local?.delivery?.currentRoundId !== round.roundId)
    return fail();
  const sources = state.messages.filter((message) => message.msgId === round.actionId);
  const source = sources[0];
  const intent = source && parseWorkspaceControl(source.display);
  if (
    sources.length !== 1 ||
    !source ||
    source.fromRole !== 'leader' ||
    source.channelId !== 'main' ||
    source.type !== 'chat' ||
    intent?.verb !== 'revalidate' ||
    intent.actionId !== round.actionId ||
    intent.projectId !== state.projectId ||
    intent.taskId !== state.taskId ||
    intent.deliveryComparisonId !== round.deliveryComparisonId ||
    intent.inputHash !== round.inputHash ||
    source.payload.kind !== 'leader_intent' ||
    canonicalJson(source.payload.intent) !== canonicalJson(intent) ||
    canonicalJson(source.payload.action) !== canonicalJson({ status: 'applied' }) ||
    !local?.receipts.some(
      (receipt) =>
        receipt.actionId === round.actionId &&
        receipt.receiptId === `binding:${round.actionId}` &&
        receipt.registryRevision === intent.expectedRevision + 1,
    )
  )
    return fail();
  const messages = state.messages.filter(
    (message) =>
      message.payload.kind === 'delivery_validation_dispatch' &&
      message.payload.roundId === round.roundId,
  );
  const message = messages[0];
  if (
    messages.length === 0 ||
    !message ||
    message.fromRole !== 'COORDINATOR' ||
    message.channelId !== 'main' ||
    message.type !== 'announce' ||
    message.payload.nextRole !== 'TESTER' ||
    state.messages.indexOf(message) <= state.messages.indexOf(source) ||
    Object.keys(message.payload).sort().join(',') !==
      'kind,nextRole,roundId,workerIds,workspaceVersion' ||
    canonicalJson(message.payload.workspaceVersion) !== canonicalJson(round.candidateVersion) ||
    canonicalJson(message.payload.workerIds) !== canonicalJson([`worker:${message.msgId}:0`])
  )
    return fail();
  const selections = [
    {
      round,
      message,
      workerId: `worker:${message.msgId}:0`,
      workspaceVersion: round.candidateVersion,
      repairCandidate: undefined as
        | { message: Message; candidate: DeliveryRepairCandidate }
        | undefined,
    },
  ];
  for (const successor of messages.slice(1)) {
    const previous = selections.at(-1);
    const refs = state.messages.filter(
      (m) => m.msgId === successor.payload.repairCandidateReceiptId,
    );
    const fact = refs[0];
    const candidate = fact?.payload;
    if (
      !previous ||
      refs.length !== 1 ||
      !fact ||
      !isDeliveryRepairCandidate(candidate) ||
      fact.msgId !== `repair-candidate:${candidate.dispatchId}` ||
      fact.fromRole !== 'COORDINATOR' ||
      fact.channelId !== 'main' ||
      fact.type !== 'announce' ||
      candidate.projectId !== state.projectId ||
      candidate.taskId !== state.taskId ||
      candidate.roundId !== round.roundId ||
      candidate.controlFingerprint !== round.controlFingerprint ||
      !/^closure:[a-f0-9]{64}$/.test(candidate.closureReceiptId) ||
      successor.fromRole !== 'COORDINATOR' ||
      successor.channelId !== 'main' ||
      successor.type !== 'announce' ||
      successor.payload.nextRole !== 'TESTER' ||
      Object.keys(successor.payload).sort().join(',') !==
        'kind,nextRole,repairCandidateReceiptId,roundId,workerIds,workspaceVersion' ||
      canonicalJson(successor.payload.workspaceVersion) !==
        canonicalJson(candidate.workspaceVersion) ||
      canonicalJson(successor.payload.workerIds) !==
        canonicalJson([`worker:${successor.msgId}:0`]) ||
      state.messages.indexOf(fact) >= state.messages.indexOf(successor) ||
      successor.ts < fact.ts
    )
      return fail();
    const repair = deliveryRepairAssignment(state, candidate.workerId);
    const receipts = state.messages.filter(
      (m) => m.msgId === `workspace-validation:${previous.message.msgId}`,
    );
    const receipt = receipts[0];
    if (
      repair?.worker.status !== 'done' ||
      repair.message.msgId !== candidate.dispatchId ||
      repair.workspace.workspaceId !== candidate.workspaceId ||
      repair.source.validationReceiptId !== `workspace-validation:${previous.message.msgId}` ||
      canonicalJson(repair.source.workspaceVersion) !== canonicalJson(previous.workspaceVersion) ||
      repair.source.controlFingerprint !== round.controlFingerprint ||
      receipts.length !== 1 ||
      !receipt ||
      receipt.fromRole !== 'COORDINATOR' ||
      receipt.channelId !== 'main' ||
      receipt.type !== 'announce' ||
      !isLocalValidationReceipt(receipt.payload) ||
      receipt.payload.dispatchId !== previous.message.msgId ||
      receipt.payload.workerId !== previous.workerId ||
      receipt.payload.sourceWorkspaceId !== repair.source.sourceWorkspaceId ||
      receipt.payload.roundId !== round.roundId ||
      receipt.payload.controlFingerprint !== round.controlFingerprint ||
      canonicalJson(receipt.payload.workspaceVersion) !==
        canonicalJson(previous.workspaceVersion) ||
      state.messages.indexOf(previous.message) >= state.messages.indexOf(receipt) ||
      state.messages.indexOf(receipt) >=
        state.messages.findIndex((m) => m.msgId === repair.message.msgId) ||
      state.messages.findIndex((m) => m.msgId === repair.message.msgId) >=
        state.messages.indexOf(fact) ||
      fact.ts < repair.message.ts
    )
      return fail();
    selections.push({
      round,
      message: successor,
      workerId: `worker:${successor.msgId}:0`,
      workspaceVersion: candidate.workspaceVersion,
      repairCandidate: { message: fact, candidate: structuredClone(candidate) },
    });
  }
  const selected =
    historicalDispatchId === undefined
      ? selections.at(-1)
      : selections.find((entry) => entry.message.msgId === historicalDispatchId);
  return selected ?? fail();
}
