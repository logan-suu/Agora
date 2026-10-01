// Real native workers, immutable Git merge, publication and conflict evidence.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IntegrationService } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationCompletion } from '../../../packages/runtime/sandbox/src/local-integration-completion';
import { LocalIntegrationConflictHandoff } from '../../../packages/runtime/sandbox/src/local-integration-conflict-handoff';
import { conflictKey } from '../../../packages/runtime/sandbox/src/local-integration-conflict-records';
import { LocalIntegrationProgress } from '../../../packages/runtime/sandbox/src/local-integration-progress';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { exerciseConflictRework } from './local-conflict-rework-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it.each(['evidence', 'rework'] as const)(
  'preserves the proven prefix and user checkout through native conflict: %s',
  async (scenario) => {
    await fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          let batches: LocalIntegrationTreeBatch;
          const setup = await completedIntegration(ctx, {
            verifyClosure: (claim) => batches.closure(claim),
            canonicalPlan: true,
            conflictingFile: true,
          });
          const helper = resolve(
            'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
          );
          batches = await LocalIntegrationTreeBatch.open(
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
            candidates: await LocalMergeCandidates.open(
              ctx.owner,
              ctx.objects,
              ctx.versions,
              helper,
            ),
          });
          const publication = new LocalIntegrationPublication({
            ...ctx,
            ...setup,
            candidates,
            batches,
            state: ctx.store,
          });
          const head = f.git(['rev-parse', 'HEAD']),
            index = readFileSync(join(f.root, '.git/index'));
          const request = { call: setup.call, actionId: 'first-contribution' };
          await publication.applyNext(request);
          await publication.acknowledgePublished(request);
          const before = await ctx.control.assertClosed(ctx.scope);
          const targetHead = f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD']);
          if (scenario === 'rework') {
            const service = IntegrationService.withProgress(
              new LocalIntegrationProgress({
                ...ctx,
                ...setup,
                publication,
                conflictHandoff: new LocalIntegrationConflictHandoff({
                  ...ctx,
                  ...setup,
                  publication,
                  batches,
                }),
                completion: new LocalIntegrationCompletion({
                  ...ctx,
                  ...setup,
                  candidates,
                  state: ctx.store,
                }),
              }),
            );
            const result = await service.integrateWave(before, {
              waveId: setup.wave.waveId,
              workerIds: setup.wave.coderWorkerIds,
              baseBranch: setup.wave.base.branch,
              now: 100,
            });
            await exerciseConflictRework({ ctx, setup, candidates, batches, result, f });
            expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
            expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
            return;
          }
          const conflictRequest = { call: setup.call, actionId: 'conflicting-contribution' };
          const result = await candidates.prepareOutcome(conflictRequest);
          expect(result.schemaVersion).toBe('local-integration-conflict-candidate-v1');
          if (result.schemaVersion !== 'local-integration-conflict-candidate-v1')
            throw Error('missing conflict');
          expect(result.conflict.result).toEqual({
            kind: 'conflict',
            source: 'git',
            paths: ['shared-result.txt'],
          });
          expect(result.sources.selection.position).toBe(1);
          const refs = await ctx.objects.references();
          expect(await candidates.prepareOutcome(conflictRequest)).toEqual(result);
          expect(await ctx.objects.references()).toEqual(refs);
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
          expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(targetHead);
          expect(readFileSync(join(setup.physical.path, 'shared-result.txt'), 'utf8')).toBe(
            'worker 0\n',
          );
          expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
          let lost = false;
          const state = {
            compareAndCommit: async (...args: Parameters<typeof ctx.store.compareAndCommit>) => {
              const committed = await ctx.store.compareAndCommit(...args);
              if (!lost) {
                lost = true;
                throw Error('fixture_lost_conflict_response');
              }
              return committed;
            },
          };
          const conflictPublication = new LocalIntegrationPublication({
            ...ctx,
            ...setup,
            candidates,
            batches,
            state,
          });
          const service = IntegrationService.withProgress(
            new LocalIntegrationProgress({
              ...ctx,
              ...setup,
              publication: conflictPublication,
              conflictHandoff: new LocalIntegrationConflictHandoff({
                ...ctx,
                ...setup,
                publication: conflictPublication,
                batches,
              }),
              completion: new LocalIntegrationCompletion({ ...ctx, ...setup, candidates, state }),
            }),
          );
          const input = {
            waveId: setup.wave.waveId,
            workerIds: setup.wave.coderWorkerIds,
            baseBranch: setup.wave.base.branch,
            now: 100,
          };
          await expect(service.integrateWave(before, input)).rejects.toThrow(
            'fixture_lost_conflict_response',
          );
          const uncertain = await ctx.control.assertClosed(ctx.scope);
          expect(uncertain.integration?.status).toBe('conflict');
          expect(
            await ctx.objects.getReference(conflictKey(setup.call, 'confirmed')),
          ).toBeUndefined();
          const recovered = await service.integrateWave(uncertain, input);
          expect({ ...recovered.state, localExecution: uncertain.localExecution }).toEqual(
            uncertain,
          );
          expect(
            (await ctx.control.snapshot()).claims.find((c) => c.claimId === setup.call.claimId)
              ?.status,
          ).toBe('released');
          expect(recovered.gateRequest).toMatchObject({
            reason: `integration_conflict:${setup.call.integrationId}`,
            options: ['request_rework'],
          });
          expect(recovered.state.integration?.mergedBranches).toEqual(
            before.integration?.mergedBranches,
          );
          expect(recovered.state.workers).toEqual(before.workers);
          const planPath = join(
            ctx.owner.root,
            'local-workspaces/objects',
            `${conflictKey(setup.call, 'plan')}.ref`,
          );
          renameSync(planPath, `${planPath}.held`);
          try {
            await expect(service.integrateWave(recovered.state, input)).rejects.toThrow();
          } finally {
            renameSync(`${planPath}.held`, planPath);
          }
          const confirmedRefs = await ctx.objects.references();
          expect(await service.integrateWave(recovered.state, input)).toEqual(recovered);
          expect(await ctx.objects.references()).toEqual(confirmedRefs);
          await expect(
            setup.authority.conflictReader(setup.call).assertCall(setup.call, 'edit'),
          ).rejects.toThrow('integration_completion_read_only');
          expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(targetHead);
          expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
          writeFileSync(
            join(f.privateRoot, 'native-conflict-proof.json'),
            JSON.stringify({
              result,
              before,
              targetHead,
              userHead: head,
              userIndexUnchanged: true,
            }),
          );
        },
        true,
      ),
    );
  },
  2_400_000,
);
