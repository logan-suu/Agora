/** Trusted completion planning; target proof and complete-State CAS belong to
 * the host control service, never to model output or an ordinary start replay. */
import {
  type AppState,
  appendMutation,
  assertDeliveryCompletion,
  buildDeliveryCompletionMessage,
  type Message,
  type Mutation,
  setMutation,
} from '@agora/core-domain';
import { buildCoordinationLedger } from './progress-ledger';

export function planDeliveryFinalization(
  state: AppState,
  application: Message,
  ts: number,
): Mutation[] {
  if (state.phase === 'done') {
    assertDeliveryCompletion(state, application);
    return [];
  }
  const completion = buildDeliveryCompletionMessage(state, application, ts);
  if (state.messages.some((m) => m.msgId === completion.msgId))
    throw Error('delivery_completion_incomplete');
  const ledger = buildCoordinationLedger(state, {
    nextSpeaker: null,
    instruction: 'Finalize the approved applied version',
    completionCandidate: true,
    requestSatisfied: true,
  });
  return [
    appendMutation('messages', completion),
    appendMutation('messages', {
      msgId: `ledger:${completion.msgId}`,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'chat',
      ts,
      display: 'Coordinator confirmed the approved application.',
      payload: ledger,
    }),
    setMutation('phase', 'done'),
  ];
}
