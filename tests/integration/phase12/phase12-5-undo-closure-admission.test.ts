// Real registry/CAS/native workspace. The deliberately missing original undo
// proof is adversarial input, never evidence of a completed undo or OS authority.
import { type Message, parseWorkspaceControl } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { nativeRangeFixture } from './local-range-native-fixture';

it(
  'does not grant closed workspace admission from an undo claim label without private proof',
  async () =>
    nativeRangeFixture(async (ctx) => {
      const registry = await ctx.control.snapshot(),
        state = await ctx.control.assertClosed(ctx.scope),
        display =
          '/workspace undo ' +
          JSON.stringify({
            ...ctx.scope,
            actionId: 'unproved-undo',
            expectedRevision: registry.revision,
            fileApplyReceiptId: `apply:${'a'.repeat(64)}`,
            inputHash: 'b'.repeat(64),
          }),
        source: Message = {
          msgId: 'unproved-undo',
          channelId: 'main',
          fromRole: 'leader',
          type: 'chat',
          ts: 2,
          display,
          payload: {
            kind: 'leader_intent',
            intent: parseWorkspaceControl(display),
            action: { status: 'applied' },
          },
        };
      if (!state.localExecution) throw Error('missing real local state');
      await ctx.control.commitBinding({
        ...ctx.scope,
        actionId: source.msgId,
        sourceMessageId: source.msgId,
        sourceMessage: source,
        expectedRevision: registry.revision,
        nextLocalExecution: state.localExecution,
        records: {
          roots: registry.roots,
          grants: registry.grants,
          workspaces: registry.workspaces,
          linkedRoots: registry.linkedRoots ?? [],
          claims: [
            ...registry.claims.map((c) =>
              c.workerId === 'coder'
                ? {
                    ...c,
                    status: 'released' as const,
                    closureReceiptId: 'closure:adversarial-label',
                  }
                : c,
            ),
            {
              kind: 'undo',
              claimId: 'claim-unproved-undo',
              ...ctx.scope,
              workspaceId: 'coding',
              writerEpoch: 9,
              createdActionId: source.msgId,
              status: 'active',
              closureReceiptId: null,
              grantRevision: ctx.grant.revision,
              fileApplyReceiptId: `apply:${'a'.repeat(64)}`,
              inputHash: 'b'.repeat(64),
            },
          ],
        },
      });
      await expect(ctx.control.assertClosed(ctx.scope)).rejects.toThrow(
        'undo_evidence_verifier_required',
      );
      const reopened = await LocalBindingCoordinator.open(ctx.owner, ctx.store);
      ctx.control.setUndoEvidenceVerifier(async () => {
        throw Error('undo_private_source_missing');
      });
      await expect(reopened.assertClosed(ctx.scope)).rejects.toThrow('undo_private_source_missing');
      expect(() => reopened.setUndoEvidenceVerifier(async () => {})).toThrow(
        'undo_evidence_verifier_conflict',
      );
    }),
  60_000,
);
