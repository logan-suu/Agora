import {
  type AppState,
  canonicalJson,
  currentReviewDispatch,
  type Message,
} from '@agora/core-domain';
import { planObjectionMutations } from './objection';

/** Only a canonical advisory from the current review can justify another dispatch. */
export function currentReviewAdvisory(state: AppState): Message | undefined {
  const dispatch = currentReviewDispatch(state);
  if (dispatch === undefined) return undefined;
  const message = state.messages
    .slice(state.messages.indexOf(dispatch) + 1)
    .filter((entry) => entry.fromRole === 'REVIEWER')
    .at(-1);
  if (message?.type !== 'objection') return undefined;
  if ([...state.workers].reverse().find((worker) => worker.role === 'REVIEWER')?.status !== 'done')
    throw new Error('review continuation requires a settled reviewer');
  const objection = state.objections.find((entry) => entry.id === message.msgId);
  if (objection === undefined)
    throw new Error('review continuation requires its canonical objection');
  const expected = planObjectionMutations(state, 'REVIEWER', {
    kind: 'done',
    reachedSafeBoundary: true,
    output: {
      objection: {
        id: message.msgId,
        threadId: message.threadId,
        ...(message.payload.objection as Record<string, unknown>),
      },
    },
    mutations: [{ op: 'append', field: 'messages', value: message }],
  });
  const mutation = expected[0];
  if (mutation?.op !== 'append' || canonicalJson(mutation.value) !== canonicalJson(objection))
    throw new Error('review continuation objection evidence drifted');
  return objection.track === 'advisory' ? message : undefined;
}
