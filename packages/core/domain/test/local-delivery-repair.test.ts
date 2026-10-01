import { expect, it } from 'vitest';
import { appendMutation, applyMutations, createInitialAppState } from '../src/index';
import { isDeliveryRepairCandidate, isDeliveryRepairDispatch } from '../src/local-delivery-repair';

const version = { kind: 'files', manifestId: 'manifest:c', manifestHash: 'a'.repeat(64) };
const source = {
  roundId: 'round',
  validationReceiptId: 'validation',
  sourceWorkspaceId: 'workspace',
  workspaceVersion: version,
  controlFingerprint: 'b'.repeat(64),
  reason: 'tests_failed',
  triggerId: 'validation',
  reviewId: null,
};
const dispatch = {
  kind: 'delivery_repair_dispatch',
  nextRole: 'CODER',
  source,
  workerIds: ['worker:repair:0'],
};
const candidate = {
  kind: 'workspace_delivery_repair_candidate',
  version: 1,
  projectId: 'p',
  taskId: 't',
  roundId: 'round',
  dispatchId: 'repair',
  workerId: 'worker:repair:0',
  workspaceId: 'repair-workspace',
  workspaceVersion: version,
  controlFingerprint: 'b'.repeat(64),
  closureReceiptId: 'closed',
  proofHash: 'c'.repeat(64),
};
it('accepts only closed repair reference schemas and refuses spoofed identities', () => {
  expect(isDeliveryRepairDispatch(dispatch)).toBe(true);
  expect(isDeliveryRepairCandidate(candidate)).toBe(true);
  for (const invalid of [
    { ...dispatch, extra: true },
    { ...dispatch, workerIds: [] },
    { ...dispatch, nextRole: 'TESTER' },
    { ...dispatch, source: { ...source, reviewId: 'unexpected' } },
    { ...dispatch, source: { ...source, reason: 'review_changes_requested' } },
  ])
    expect(isDeliveryRepairDispatch(invalid)).toBe(false);
  for (const invalid of [
    { ...candidate, extra: true },
    { ...candidate, workerId: 'other' },
    { ...candidate, proofHash: 'bad' },
    { ...candidate, workspaceVersion: { ...version, kind: 'git', commit: 'd'.repeat(40) } },
  ])
    expect(isDeliveryRepairCandidate(invalid)).toBe(false);
});
it.each([dispatch, candidate])('keeps repair messages immutable on ID replay', (payload) => {
  const message = {
    msgId: 'repair',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce' as const,
    ts: 1,
    display: 'Repair',
    payload,
  };
  const state = applyMutations(createInitialAppState('t', 'goal', 'p'), [
    appendMutation('messages', message),
  ]);
  expect(applyMutations(state, [appendMutation('messages', message)])).toEqual(state);
  expect(() =>
    applyMutations(state, [
      appendMutation('messages', {
        ...message,
        payload: { ...payload, proofHash: 'f'.repeat(64) },
      }),
    ]),
  ).toThrow('immutable delivery repair');
});
