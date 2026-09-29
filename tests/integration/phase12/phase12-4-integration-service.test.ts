// Real IntegrationService, native files, Git and State. Only commit response loss is injected.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IntegrationService } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { readConfirmedApplicationPrefix } from '../../../packages/runtime/sandbox/src/local-integration-application-records';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationCompletion } from '../../../packages/runtime/sandbox/src/local-integration-completion';
import {
  completionKey,
  readIntegrationCompletionPlan,
} from '../../../packages/runtime/sandbox/src/local-integration-completion-records';
import { LocalIntegrationProgress } from '../../../packages/runtime/sandbox/src/local-integration-progress';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it('completes a real native IntegrationService wave and recovers both uncertain State transitions', async () => {
  await fixture(async (f) =>
    registeredFixture(
      f,
      async (ctx) => {
        const setup = await completedIntegration(ctx, {
          canonicalPlan: true,
          seedDirectories: true,
        });
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
        const state = {
          compareAndCommit: async (...args: Parameters<typeof ctx.store.compareAndCommit>) => {
            const result = await ctx.store.compareAndCommit(...args);
            commits++;
            if (commits === 2 || commits === 3) throw Error(`fixture_lost_response_${commits}`);
            return result;
          },
        };
        const completion = () =>
          new LocalIntegrationCompletion({ ...ctx, ...setup, candidates, state });
        const service = () =>
          IntegrationService.withProgress(
            new LocalIntegrationProgress({
              ...ctx,
              ...setup,
              completion: completion(),
              publication: new LocalIntegrationPublication({
                ...ctx,
                ...setup,
                candidates,
                batches,
                state,
              }),
            }),
          );
        const input = {
          waveId: setup.wave.waveId,
          workerIds: setup.wave.coderWorkerIds,
          baseBranch: setup.wave.base.branch,
        };
        const before = await ctx.control.assertClosed(ctx.scope);
        const head = f.git(['rev-parse', 'HEAD']),
          index = readFileSync(join(f.root, '.git/index'));
        await expect(service().integrateWave(before, input)).rejects.toThrow(
          'fixture_lost_response_2',
        );
        const merged = await ctx.control.assertClosed(ctx.scope);
        expect(merged.integration?.mergedBranches).toHaveLength(2);
        expect(merged.integration?.status).toBe('merging');
        await expect(service().integrateWave(merged, input)).rejects.toThrow(
          'fixture_lost_response_3',
        );
        const uncertain = await ctx.control.assertClosed(ctx.scope);
        expect(uncertain.integration?.status).toBe('done');
        expect(
          await ctx.objects.getReference(completionKey(setup.call, 'confirmed')),
        ).toBeUndefined();
        await expect(completion().read(setup.call)).rejects.toThrow();
        const result = await service().integrateWave(uncertain, input);
        expect(result.state).toEqual(uncertain);
        expect(commits).toBe(3);
        expect(result.state.integration?.resultCommit).toBe(
          result.state.integration?.mergedBranches.at(-1)?.mergeCommit,
        );
        expect(result.state.workers).toEqual(before.workers);
        expect(result.state.subtasks).toEqual(before.subtasks);
        for (let i = 0; i < 2; i++) {
          expect(readFileSync(join(setup.physical.path, `result-${i}.txt`), 'utf8')).toBe(
            `worker ${i}\n`,
          );
          expect(readFileSync(join(setup.physical.path, `worker-${i}/nested.txt`), 'utf8')).toBe(
            `nested ${i}\n`,
          );
        }
        const proof = await readIntegrationCompletionPlan(ctx.objects, setup.call, result.state);
        expect(proof.confirmed).toBeTypeOf('string');
        expect(proof.plan.applications).toHaveLength(2);
        await expect(setup.authority.assertCall(setup.call, 'read')).rejects.toThrow(
          'integration_assignment_mismatch',
        );
        await expect(
          setup.authority.completionReader(setup.call).assertCall(setup.call, 'edit'),
        ).rejects.toThrow('integration_completion_read_only');
        const reader = setup.authority.completionReader(setup.call);
        await expect(reader.release(setup.call)).rejects.toThrow(
          'integration_completion_read_only',
        );
        await expect(
          reader.readCheckpoint({ ...setup.call, workspaceId: 'foreign' }),
        ).rejects.toThrow();
        await expect(
          reader.acquire({
            ...ctx.scope,
            actionId: 'forbidden',
            workspaceId: setup.call.workspaceId,
            integrationId: setup.call.integrationId,
            expectedRevision: (await ctx.control.snapshot()).revision,
          }),
        ).rejects.toThrow('integration_completion_read_only');
        const prefix = await readConfirmedApplicationPrefix(ctx.objects, proof.before, setup.call);
        const item = prefix.at(-1)?.effects.applied.items[0];
        if (!item) throw Error('missing original native proof');
        const native = (await ctx.objects.get(item.recordHash)) as {
          native: { journalPath: string };
        };
        const journal = join(native.native.journalPath, 'result.json');
        renameSync(journal, `${journal}.held`);
        try {
          await expect(completion().read(setup.call)).rejects.toThrow();
        } finally {
          renameSync(`${journal}.held`, journal);
        }
        const path = join(
          ctx.owner.root,
          'local-workspaces/objects',
          `${completionKey(setup.call, 'plan')}.ref`,
        );
        renameSync(path, `${path}.held`);
        try {
          await expect(service().integrateWave(result.state, input)).rejects.toThrow();
        } finally {
          renameSync(`${path}.held`, path);
        }
        const refs = await ctx.objects.references();
        expect((await service().integrateWave(result.state, input)).state).toEqual(result.state);
        expect(await ctx.objects.references()).toEqual(refs);
        expect(commits).toBe(3);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
        writeFileSync(
          join(f.privateRoot, 'integration-service-proof.json'),
          JSON.stringify({
            before,
            state: result.state,
            proof,
            commits,
            userHead: head,
            userIndexUnchanged: true,
            missingCompletionRejected: true,
            missingNativeHistoryRejected: true,
          }),
        );
      },
      true,
    ),
  );
}, 2_400_000);
