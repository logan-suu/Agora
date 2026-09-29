// Real canonical workers, private candidates, Git and native file transactions.
// Lifecycle facts are fixture-owned; this does not stand in for product orchestration G5.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setMutation } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it.each(['normal', 'evidence'] as const)(
  'reads original candidate and applied tree proofs without effects: %s',
  async (scenario) => {
    expect(LocalIntegrationCandidates.prototype.readPrepared).toBeTypeOf('function');
    expect(LocalIntegrationTreeBatch.prototype.readApplied).toBeTypeOf('function');
    await fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          const setup = await completedIntegration(ctx);
          const helper = resolve(
            'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
          );
          const candidates = new LocalIntegrationCandidates({
            ...ctx,
            ...setup,
            candidates: await LocalMergeCandidates.open(
              ctx.owner,
              ctx.objects,
              ctx.versions,
              helper,
            ),
          });
          const batches = await LocalIntegrationTreeBatch.open(
            ctx.owner,
            ctx.objects,
            ctx.versions,
            setup.authority,
            helper,
          );
          const request = { call: setup.call, actionId: 'prepare-applied' };
          const beforePrepare = await ctx.objects.references();
          await expect(candidates.readPrepared(request)).rejects.toThrow(
            'integration_candidate_recovery_required',
          );
          expect(await ctx.objects.references()).toEqual(beforePrepare);
          const prepared = await candidates.prepareNext(request);
          const scope = { ...ctx.scope, rootId: ctx.root.rootId, policyHash: ctx.grant.policyHash };
          const input = {
            scope,
            baseline: prepared.targetVersion,
            current: prepared.targetVersion,
            artifact: prepared.candidate.version,
          };
          const beforeApply = await ctx.objects.references();
          await expect(batches.readApplied(setup.call, 'apply-prepared', input)).rejects.toThrow(
            'tree_batch_recovery_required',
          );
          expect(await ctx.objects.references()).toEqual(beforeApply);
          const applied = await batches.apply(setup.call, 'apply-prepared', input);
          expect(applied.stage).toBe('applied');
          expect(applied.version).not.toBeNull();
          const refs = await ctx.objects.references();
          const state = await ctx.control.assertClosed(ctx.scope);
          const targetHead = f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD']);
          const targetIndex = f.git(['-C', setup.physical.path, 'write-tree']);
          if (scenario === 'normal') {
            writeFileSync(join(f.root, 'user-later.txt'), 'later user commit\n');
            f.git(['-C', f.root, 'add', 'user-later.txt']);
            f.git(['-C', f.root, 'commit', '-m', 'Advance user checkout']);
          }
          const userHead = f.git(['-C', f.root, 'rev-parse', 'HEAD']);
          const userIndex = readFileSync(join(f.root, '.git/index'));
          expect(await candidates.readPrepared(request)).toEqual(prepared);
          expect(await batches.readApplied(setup.call, 'apply-prepared', input)).toEqual(applied);
          await expect(candidates.prepareNext(request)).rejects.toThrow();
          if (scenario === 'evidence') {
            const objectRoot = join(ctx.owner.root, 'local-workspaces/objects');
            const candidateKey = localRecordHash({
              kind: 'integration-candidate',
              ...ctx.scope,
              actionId: request.actionId,
            });
            const completion = localRecordHash({
              kind: 'integration-candidate',
              key: candidateKey,
              stage: 'completion',
            });
            const treeKey = localRecordHash({
              kind: 'integration-tree-batch',
              ...ctx.scope,
              actionId: 'apply-prepared',
            });
            const treeCompletion = localRecordHash({ key: treeKey, name: 'completion' });
            for (const [key, read] of [
              [completion, () => candidates.readPrepared(request)],
              [treeCompletion, () => batches.readApplied(setup.call, 'apply-prepared', input)],
            ] as const) {
              const path = join(objectRoot, `${key}.ref`);
              renameSync(path, `${path}.held`);
              try {
                await expect(read()).rejects.toThrow();
              } finally {
                renameSync(`${path}.held`, path);
              }
            }
            const first = applied.items[0];
            if (!first) throw Error('missing applied item');
            const item = (await ctx.objects.get(first.recordHash)) as {
              native: { journalPath: string };
            };
            const nativePath = join(item.native.journalPath, 'result.json');
            renameSync(nativePath, `${nativePath}.held`);
            try {
              await expect(
                batches.readApplied(setup.call, 'apply-prepared', input),
              ).rejects.toThrow('tree_batch_evidence_changed');
            } finally {
              renameSync(`${nativePath}.held`, nativePath);
            }
            writeFileSync(join(setup.physical.path, 'external.txt'), 'external change');
            try {
              await expect(
                batches.readApplied(setup.call, 'apply-prepared', input),
              ).rejects.toThrow();
            } finally {
              rmSync(join(setup.physical.path, 'external.txt'));
            }
            await ctx.store.commit(ctx.scope, [
              setMutation('iterationCount', state.iterationCount + 1),
            ]);
            try {
              await expect(candidates.readPrepared(request)).rejects.toThrow('operation_conflict');
            } finally {
              await ctx.store.commit(ctx.scope, [
                setMutation('iterationCount', state.iterationCount),
              ]);
            }
          }
          expect(await ctx.objects.references()).toEqual(refs);
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(state);
          expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(targetHead);
          expect(f.git(['-C', setup.physical.path, 'write-tree'])).toBe(targetIndex);
          expect(f.git(['-C', f.root, 'rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
          writeFileSync(
            join(f.privateRoot, 'applied-proofs.json'),
            JSON.stringify({
              scenario,
              prepared,
              applied,
              unchangedReferences: true,
              unchangedState: true,
              targetHead,
              targetIndex,
              userHead,
              unchangedUserIndex: true,
            }),
          );
        },
        true,
      ),
    );
  },
  360_000,
);
