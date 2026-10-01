// Mock reason (R11): these ports isolate routing/replay/partial behavior. Native
// file effects, authority and persistence are exercised by Phase 12 acceptance.
import { createInitialAppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import { expect, it, vi } from 'vitest';
import { LocalDeliveryApplyControl } from '../src/server/local-delivery-apply-control';

function fixture(stage: 'applied' | 'partial' | 'conflict' = 'applied', replayed = false) {
  const scope = { projectId: 'p', taskId: 't' };
  const state = createInitialAppState('t', 'fixed', 'p');
  const call = {
    ...scope,
    claimId: 'claim',
    workspaceId: 'workspace',
    writerEpoch: 1,
    grantRevision: 0,
    deliveryProposalId: 'proposal:fixed',
    inputHash: 'a'.repeat(64),
  };
  const version = {
    kind: 'files' as const,
    manifestId: 'manifest:fixed',
    manifestHash: 'b'.repeat(64),
  };
  const source = {
    scope: { ...scope, rootId: 'root', policyHash: 'c'.repeat(64) },
    baseline: version,
    artifact: version,
    current: version,
  };
  const display = `/workspace apply ${JSON.stringify({ ...scope, actionId: 'apply', expectedRevision: 0, deliveryProposalId: call.deliveryProposalId, inputHash: call.inputHash })}`;
  const message: Message = {
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
  type Options = ConstructorParameters<typeof LocalDeliveryApplyControl>[0];
  const options = {
    control: { assertClosed: vi.fn(async () => state) },
    authority: {
      acquire: vi.fn(async () => ({ call, replayed })),
      assertCall: vi.fn(async () => ({ proposal: { source } })),
    },
    batch: { apply: vi.fn(async () => ({ stage })) },
    application: { complete: vi.fn(async () => message) },
    fallback: { commit: vi.fn(async () => state) },
  };
  const controller = new LocalDeliveryApplyControl(options as unknown as Options);
  return { scope, controller, options, message, call, source, state };
}
it('uses exactly the admitted proposal for effects before registering completion', async () => {
  const f = fixture();
  expect(await f.controller.commit(f.scope, f.message)).toEqual(f.state);
  expect(f.options.batch.apply).toHaveBeenCalledWith(f.call, 'apply', f.source);
  expect(f.options.application.complete).toHaveBeenCalledWith(f.call);
  expect(f.options.batch.apply.mock.invocationCallOrder[0]).toBeLessThan(
    f.options.application.complete.mock.invocationCallOrder[0] ?? 0,
  );
});
it.each(['partial', 'conflict'] as const)(
  'does not release or report completion for %s',
  async (stage) => {
    const f = fixture(stage);
    await expect(f.controller.commit(f.scope, f.message)).rejects.toThrow(
      `delivery_application_${stage}`,
    );
    expect(f.options.application.complete).not.toHaveBeenCalled();
    expect(f.options.control.assertClosed).not.toHaveBeenCalled();
  },
);
it('never resumes effects, completion or a model for a replayed control fact', async () => {
  const f = fixture('applied', true);
  expect(await f.controller.commit(f.scope, f.message)).toEqual(f.state);
  expect(f.options.authority.assertCall).not.toHaveBeenCalled();
  expect(f.options.batch.apply).not.toHaveBeenCalled();
  expect(f.options.application.complete).not.toHaveBeenCalled();
});
it('preserves the existing host control handler for other actions', async () => {
  const f = fixture();
  const message = { ...f.message, display: 'ordinary' };
  await f.controller.commit(f.scope, message);
  expect(f.options.fallback.commit).toHaveBeenCalledWith(f.scope, message);
  expect(f.options.authority.acquire).not.toHaveBeenCalled();
});
