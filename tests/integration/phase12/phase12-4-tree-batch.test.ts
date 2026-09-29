// Real integration authority, registry, Git, immutable manifests and native effects.
// Canonical completed source workers are fixture facts, not a model or final merge G5.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { inspectLocalRoot } from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalIntegrationAuthority } from '../../../packages/runtime/sandbox/src/local-integration-authority';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { prepareIntegration, registeredFixture } from './local-linked-workspace-fixture';

it.each([
  'success',
  'partial',
  'replay-gap',
  'preflight',
  'no-remove',
  'lost-result',
  'lost-completion',
  'late-edit',
  'parent-drift',
])(
  'applies a durable integration tree batch with real effects: %s',
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
          const call = await authority.acquire(setup.request);
          const admitted = await authority.assertCall(call, 'read');
          const scope = { ...ctx.scope, rootId: ctx.root.rootId, policyHash: ctx.grant.policyHash };
          const capture = async (path: string) =>
            ctx.versions.capture(scope, inspectLocalRoot(path), async () => true);
          const root = setup.physical.path;
          mkdirSync(join(root, 'old'));
          writeFileSync(join(root, 'old/code'), 'old bytes');
          const current = await capture(root);
          const artifactRoot = join(f.base, 'batch-artifact');
          mkdirSync(artifactRoot);
          mkdirSync(join(artifactRoot, '.agora-operations'), { mode: 0o700 });
          // Preserve unrelated source files while replacing an entire visible subtree.
          for (const file of ['file.txt', 'new.txt'])
            writeFileSync(join(artifactRoot, file), readFileSync(join(root, file)));
          mkdirSync(join(artifactRoot, 'new'));
          mkdirSync(join(artifactRoot, 'new/empty'));
          writeFileSync(join(artifactRoot, 'new/code'), Buffer.from([0, 255, 128, 10]));
          if (scenario === 'success') {
            writeFileSync(join(artifactRoot, 'file.txt'), 'replacement bytes');
            chmodSync(join(artifactRoot, 'file.txt'), 0o755);
          }
          const input = {
            scope,
            baseline: current,
            artifact: await capture(artifactRoot),
            current,
          };
          const action = 'apply-tree';
          const beforeUser = readFileSync(join(f.root, 'file.txt'));
          if (scenario === 'preflight')
            writeFileSync(join(root, 'old/code'), 'external edit before batch');
          const originalBind = ctx.objects.bindReference.bind(ctx.objects);
          let armed = true;
          ctx.objects.bindReference = async (key, hash) => {
            const value = (await ctx.objects.get(hash)) as {
              schemaVersion?: string;
              index?: number;
            };
            if (
              armed &&
              ((scenario === 'partial' &&
                value.schemaVersion === 'integration-tree-item-v1' &&
                value.index === 1) ||
                (scenario === 'lost-result' &&
                  value.schemaVersion === 'integration-tree-result-v1') ||
                (scenario === 'lost-completion' &&
                  value.schemaVersion === 'integration-tree-completion-v1'))
            ) {
              armed = false;
              throw Error('injected_tree_receipt_failure');
            }
            const receipt = await originalBind(key, hash);
            if (scenario === 'late-edit' && value.schemaVersion === 'integration-tree-result-v1')
              writeFileSync(join(root, 'new/code'), 'external edit after success object');
            if (
              scenario === 'parent-drift' &&
              value.schemaVersion === 'integration-tree-item-v1' &&
              value.index === 0
            ) {
              renameSync(join(root, 'old'), join(root, 'displaced'));
              mkdirSync(join(root, 'old'));
              writeFileSync(join(root, 'old/user.txt'), 'external directory');
            }
            return receipt;
          };
          if (scenario === 'no-remove') {
            await expect(batches.apply(call, action, input)).rejects.toThrow(
              'authorization_closed',
            );
            expect(readFileSync(join(root, 'old/code'), 'utf8')).toBe('old bytes');
            return;
          }
          if (scenario === 'lost-result' || scenario === 'lost-completion') {
            await expect(batches.apply(call, action, input)).rejects.toThrow(
              'injected_tree_receipt_failure',
            );
            ctx.objects.bindReference = originalBind;
            batches = await LocalIntegrationTreeBatch.open(
              ctx.owner,
              ctx.objects,
              ctx.versions,
              authority,
              resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
            );
            await expect(batches.apply(call, action, input)).rejects.toThrow(
              'tree_batch_recovery_required',
            );
            await expect(batches.readApplied(call, action, input)).rejects.toThrow(
              'tree_batch_recovery_required',
            );
            await expect(batches.apply(call, 'another', input)).rejects.toThrow(
              'tree_batch_recovery_required',
            );
            expect(readFileSync(join(root, 'new/code'))).toEqual(Buffer.from([0, 255, 128, 10]));
            return;
          }
          const result = await batches.apply(call, action, input);
          ctx.objects.bindReference = originalBind;
          writeFileSync(
            join(f.privateRoot, 'tree-batch-result.json'),
            JSON.stringify({ call, input, result }),
          );
          expect(readFileSync(join(f.root, 'file.txt')).equals(beforeUser)).toBe(true);
          if (result.stage !== 'applied')
            await expect(batches.readApplied(call, action, input)).rejects.toThrow(
              'tree_batch_recovery_required',
            );
          else expect(await batches.readApplied(call, action, input)).toEqual(result);
          if (scenario === 'partial') {
            expect(result.stage).toBe('partial');
            expect(result.attempted).toBe(2);
            expect(result.items).toHaveLength(1);
            batches = await LocalIntegrationTreeBatch.open(
              ctx.owner,
              ctx.objects,
              ctx.versions,
              authority,
              resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
            );
            expect(await batches.apply(call, action, input)).toEqual(result);
            await expect(batches.apply(call, 'another', input)).rejects.toThrow(
              'tree_batch_recovery_required',
            );
            await expect(authority.release(call)).rejects.toThrow('tree_batch_recovery_required');
            expect(
              (await ctx.control.snapshot()).claims.find((c) => c.claimId === call.claimId)?.status,
            ).toBe('draining');
          } else if (scenario === 'parent-drift') {
            expect(result.stage).toBe('partial');
            expect(result.attempted).toBe(1);
            expect(result.items).toHaveLength(1);
            expect(readFileSync(join(root, 'old/user.txt'), 'utf8')).toBe('external directory');
            await expect(batches.apply(call, 'another', input)).rejects.toThrow(
              'tree_batch_recovery_required',
            );
          } else if (scenario === 'late-edit') {
            expect(result.stage).toBe('partial');
            expect(result.reason).toBe('completion_invalidated');
            expect(result.version).toBeNull();
            expect(result.items).toHaveLength(5);
            expect(await batches.apply(call, action, input)).toEqual(result);
            await expect(batches.apply(call, 'another', input)).rejects.toThrow(
              'tree_batch_recovery_required',
            );
            await expect(authority.release(call)).rejects.toThrow('tree_batch_recovery_required');
            expect(readFileSync(join(root, 'new/code'), 'utf8')).toBe(
              'external edit after success object',
            );
          } else if (scenario === 'preflight') {
            expect(result.stage).toBe('conflict');
            expect(result.items).toEqual([]);
            expect(result.attempted).toBe(0);
            expect(readFileSync(join(root, 'old/code'), 'utf8')).toBe('external edit before batch');
          } else {
            expect(result.stage).toBe('applied');
            expect(result.attempted).toBe(scenario === 'success' ? 6 : 5);
            expect(result.items).toHaveLength(scenario === 'success' ? 6 : 5);
            if (scenario === 'success') {
              expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('replacement bytes');
              expect(statSync(join(root, 'file.txt')).mode & 0o111).toBe(0o111);
            }
            expect(readFileSync(join(root, 'new/code'))).toEqual(Buffer.from([0, 255, 128, 10]));
            if (!result.version) throw Error('missing final version');
            await ctx.versions.verify(result.version, scope, admitted.binding, async () => true);
            if (scenario === 'replay-gap') {
              const first = result.items[0];
              if (!first) throw Error('missing first item');
              const item = (await ctx.objects.get(first.recordHash)) as {
                native: { journalPath: string };
              };
              rmSync(join(item.native.journalPath, 'result.json'));
              await expect(batches.apply(call, action, input)).rejects.toThrow(
                'tree_batch_evidence_changed',
              );
              await expect(batches.readApplied(call, action, input)).rejects.toThrow(
                'tree_batch_evidence_changed',
              );
              await expect(batches.apply(call, 'another', input)).rejects.toThrow(
                'tree_batch_evidence_changed',
              );
            } else {
              const snapshot = localRecordHash(await ctx.control.snapshot());
              expect(await batches.apply(call, action, input)).toEqual(result);
              expect(localRecordHash(await ctx.control.snapshot())).toBe(snapshot);
              await authority.release(call);
              await expect(batches.readApplied(call, action, input)).rejects.toThrow(
                'integration_claim_closed',
              );
              expect(
                (await ctx.control.snapshot()).claims.find((c) => c.claimId === call.claimId)
                  ?.status,
              ).toBe('released');
            }
          }
        },
        false,
        scenario !== 'no-remove',
      ),
    );
  },
  180_000,
);
