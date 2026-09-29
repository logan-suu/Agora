/** Closed technical recipe for atomically entering a validation round. The
 * trusted application supplies the ledger/dispatch; workers are registered later
 * by WorkerRuntime. No general mutation program is persisted in the registry. */
import {
  type AppState,
  appendMutation,
  assertCurrentDeliveryApplication,
  assertLocalDeliveryApplicationMessage,
  canonicalJson,
  createInitialAppState,
  isMessage,
  type LocalExecutionV1,
  latestCoordinationLedger,
  type Message,
  type Mutation,
  parseWorkspaceControl,
  setMutation,
} from '@agora/core-domain';

import {
  assertRepairTransition,
  type LocalDeliveryRepairTransition,
  repairStartMutations,
} from './local-delivery-repair-transition';

export interface LocalDeliveryRoundTransition {
  kind: 'delivery-round-start-v1';
  beforeStateHash: string;
  ledger: Message;
  dispatch: Message;
}
export interface LocalDeliveryApplicationTransition {
  kind: 'delivery-application-start-v1';
  beforeStateHash: string;
  workspaceId: string;
  deliveryProposalId: string;
  inputHash: string;
}
export type LocalDeliveryTransition =
  | LocalDeliveryRepairTransition
  | LocalDeliveryRoundTransition
  | LocalDeliveryApplicationTransition
  | LocalDeliveryApplicationCompletion;
export interface LocalDeliveryApplicationCompletion {
  kind: 'delivery-application-complete-v1';
  beforeStateHash: string;
  message: Message;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function assertDeliveryTransition(
  value: unknown,
  local: LocalExecutionV1,
  source: Message | undefined,
): asserts value is LocalDeliveryTransition {
  const t = value as LocalDeliveryTransition;
  if (t?.kind === 'delivery-repair-start-v1') {
    assertRepairTransition(t, local, source);
    return;
  }
  if (t?.kind === 'delivery-application-complete-v1') {
    if (
      Object.keys(t).sort().join(',') !== 'beforeStateHash,kind,message' ||
      !/^[a-f0-9]{64}$/.test(t.beforeStateHash) ||
      source !== undefined
    )
      throw Error('delivery_transition_invalid');
    assertLocalDeliveryApplicationMessage(t.message);
    const receipt = t.message.payload;
    const workspace = local.workspaces.find((w) => w.workspaceId === receipt.workspaceId);
    if (
      workspace?.purpose !== 'delivery' ||
      workspace.mode !== 'direct' ||
      workspace.projectId !== receipt.projectId ||
      workspace.taskId !== receipt.taskId ||
      workspace.rootId !== local.delivery?.rootId ||
      workspace.grantId !== receipt.grantId ||
      local.delivery.currentRoundId !== receipt.roundId
    )
      throw Error('delivery_transition_invalid');
    return;
  }
  if (t?.kind === 'delivery-application-start-v1') {
    const intent = source && parseWorkspaceControl(source.display);
    const workspace = local.workspaces.find((w) => w.workspaceId === t.workspaceId);
    if (
      Object.keys(t).sort().join(',') !==
        'beforeStateHash,deliveryProposalId,inputHash,kind,workspaceId' ||
      !/^[a-f0-9]{64}$/.test(t.beforeStateHash) ||
      !/^[a-f0-9]{64}$/.test(t.inputHash) ||
      !workspace ||
      workspace.mode !== 'direct' ||
      workspace.purpose !== 'delivery' ||
      workspace.rootId !== local.delivery?.rootId ||
      intent?.verb !== 'apply' ||
      intent.deliveryProposalId !== t.deliveryProposalId ||
      intent.inputHash !== t.inputHash
    )
      throw Error('delivery_transition_invalid');
    return;
  }
  const round = local.delivery?.rounds.at(-1);
  if (
    !t ||
    Object.keys(t).sort().join(',') !== 'beforeStateHash,dispatch,kind,ledger' ||
    t.kind !== 'delivery-round-start-v1' ||
    !/^[a-f0-9]{64}$/.test(t.beforeStateHash) ||
    !isMessage(t.ledger) ||
    !isMessage(t.dispatch) ||
    !source ||
    !round ||
    local.delivery?.currentRoundId !== round.roundId ||
    source.msgId !== round.actionId
  )
    throw Error('delivery_transition_invalid');
  const intent = parseWorkspaceControl(source.display);
  const ledger = latestCoordinationLedger({
    ...createInitialAppState('validation', 'validation', 'validation'),
    messages: [t.ledger],
  });
  if (
    intent?.verb !== 'revalidate' ||
    intent.actionId !== round.actionId ||
    intent.deliveryComparisonId !== round.deliveryComparisonId ||
    intent.inputHash !== round.inputHash ||
    !ledger ||
    ledger.completionCandidate ||
    ledger.progress.isRequestSatisfied.answer ||
    ledger.progress.nextSpeaker.answer !== 'TESTER' ||
    t.ledger.channelId !== 'main' ||
    t.ledger.msgId === source.msgId ||
    t.ledger.msgId === t.dispatch.msgId ||
    t.dispatch.msgId === source.msgId ||
    t.dispatch.msgId.length > 100 ||
    t.dispatch.channelId !== 'main' ||
    t.dispatch.fromRole !== 'COORDINATOR' ||
    t.dispatch.type !== 'announce' ||
    Object.keys(t.dispatch.payload).sort().join(',') !==
      'kind,nextRole,roundId,workerIds,workspaceVersion' ||
    t.dispatch.payload.kind !== 'delivery_validation_dispatch' ||
    t.dispatch.payload.nextRole !== 'TESTER' ||
    t.dispatch.payload.roundId !== round.roundId ||
    !same(t.dispatch.payload.workspaceVersion, round.candidateVersion) ||
    !same(t.dispatch.payload.workerIds, [`worker:${t.dispatch.msgId}:0`])
  )
    throw Error('delivery_transition_invalid');
}
export function deliveryStartMutations(
  state: AppState,
  local: LocalExecutionV1,
  transition: LocalDeliveryTransition,
  source: Message | undefined,
): Mutation[] {
  assertDeliveryTransition(transition, local, source);
  if (transition.kind === 'delivery-repair-start-v1')
    return repairStartMutations(state, local, transition);
  if (transition.kind === 'delivery-application-complete-v1') {
    const previous = state.localExecution;
    if (
      !previous ||
      !same({ ...previous, receipts: [] }, { ...local, receipts: [] }) ||
      !same(local.receipts.slice(0, previous.receipts.length), previous.receipts) ||
      local.receipts.length !== previous.receipts.length + 1 ||
      state.messages.some((m) => m.msgId === transition.message.msgId) ||
      state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
    )
      throw Error('delivery_transition_not_ready');
    const receipt = assertCurrentDeliveryApplication(state, transition.message, false);
    if (
      local.receipts.at(-1)?.actionId !== receipt.completionActionId ||
      local.receipts.at(-1)?.receiptId !== `binding:${receipt.completionActionId}`
    )
      throw Error('delivery_transition_not_ready');
    return [appendMutation('messages', transition.message)];
  }
  if (!source) throw Error('delivery_transition_invalid');
  if (transition.kind === 'delivery-application-start-v1') {
    const previous = state.localExecution;
    if (
      !previous ||
      state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status)) ||
      state.messages.some((m) => m.msgId === source.msgId) ||
      !same(previous.delivery, local.delivery) ||
      !same(previous.rootIds, local.rootIds) ||
      !same(previous.bindings, local.bindings) ||
      !same(previous.git ?? null, local.git ?? null) ||
      local.workspaces.length !== previous.workspaces.length + 1 ||
      !same(local.workspaces.slice(0, -1), previous.workspaces) ||
      local.workspaces.at(-1)?.workspaceId !== transition.workspaceId
    )
      throw Error('delivery_transition_not_ready');
    return [];
  }
  if (
    state.humanGate ||
    state.workers.some((worker) => ['running', 'paused'].includes(worker.status)) ||
    state.messages.some((message) =>
      [source.msgId, transition.ledger.msgId, transition.dispatch.msgId].includes(message.msgId),
    ) ||
    local.delivery?.rounds.length !== (state.localExecution?.delivery?.rounds.length ?? 0) + 1 ||
    !same(local.rootIds, state.localExecution?.rootIds) ||
    !same(local.workspaces, state.localExecution?.workspaces) ||
    !same(local.bindings, state.localExecution?.bindings) ||
    !same(local.git ?? null, state.localExecution?.git ?? null)
  )
    throw Error('delivery_transition_not_ready');
  return [
    setMutation('phase', 'testing'),
    setMutation('nextRole', 'TESTER'),
    setMutation('testResults', undefined),
    appendMutation('messages', transition.ledger),
    appendMutation('messages', transition.dispatch),
  ];
}
export function assertDeliveryTransitionFacts(
  state: AppState,
  transition: LocalDeliveryTransition,
) {
  if (transition.kind === 'delivery-application-complete-v1') {
    const matches = state.messages.filter((m) => m.msgId === transition.message.msgId);
    if (matches.length !== 1 || !same(matches[0], transition.message))
      throw Error('delivery_transition_incomplete');
    return;
  }
  if (transition.kind === 'delivery-application-start-v1') {
    if (
      !state.localExecution?.workspaces.some(
        (w) => w.workspaceId === transition.workspaceId && w.purpose === 'delivery',
      )
    )
      throw Error('delivery_transition_incomplete');
    return;
  }
  for (const expected of [transition.ledger, transition.dispatch]) {
    const matches = state.messages.filter((message) => message.msgId === expected.msgId);
    if (matches.length !== 1 || !same(matches[0], expected))
      throw Error('delivery_transition_incomplete');
  }
}
