// Real Leader POST, immutable Git candidate, native application and full-State
// completion. The caller supplies synthetic D16 facts, not a model verdict.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertCurrentDeliveryApplication, assertDeliveryCompletion } from '@agora/core-domain';
import type { GlobalScheduler } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { LocalDeliveryApplication } from '../../../apps/web/src/server/local-delivery-application';
import { LocalDeliveryApplicationProposals } from '../../../apps/web/src/server/local-delivery-application-proposals';
import { LocalDeliveryApplyControl } from '../../../apps/web/src/server/local-delivery-apply-control';
import { LocalDeliveryFinalization } from '../../../apps/web/src/server/local-delivery-finalization';
import { createLocalGitDeliveryComparisons } from '../../../apps/web/src/server/local-git-delivery-sources';
import type { LocalGitWaveValidationService } from '../../../apps/web/src/server/local-git-wave-validation';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { LocalDeliveryAuthority } from '../../../packages/runtime/sandbox/src/local-delivery-authority';
import { verifyLocalDeliveryGitMetadata } from '../../../packages/runtime/sandbox/src/local-delivery-git-current';
import { LocalDeliveryTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import type { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import type { registrationContext } from './local-linked-workspace-fixture';

export async function exerciseInitialGitApplication(
  ctx: Awaited<ReturnType<typeof registrationContext>>,
  sessions: LocalWorkspaceSessions,
  validation: LocalGitWaveValidationService,
  scheduler: GlobalScheduler,
) {
  const before = await ctx.control.assertClosed(ctx.scope);
  const runtime = new MessageRuntime(
    join(ctx.owner.root, 'tasks'),
    new ChannelStream(),
    DEFAULT_ROSTER,
  );
  await runtime.initializeState(ctx.scope, before);
  const comparisons = createLocalGitDeliveryComparisons(ctx, validation);
  const compared = await comparisons.prepare(ctx.scope);
  expect(compared.comparison.status).toBe('matches_artifact');
  const proposals = new LocalDeliveryApplicationProposals(ctx.objects, comparisons, (scope) =>
    runtime.store.load(scope),
  );
  const proposal = await proposals.prepare(ctx.scope, compared.deliveryComparisonId);
  expect(proposal.roundId).toBeNull();
  expect(proposal.source.artifact.kind).toBe('git');
  const authority = new LocalDeliveryAuthority({
    control: ctx.control,
    verifyCurrent: (scope, id, hash) => proposals.verifyCurrent(scope, id, hash),
    verifyBinding: (scope, id, hash) => proposals.verifyBinding(scope, id, hash),
    verifyGrant: ctx.verifyGrant,
    verifyTargetMetadata: (state, source) => verifyLocalDeliveryGitMetadata(ctx, state, source),
    verifyClosedClaim: (scope, claim) => sessions.verifyClosedClaim(scope, claim),
    assertControl: async (state) => {
      if (
        scheduler.activeCount !== 0 ||
        state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
      )
        throw Error('fixture_run_not_closed');
    },
  });
  const batch = await LocalDeliveryTreeBatch.open(
    ctx.owner,
    ctx.objects,
    ctx.versions,
    authority,
    resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
  );
  const application = new LocalDeliveryApplication({
    control: ctx.control,
    objects: ctx.objects,
    proposals,
    authority,
    batch,
  });
  const finalizer = new LocalDeliveryFinalization(
    application,
    async (expected, mutations) =>
      (await runtime.compareAndCommitControl(ctx.scope, expected, mutations)).state,
  );
  let starts = 0;
  runtime.bindWorkspaceControlPort(
    new LocalDeliveryApplyControl({
      control: ctx.control,
      authority,
      batch,
      application,
      fallback: {
        commit: async () => {
          throw Error('fixture_control_not_selected');
        },
      },
      startFinalization: async (state) => {
        starts++;
        await finalizer.finalize(state);
      },
    }),
  );
  const intent = {
    ...ctx.scope,
    actionId: 'initial-git-apply',
    expectedRevision: (await ctx.control.snapshot()).revision,
    deliveryProposalId: proposal.deliveryProposalId,
    inputHash: proposal.inputHash,
  };
  const post = () =>
    createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...ctx.scope,
          channelId: 'main',
          msgId: intent.actionId,
          display: `/workspace apply ${JSON.stringify(intent)}`,
        }),
      }),
    );
  const response = await post();
  expect(response.status, JSON.stringify(await response.json())).toBe(202);
  expect(starts).toBe(1);
  const completed = await ctx.control.assertClosed(ctx.scope);
  const message = completed.messages.find(
    (m) => m.payload.kind === 'workspace_delivery_application',
  );
  if (!message) throw Error('missing_git_application');
  const receipt = assertCurrentDeliveryApplication(completed, message);
  expect(receipt.candidateVersion).toEqual(proposal.source.artifact);
  expect(receipt.candidateVersion.kind).toBe('git');
  expect(receipt.targetVersion.kind).toBe('files');
  expect(completed.localExecution?.delivery?.rounds).toEqual([]);
  expect(completed.workers).toEqual(before.workers);
  expect(completed.phase).toBe('done');
  assertDeliveryCompletion(completed, message);
  await finalizer.verify(completed);
  const replay = await post();
  expect(replay.status, JSON.stringify(await replay.json())).toBe(202);
  expect(starts).toBe(1);
  expect(await ctx.control.assertClosed(ctx.scope)).toEqual(completed);
  expect(readFileSync(join(ctx.root.path, 'review.test.cjs'), 'utf8')).toContain(
    'strictEqual(2 + 2, 4)',
  );
  return {
    candidateVersion: receipt.candidateVersion,
    targetVersion: receipt.targetVersion,
    noExtraRound: true,
    applied: true,
    completed: true,
    replayed: true,
  };
}
