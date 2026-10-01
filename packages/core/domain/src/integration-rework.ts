import { isIntegration, type Message } from './state';

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Read immutable D9 conflict resolution facts. This grants no execution or file authority. */
export function readIntegrationRework(message: Message) {
  const intent = record(message.payload.intent),
    receipt = record(message.payload.resolution);
  if (
    receipt?.integrationRework === undefined &&
    !(intent?.kind === 'resolve_human_gate' && intent.option === 'request_rework')
  )
    return undefined;
  const integration = receipt?.integrationRework;
  if (!isIntegration(integration) || integration.status !== 'conflict')
    throw Error('integration_rework_mismatch');
  const gateId = `human-gate:${integration.integrationId}`;
  if (
    message.fromRole !== 'leader' ||
    message.channelId !== 'main' ||
    message.type !== 'chat' ||
    message.payload.kind !== 'leader_intent' ||
    record(message.payload.action)?.status !== 'applied' ||
    intent?.kind !== 'resolve_human_gate' ||
    intent.gateId !== gateId ||
    intent.option !== 'request_rework' ||
    typeof intent.argument !== 'string' ||
    receipt?.gateId !== gateId ||
    receipt.option !== intent.option ||
    receipt.argument !== intent.argument ||
    receipt.resumeSessionId !== `human-gate-resume:${message.msgId}` ||
    !Array.isArray(receipt.safePointRefs) ||
    receipt.safePointRefs.some((ref) => typeof ref !== 'string' || !ref.length) ||
    new Set(receipt.safePointRefs).size !== receipt.safePointRefs.length
  )
    throw Error('integration_rework_mismatch');
  const conflict = integration.conflicts.find((c) => c.workerId === intent.argument);
  if (!conflict) throw Error('integration_rework_mismatch');
  return structuredClone({
    actionId: message.msgId,
    integration,
    conflict,
    replacementId: `worker:integration-rework:${message.msgId}:0`,
  });
}
