// Mock reason (R11): isolate launch idempotence from native provenance and paid
// models. The real POST/Harness/lease path has a separate Phase 12 acceptance.
import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  type Message,
  parseWorkspaceControl,
} from '@agora/core-domain';
import { expect, it, vi } from 'vitest';
import { LocalDeliveryRevalidationControl } from '../src/server/local-delivery-revalidation-control';

function fixture() {
  const scope = { projectId: 'p', taskId: 't' };
  let state = createInitialAppState('t', 'fixed', 'p');
  const display = `/workspace revalidate ${JSON.stringify({ ...scope, actionId: 'revalidate', expectedRevision: 0, deliveryComparisonId: 'comparison:fixed', inputHash: 'a'.repeat(64) })}`;
  const message: Message = {
    msgId: 'revalidate',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    ts: 1,
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  const commit = vi.fn(async () => {
    state = applyMutations(state, [appendMutation('messages', message)]);
    return state;
  });
  const start = vi.fn(async () => {});
  const fallback = { commit: vi.fn(async () => state) };
  const controller = new LocalDeliveryRevalidationControl(
    { commit },
    async () => state,
    start,
    fallback,
  );
  return { scope, message, controller, commit, start, fallback };
}
it('launches only after a newly persisted round and never on replay', async () => {
  const f = fixture();
  const first = await f.controller.commit(f.scope, f.message);
  expect(f.start).toHaveBeenCalledWith(first);
  expect(f.commit.mock.invocationCallOrder[0]).toBeLessThan(
    f.start.mock.invocationCallOrder[0] ?? 0,
  );
  await f.controller.commit(f.scope, { ...f.message, ts: 99 });
  expect(f.commit).toHaveBeenCalledTimes(2);
  expect(f.start).toHaveBeenCalledTimes(1);
});
it('does not silently relaunch when admission failed after durable registration', async () => {
  const f = fixture();
  f.start.mockRejectedValueOnce(Error('capacity_unavailable'));
  await expect(f.controller.commit(f.scope, f.message)).rejects.toThrow('capacity_unavailable');
  const current = await f.controller.commit(f.scope, f.message);
  expect(current.messages.some((m) => m.msgId === f.message.msgId)).toBe(true);
  expect(f.start).toHaveBeenCalledTimes(1);
});
it('does not allocate an execution after provenance or registry rejection', async () => {
  const f = fixture();
  f.commit.mockRejectedValueOnce(Error('delivery_stale'));
  await expect(f.controller.commit(f.scope, f.message)).rejects.toThrow('delivery_stale');
  expect(f.start).not.toHaveBeenCalled();
});
it('preserves other workspace actions for the existing host control handler', async () => {
  const f = fixture();
  const message = { ...f.message, display: 'other' };
  await f.controller.commit(f.scope, message);
  expect(f.fallback.commit).toHaveBeenCalledWith(f.scope, message);
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});
