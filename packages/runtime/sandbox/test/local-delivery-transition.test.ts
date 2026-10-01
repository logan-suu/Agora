// Pure closed-recipe checks. Native admission is covered by Phase 12 fixtures.
import { createInitialAppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import { expect, it } from 'vitest';
import {
  assertDeliveryTransition,
  deliveryStartMutations,
  type LocalDeliveryApplicationTransition,
} from '../src/local-delivery-transition';
import { localRecordHash } from '../src/local-registry-records';

function fixture() {
  const state = createInitialAppState('t', 'fixed', 'p');
  state.phase = 'review';
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    workspaces: [],
    bindings: [],
    receipts: [],
    delivery: {
      schemaVersion: 'local-delivery-v1',
      goal: 'apply_to_directory',
      rootId: 'root',
      currentRoundId: null,
      rounds: [],
    },
  };
  const local = structuredClone(state.localExecution);
  local.workspaces.push({
    schemaVersion: 'workspace-v1',
    projectId: 'p',
    taskId: 't',
    workspaceId: 'delivery',
    rootId: 'root',
    grantId: 'grant',
    purpose: 'delivery',
    mode: 'direct',
    baselineManifestId: 'manifest:target',
  });
  const display = `/workspace apply ${JSON.stringify({ projectId: 'p', taskId: 't', actionId: 'apply', expectedRevision: 1, deliveryProposalId: 'proposal:fixed', inputHash: 'a'.repeat(64) })}`;
  const source: Message = {
    msgId: 'apply',
    fromRole: 'leader',
    channelId: 'main',
    type: 'chat',
    ts: 1,
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  const transition: LocalDeliveryApplicationTransition = {
    kind: 'delivery-application-start-v1',
    beforeStateHash: localRecordHash(state),
    workspaceId: 'delivery',
    deliveryProposalId: 'proposal:fixed',
    inputHash: 'a'.repeat(64),
  };
  return { state, local, source, transition };
}
it('adds no worker, phase, validation or approval mutations when acquiring application control', () => {
  const { state, local, source, transition } = fixture();
  expect(deliveryStartMutations(state, local, transition, source)).toEqual([]);
});
it.each(['ledger', 'dispatch', 'mutations'])(
  'rejects generic programs in application recipes: %s',
  (key) => {
    const f = fixture();
    expect(() =>
      assertDeliveryTransition({ ...f.transition, [key]: [] }, f.local, f.source),
    ).toThrow();
  },
);
it.each(['pending', 'running', 'paused'] as const)(
  'refuses non-quiescent workers: %s',
  (status) => {
    const f = fixture();
    f.state.workers.push({
      workerId: 'w',
      role: 'CODER',
      executor: 'harness',
      startedTs: 0,
      status,
    });
    expect(() => deliveryStartMutations(f.state, f.local, f.transition, f.source)).toThrow(
      'delivery_transition_not_ready',
    );
  },
);
it('refuses replacement of delivery goal or existing workspace history', () => {
  const f = fixture();
  if (!f.local.delivery) throw Error('fixture');
  f.local.delivery.goal = 'artifact_only';
  expect(() => deliveryStartMutations(f.state, f.local, f.transition, f.source)).toThrow();
  f.local.delivery.goal = 'apply_to_directory';
  const workspace = f.local.workspaces[0];
  if (!workspace) throw Error('fixture');
  f.state.localExecution?.workspaces.push({ ...workspace, workspaceId: 'prior' });
  expect(() => deliveryStartMutations(f.state, f.local, f.transition, f.source)).toThrow();
});

it('rejects completion recipes that contain a caller supplied mutation program', () => {
  const f = fixture();
  expect(() =>
    assertDeliveryTransition(
      {
        kind: 'delivery-application-complete-v1',
        beforeStateHash: localRecordHash(f.state),
        message: f.source,
        mutations: [],
      },
      f.local,
      undefined,
    ),
  ).toThrow('delivery_transition_invalid');
});
