// Real Git, native tree effects and State persistence; only the lost response is injected.
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  applicationPhase,
  readCompletedApplication,
} from '../../../packages/runtime/sandbox/src/local-integration-application-records';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it('publishes and confirms two ordered branches from the immutable prior application', async () => {
  await fixture(async (f) =>
    registeredFixture(
      f,
      async (ctx) => {
        const setup = await completedIntegration(ctx, { seedDirectories: true });
        const helper = resolve(
          'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
        );
        const batches = await LocalIntegrationTreeBatch.open(
          ctx.owner,
          ctx.objects,
          ctx.versions,
          setup.authority,
          helper,
        );
        const candidates = new LocalIntegrationCandidates({
          ...ctx,
          ...setup,
          historyBatches: batches,
          candidates: await LocalMergeCandidates.open(ctx.owner, ctx.objects, ctx.versions, helper),
        });
        let commits = 0;
        let loseResponse = false;
        const state = {
          compareAndCommit: async (...args: Parameters<typeof ctx.store.compareAndCommit>) => {
            commits++;
            const result = await ctx.store.compareAndCommit(...args);
            if (loseResponse) throw Error('fixture_lost_second_response');
            return result;
          },
        };
        const service = () =>
          new LocalIntegrationPublication({ ...ctx, ...setup, candidates, batches, state });
        const first = { call: setup.call, actionId: 'cumulative-first' };
        const second = { call: setup.call, actionId: 'cumulative-second' };
        const before = await ctx.control.assertClosed(ctx.scope);
        const userHead = f.git(['rev-parse', 'HEAD']);
        const userIndex = readFileSync(join(f.root, '.git/index'));
        const firstReceipt = await service().applyNext(first);
        await service().acknowledgePublished(first);
        const firstProof = await readCompletedApplication(ctx.objects, first);
        const secondReceipt = await service().applyNext(second);
        expect(secondReceipt.publication.previousCommit).toBe(firstReceipt.publication.commit);
        for (let i = 0; i < 2; i++)
          expect(readFileSync(join(setup.physical.path, `result-${i}.txt`), 'utf8')).toBe(
            `worker ${i}\n`,
          );
        loseResponse = true;
        await expect(service().acknowledgePublished(second)).rejects.toThrow(
          'fixture_lost_second_response',
        );
        loseResponse = false;
        await expect(service().acknowledgePublished(second)).resolves.toEqual(secondReceipt);
        expect(commits).toBe(2);
        const after = await ctx.control.assertClosed(ctx.scope);
        expect(after.integration?.mergedBranches.map((b) => b.mergeCommit)).toEqual([
          firstReceipt.publication.commit,
          secondReceipt.publication.commit,
        ]);
        expect(after.integration?.status).toBe('merging');
        expect(after.integration?.resultCommit).toBeUndefined();
        expect(after.workers).toEqual(before.workers);
        expect(after.subtasks).toEqual(before.subtasks);
        await expect(service().acknowledgePublished(first)).rejects.toThrow();
        await expect(service().applyNext(first)).rejects.toThrow();
        const secondProof = await readCompletedApplication(ctx.objects, second);
        expect(secondProof.prepared.candidate.targetVersion).toEqual(firstReceipt.version);
        expect(secondProof.prepared.candidate.predecessor).toEqual({
          inputHash: firstProof.inputHash,
          resultHash: firstProof.resultHash,
          confirmationHash: await ctx.objects.getReference(
            applicationPhase(firstProof.key, 'state-confirmed'),
          ),
        });
        for (let i = 0; i < 2; i++) {
          expect(readFileSync(join(setup.physical.path, `worker-${i}`, 'nested.txt'), 'utf8')).toBe(
            `nested ${i}\n`,
          );
          expect(readdirSync(join(setup.physical.path, `worker-${i}`, 'empty'))).toEqual([]);
        }
        const rejectedEvidence: string[] = [];
        const refuseMissing = async (path: string, check: () => Promise<unknown>, name: string) => {
          renameSync(path, `${path}.held`);
          try {
            await expect(check()).rejects.toThrow();
            rejectedEvidence.push(name);
          } finally {
            renameSync(`${path}.held`, path);
          }
        };
        const nativeItem = firstProof.effects.applied.items[0];
        if (!nativeItem) throw Error('missing historical native item');
        const item = (await ctx.objects.get(nativeItem.recordHash)) as {
          native: { journalPath: string };
        };
        await refuseMissing(
          join(item.native.journalPath, 'result.json'),
          () => batches.readHistorical(first, second),
          'native journal',
        );
        const gitReceipt = readdirSync(f.privateRoot)
          .filter((n) => n.endsWith('.publish-completed.json'))
          .find(
            (n) =>
              JSON.parse(readFileSync(join(f.privateRoot, n), 'utf8')).receipt.commit ===
              firstReceipt.publication.commit,
          );
        if (!gitReceipt) throw Error('missing historical publication');
        await refuseMissing(
          join(f.privateRoot, gitReceipt),
          () => candidates.readConfirmedPrefix(setup.call, second),
          'Git publication',
        );
        await expect(
          setup.authority.readHistoricalSelection(
            { ...first, call: { ...first.call, integrationId: 'foreign-integration' } },
            second,
          ),
        ).rejects.toThrow();
        const refs = await ctx.objects.references();
        const path = join(
          ctx.owner.root,
          'local-workspaces/objects',
          `${applicationPhase(firstProof.key, 'completion')}.ref`,
        );
        renameSync(path, `${path}.held`);
        try {
          await expect(service().acknowledgePublished(second)).rejects.toThrow();
        } finally {
          renameSync(`${path}.held`, path);
        }
        await expect(service().acknowledgePublished(second)).resolves.toEqual(secondReceipt);
        expect(await ctx.objects.references()).toEqual(refs);
        expect(commits).toBe(2);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
        writeFileSync(
          join(f.privateRoot, 'cumulative-publication-proof.json'),
          JSON.stringify({
            firstProof,
            secondProof: await readCompletedApplication(ctx.objects, second),
            state: after,
            references: refs,
            commits,
            userHead,
            userIndexUnchanged: true,
            rejectedEvidence,
            cumulativeDirectories: true,
          }),
        );
      },
      true,
    ),
  );
}, 1_800_000);
