// Real native transactions, immutable objects, registry and managed Git prove
// original effects. Completed source assignments are explicit fixture facts;
// this is not final team, model or undo-application G5.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { inspectLocalRoot } from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalIntegrationAuthority } from '../../../packages/runtime/sandbox/src/local-integration-authority';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { prepareIntegration, registeredFixture } from './local-linked-workspace-fixture';

it.each(['closed', 'unknown-prefix'] as const)(
  'reads original tree effects without reacquisition or source replay: %s',
  async (scenario) => {
    await fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          const setup = await prepareIntegration(ctx);
          let batches: LocalIntegrationTreeBatch;
          const authority = new LocalIntegrationAuthority({
            ...ctx,
            assertControl: async () => {},
            verifyClosure: async (claim) => batches.closure(claim),
          });
          batches = await LocalIntegrationTreeBatch.open(
            ctx.owner,
            ctx.objects,
            ctx.versions,
            authority,
            resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
          );
          const call = await authority.acquire(setup.request),
            root = setup.physical.path;
          const scope = { ...ctx.scope, rootId: ctx.root.rootId, policyHash: ctx.grant.policyHash };
          const capture = (path: string) =>
            ctx.versions.capture(scope, inspectLocalRoot(path), async () => true);
          mkdirSync(join(root, 'old'));
          writeFileSync(join(root, 'old/code'), 'original deleted bytes\n');
          const beforeUntouched = readFileSync(join(root, 'file.txt'));
          const current = await capture(root),
            artifact = join(f.base, 'undo-artifact');
          mkdirSync(artifact);
          mkdirSync(join(artifact, '.agora-operations'), { mode: 0o700 });
          writeFileSync(join(artifact, 'file.txt'), 'agent replacement\n');
          chmodSync(join(artifact, 'file.txt'), 0o755);
          writeFileSync(join(artifact, 'new.txt'), readFileSync(join(root, 'new.txt')));
          mkdirSync(join(artifact, 'new'));
          mkdirSync(join(artifact, 'new/empty'));
          writeFileSync(join(artifact, 'new/code'), Buffer.from([0, 255, 10]));
          const input = { scope, baseline: current, artifact: await capture(artifact), current };
          const originalBind = ctx.objects.bindReference.bind(ctx.objects);
          if (scenario === 'unknown-prefix')
            ctx.objects.bindReference = async (key, hash) => {
              const value = (await ctx.objects.get(hash)) as {
                schemaVersion?: string;
                index?: number;
              };
              if (value.schemaVersion === 'integration-tree-item-v1' && value.index === 1)
                throw Error('injected_item_loss');
              return originalBind(key, hash);
            };
          const result = await batches.apply(call, 'undo-original', input);
          ctx.objects.bindReference = originalBind;
          const scopeRead = { ...ctx.scope, workspaceId: call.workspaceId };
          if (scenario === 'unknown-prefix') {
            expect(result).toMatchObject({ stage: 'partial', attempted: 2, items: [{ index: 0 }] });
            await expect(batches.readActual(scopeRead, result.receiptId)).rejects.toThrow(
              'tree_batch_recovery_required',
            );
            expect(readFileSync(join(root, 'file.txt'))).toEqual(beforeUntouched);
            expect(existsSync(join(root, 'old/code'))).toBe(false);
            return;
          }
          expect(result.stage).toBe('applied');
          const first = await batches.readActual(scopeRead, result.receiptId);
          expect(first.effects).toHaveLength(6);
          const replaced = first.effects.find((e) => e.path === 'file.txt');
          expect(replaced).toMatchObject({
            operation: 'put',
            effect: true,
            installedVersion: { kind: 'regular', executable: true },
          });
          expect(first.effects.find((e) => e.path === 'old/code')).toMatchObject({
            operation: 'remove',
            effect: true,
          });
          expect(first.effects.find((e) => e.path === 'old')).toMatchObject({
            operation: 'rmdir',
            effect: true,
            directory: { identity: expect.any(String), metadata: expect.any(String) },
          });
          await authority.release(call);
          writeFileSync(join(root, 'file.txt'), 'later user content\n');
          const registry = localRecordHash(await ctx.control.snapshot());
          const again = await batches.readActual(scopeRead, result.receiptId);
          expect(again).toEqual(first);
          expect(localRecordHash(await ctx.control.snapshot())).toBe(registry);
          expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('later user content\n');
          await expect(
            batches.readActual({ ...scopeRead, taskId: 'other' }, result.receiptId),
          ).rejects.toThrow('tree_batch_evidence_changed');
          const item = (await ctx.objects.get(result.items[0]?.recordHash as string)) as {
            native: { journalPath: string };
          };
          rmSync(join(item.native.journalPath, 'result.json'));
          await expect(batches.readActual(scopeRead, result.receiptId)).rejects.toThrow(
            'tree_batch_evidence_changed',
          );
        },
        false,
        true,
      ),
    );
  },
  180000,
);
