/** Closed native registration recipe. It cannot carry arbitrary mutations. */
import {
  type AppState,
  appendMutation,
  canonicalJson,
  createInitialAppState,
  deliveryRepairSource,
  isDeliveryRepairDispatch,
  isMessage,
  type LocalExecutionV1,
  latestCoordinationLedger,
  type Message,
  type Mutation,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
export interface LocalDeliveryRepairTransition {
  kind: 'delivery-repair-start-v1';
  beforeStateHash: string;
  workspaceId: string;
  dispatch: Message;
  ledger: Message;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function assertRepairTransition(
  value: unknown,
  local: LocalExecutionV1,
  source: Message | undefined,
): asserts value is LocalDeliveryRepairTransition {
  const t = value as LocalDeliveryRepairTransition;
  if (
    !t ||
    Object.keys(t).sort().join(',') !== 'beforeStateHash,dispatch,kind,ledger,workspaceId' ||
    t.kind !== 'delivery-repair-start-v1' ||
    !/^[a-f0-9]{64}$/.test(t.beforeStateHash) ||
    source !== undefined ||
    !isMessage(t.dispatch) ||
    !isMessage(t.ledger) ||
    !isDeliveryRepairDispatch(t.dispatch.payload)
  )
    throw Error('delivery_repair_transition_invalid');
  const payload = t.dispatch.payload;
  const workerId = `worker:${t.dispatch.msgId}:0`;
  const workspace = local.workspaces.find((w) => w.workspaceId === t.workspaceId);
  const binding = local.bindings.find((b) => b.workerId === workerId);
  const round = local.delivery?.rounds.at(-1);
  const ledger = latestCoordinationLedger({
    ...createInitialAppState('validation', 'validation', 'validation'),
    messages: [t.ledger],
  });
  if (
    t.dispatch.fromRole !== 'COORDINATOR' ||
    t.dispatch.channelId !== 'main' ||
    t.dispatch.type !== 'announce' ||
    t.dispatch.msgId.length > 100 ||
    !same(payload.workerIds, [workerId]) ||
    t.ledger.channelId !== 'main' ||
    t.ledger.msgId === t.dispatch.msgId ||
    !ledger ||
    ledger.completionCandidate ||
    ledger.progress.isRequestSatisfied.answer ||
    ledger.progress.nextSpeaker.answer !== 'CODER' ||
    !round ||
    local.delivery?.currentRoundId !== payload.source.roundId ||
    round.roundId !== payload.source.roundId ||
    workspace?.purpose !== 'coding' ||
    workspace.mode !== 'direct' ||
    workspace.rootId !== local.delivery.rootId ||
    workspace.grantId !== round.grantId ||
    workspace.baselineManifestId !== payload.source.workspaceVersion.manifestId ||
    binding?.workspaceId !== workspace.workspaceId ||
    binding.subtaskId !== undefined ||
    binding.receiptId !== `binding:${t.dispatch.msgId}`
  )
    throw Error('delivery_repair_transition_invalid');
}
export function repairStartMutations(
  state: AppState,
  local: LocalExecutionV1,
  t: LocalDeliveryRepairTransition,
): Mutation[] {
  assertRepairTransition(t, local, undefined);
  const previous = state.localExecution;
  const payload = t.dispatch.payload;
  if (!isDeliveryRepairDispatch(payload)) throw Error('delivery_repair_transition_invalid');
  const workerId = payload.workerIds[0];
  const latest = local.receipts.at(-1);
  if (
    !previous ||
    !same(deliveryRepairSource(state), payload.source) ||
    state.iterationCount >= 8 ||
    state.workers.some((w) => w.workerId === workerId) ||
    state.messages.some((m) => [t.dispatch.msgId, t.ledger.msgId].includes(m.msgId)) ||
    !same(
      { ...previous, workspaces: [], bindings: [], receipts: [] },
      { ...local, workspaces: [], bindings: [], receipts: [] },
    ) ||
    local.workspaces.length !== previous.workspaces.length + 1 ||
    local.bindings.length !== previous.bindings.length + 1 ||
    local.receipts.length !== previous.receipts.length + 1 ||
    !same(local.workspaces.slice(0, -1), previous.workspaces) ||
    !same(local.bindings.slice(0, -1), previous.bindings) ||
    !same(local.receipts.slice(0, -1), previous.receipts) ||
    local.workspaces.at(-1)?.workspaceId !== t.workspaceId ||
    local.bindings.at(-1)?.workerId !== workerId ||
    latest?.receiptId !== `binding:${t.dispatch.msgId}` ||
    latest.actionId !== t.dispatch.msgId
  )
    throw Error('delivery_repair_transition_not_ready');
  return [
    setMutation('phase', 'coding'),
    setMutation('nextRole', 'CODER'),
    setMutation('iterationCount', state.iterationCount + 1),
    appendMutation('messages', t.ledger),
    appendMutation('messages', t.dispatch),
    mergeByIdMutation('workers', workerId, {
      workerId,
      role: 'CODER',
      executor: 'harness',
      status: 'pending',
      sessionId: `session:${workerId}`,
      startedTs: t.dispatch.ts,
    }),
  ];
}
