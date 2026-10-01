// Real grant, immutable objects and native Git metadata reads. The source
// envelope isolates metadata admission; it does not claim an approved delivery.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { LocalDeliverySources } from '../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import {
  readLocalDeliveryGitCurrent,
  verifyLocalDeliveryGitMetadata,
} from '../../../packages/runtime/sandbox/src/local-delivery-git-current';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { fixture, hash } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it(
  'retains a private Git metadata proof across source edits and rejects metadata drift',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
        const state = await ctx.control.assertClosed(ctx.scope);
        const current = await readLocalDeliveryGitCurrent(ctx, ctx.scope);
        const source: LocalDeliverySources = {
          scope: current.scope,
          baseline: current.version,
          artifact: current.version,
          current: current.version,
          grantId: current.grantId,
          grantRevision: current.grantRevision,
          goal: 'apply_to_directory',
          sourceReceipts: {
            baseline: 'fixture-baseline',
            artifact: 'fixture-artifact',
            current: current.sourceReceiptId,
          },
          targetIndexHash: current.targetIndexHash,
          controlFingerprint: hash('metadata-fixture'),
        };
        await verifyLocalDeliveryGitMetadata(ctx, state, source);
        const refs = await ctx.objects.references();
        // Application legitimately changes ordinary files. This verifier
        // protects metadata; the separate native tree transaction proves U/C.
        writeFileSync(join(f.root, 'file.txt'), 'changed source bytes\n');
        await verifyLocalDeliveryGitMetadata(ctx, state, source);
        expect(await ctx.objects.references()).toEqual(refs);
        for (const name of ['config', 'index', 'HEAD']) {
          const path = join(f.root, '.git', name);
          const original = readFileSync(path);
          try {
            writeFileSync(path, Buffer.concat([original, Buffer.from('\n# independent drift\n')]));
            await expect(verifyLocalDeliveryGitMetadata(ctx, state, source)).rejects.toThrow();
          } finally {
            writeFileSync(path, original);
          }
          await verifyLocalDeliveryGitMetadata(ctx, state, source);
        }
        await expect(
          verifyLocalDeliveryGitMetadata(ctx, state, { ...source, targetIndexHash: null }),
        ).rejects.toThrow();
        await expect(
          verifyLocalDeliveryGitMetadata(ctx, state, {
            ...source,
            sourceReceipts: { ...source.sourceReceipts, current: `git-current:${hash('missing')}` },
          }),
        ).rejects.toThrow();
        expect(await ctx.control.assertClosed(ctx.scope)).toEqual(state);
        expect(await ctx.objects.references()).toEqual(refs);
        const index = join(f.root, '.git/index');
        const retained = join(f.privateRoot, 'retained-index');
        renameSync(index, retained);
        let missingIndexSource: LocalDeliverySources;
        try {
          const withoutIndex = await readLocalDeliveryGitCurrent(ctx, ctx.scope);
          expect(withoutIndex.targetIndexHash).toBeNull();
          missingIndexSource = {
            ...source,
            current: withoutIndex.version,
            targetIndexHash: null,
            sourceReceipts: { ...source.sourceReceipts, current: withoutIndex.sourceReceiptId },
          };
          await verifyLocalDeliveryGitMetadata(ctx, state, missingIndexSource);
        } finally {
          renameSync(retained, index);
        }
        await expect(
          verifyLocalDeliveryGitMetadata(ctx, state, missingIndexSource),
        ).rejects.toThrow('delivery_git_metadata_changed');
      }),
    ),
  120000,
);
