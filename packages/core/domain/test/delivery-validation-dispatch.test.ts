import { describe, expect, it } from 'vitest';
import { createInitialAppState, type Message, parseWorkspaceControl } from '../src';
import { deliveryValidationDispatch } from '../src/delivery-validation-dispatch';

function fixture() {
  const state = createInitialAppState('t', 'fixed', 'p');
  const version = {
    kind: 'files' as const,
    manifestId: `manifest:${'a'.repeat(64)}`,
    manifestHash: 'a'.repeat(64),
  };
  const display = `/workspace revalidate ${JSON.stringify({ projectId: 'p', taskId: 't', actionId: 'action', expectedRevision: 4, deliveryComparisonId: 'comparison:fixed', inputHash: 'b'.repeat(64) })}`;
  const leader: Message = {
    msgId: 'action',
    fromRole: 'leader',
    channelId: 'main',
    type: 'chat',
    display,
    ts: 1,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  const dispatch: Message = {
    msgId: 'dispatch',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    display: 'Validate',
    ts: 2,
    payload: {
      kind: 'delivery_validation_dispatch',
      nextRole: 'TESTER',
      roundId: 'round',
      workerIds: ['worker:dispatch:0'],
      workspaceVersion: version,
    },
  };
  state.messages = [leader, dispatch];
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    workspaces: [],
    bindings: [],
    receipts: [
      {
        actionId: 'action',
        receiptId: 'binding:action',
        inputHash: 'd'.repeat(64),
        registryRevision: 5,
      },
    ],
    delivery: {
      schemaVersion: 'local-delivery-v1',
      goal: 'artifact_only',
      rootId: 'root',
      currentRoundId: 'round',
      rounds: [
        {
          roundId: 'round',
          actionId: 'action',
          deliveryComparisonId: 'comparison:fixed',
          inputHash: 'b'.repeat(64),
          grantId: 'grant',
          grantRevision: 0,
          sourceReceiptId: 'old-validation',
          sourceVersion: version,
          candidateVersion: version,
          targetVersion: version,
          targetIndexHash: null,
          controlFingerprint: 'c'.repeat(64),
        },
      ],
    },
  };
  return { state, leader, dispatch };
}
describe('delivery validation dispatch', () => {
  it('selects only the persisted explicit round and deterministic new worker', () => {
    const { state } = fixture();
    expect(deliveryValidationDispatch(state)).toMatchObject({
      workerId: 'worker:dispatch:0',
      round: { roundId: 'round' },
    });
    expect(
      deliveryValidationDispatch(createInitialAppState('other', 'fixed', 'p')),
    ).toBeUndefined();
  });
  it.each(['leader', 'version', 'worker', 'duplicate', 'order', 'receipt', 'scope'] as const)(
    'rejects altered %s provenance',
    (field) => {
      const { state, leader, dispatch } = fixture();
      if (field === 'leader') leader.fromRole = 'CODER';
      if (field === 'version')
        dispatch.payload.workspaceVersion = {
          kind: 'files',
          manifestId: `manifest:${'f'.repeat(64)}`,
          manifestHash: 'f'.repeat(64),
        };
      if (field === 'worker') dispatch.payload.workerIds = ['old-worker'];
      if (field === 'duplicate') state.messages.push({ ...dispatch, msgId: 'second' });
      if (field === 'order') state.messages.reverse();
      if (field === 'receipt' && state.localExecution) state.localExecution.receipts = [];
      if (field === 'scope') state.taskId = 'other';
      expect(() => deliveryValidationDispatch(state)).toThrow('delivery_dispatch_invalid');
    },
  );
});
