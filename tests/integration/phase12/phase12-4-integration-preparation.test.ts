// Real completed CODER worktrees, registry, Git and State. Only response loss is injected.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setMutation } from '@agora/core-domain';
import { planIntegrationWave } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import {
  integrationPreparationKey,
  LocalIntegrationPreparation,
} from '../../../packages/runtime/sandbox/src/local-integration-preparation';
import { LocalIntegrationSources } from '../../../packages/runtime/sandbox/src/local-integration-sources';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedCoders } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it('prepares the canonical first wave and recovers an uncertain preparation without another CAS', async () => {
  await fixture(async (f) =>
    registeredFixture(
      f,
      async (ctx) => {
        let loseClaimResponse = true;
        const setup = await completedCoders(ctx, {
          assertControl: async () => {
            if (
              loseClaimResponse &&
              (await ctx.control.snapshot()).claims.some((c) => c.kind === 'integration')
            ) {
              loseClaimResponse = false;
              throw Error('fixture_lost_claim_response');
            }
          },
        });
        const before = await ctx.control.assertClosed(ctx.scope);
        expect(before.integration).toBeUndefined();
        const head = f.git(['rev-parse', 'HEAD']),
          index = readFileSync(join(f.root, '.git/index'));
        const wave = planIntegrationWave(before, {
          waveId: setup.wave.waveId,
          workerIds: setup.wave.coderWorkerIds,
          baseBranch: setup.wave.base.branch,
        });
        const request = {
          ...ctx.scope,
          actionId: 'prepare-first-wave',
          workspaceId: 'integration',
          registration: {
            ...ctx.request,
            targets: [{ workspaceId: 'integration', purpose: 'integration' as const }],
          },
        };
        let commits = 0;
        const service = (preparedRequest = request) =>
          new LocalIntegrationPreparation({
            ...ctx,
            request: preparedRequest,
            workspaces: setup.manager,
            authority: setup.authority,
            assertControl: async () => {
              await ctx.control.assertClosed(ctx.scope);
            },
            state: {
              compareAndCommit: async (...args: Parameters<typeof ctx.store.compareAndCommit>) => {
                const result = await ctx.store.compareAndCommit(...args);
                commits++;
                if (commits === 1) throw Error('fixture_lost_preparation_response');
                return result;
              },
            },
          });
        await expect(
          service().prepare(before, { ...wave, integrationId: 'integration-foreign' }),
        ).rejects.toThrow('integration_preparation_mismatch');
        await expect(
          service({
            ...request,
            registration: { ...request.registration, actionId: 'missing' },
          }).prepare(before, wave),
        ).rejects.toThrow('integration_preparation_registration_missing');
        await expect(service().prepare(before, wave)).rejects.toThrow(
          'fixture_lost_preparation_response',
        );
        const uncertain = await ctx.control.assertClosed(ctx.scope);
        expect(uncertain.phase).toBe('integrating');
        expect(uncertain.integration?.integrationId).toBe(wave.integrationId);
        expect(uncertain.integration?.mergedBranches).toEqual([]);
        expect(
          (await ctx.control.snapshot()).claims.filter((c) => c.kind === 'integration'),
        ).toHaveLength(0);
        const originalPlan = await ctx.objects.getReference(
          integrationPreparationKey(request, request.actionId, 'plan'),
        );
        expect(originalPlan).toBeTypeOf('string');
        await expect(service().prepare(uncertain, wave)).rejects.toThrow(
          'fixture_lost_claim_response',
        );
        const claimBound = await ctx.control.assertClosed(ctx.scope);
        expect(
          (await ctx.control.snapshot()).claims.filter((c) => c.kind === 'integration'),
        ).toHaveLength(1);
        expect(
          await ctx.objects.getReference(
            integrationPreparationKey(request, request.actionId, 'confirmed'),
          ),
        ).toBeUndefined();
        const prepared = await service().prepare(claimBound, wave);
        expect(commits).toBe(1);
        await expect(
          service({ ...request, actionId: 'another-preparation' }).prepare(prepared.state, wave),
        ).rejects.toThrow('operation_conflict');
        const planPath = join(
          ctx.owner.root,
          'local-workspaces/objects',
          `${integrationPreparationKey(request, request.actionId, 'plan')}.ref`,
        );
        renameSync(planPath, `${planPath}.held`);
        try {
          await expect(service().prepare(prepared.state, wave)).rejects.toThrow(
            'operation_conflict',
          );
        } finally {
          renameSync(`${planPath}.held`, planPath);
        }
        expect(prepared.state.workers).toEqual(before.workers);
        expect(prepared.state.subtasks).toEqual(before.subtasks);
        expect(prepared.state.messages).toEqual(before.messages);
        expect(prepared.state.integration?.pendingBranches).toEqual(wave.pendingBranches);
        const snapshot = await ctx.control.snapshot(),
          refs = await ctx.objects.references();
        const sources = new LocalIntegrationSources({ ...setup, workspaces: setup.manager });
        const source = await sources.readNext(prepared.call);
        expect(source.selection.branch.workerId).toBe(wave.pendingBranches[0]?.workerId);
        expect(await service().prepare(prepared.state, wave)).toEqual(prepared);
        expect(await ctx.control.snapshot()).toEqual(snapshot);
        expect(await ctx.objects.references()).toEqual(refs);
        expect(commits).toBe(1);
        await ctx.store.commit(ctx.scope, [
          setMutation('iterationCount', before.iterationCount + 1),
        ]);
        await expect(
          service().prepare(await ctx.control.assertClosed(ctx.scope), wave),
        ).rejects.toThrow('integration_preparation_state_changed');
        expect(commits).toBe(1);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
        writeFileSync(
          join(f.privateRoot, 'integration-preparation-proof.json'),
          JSON.stringify({
            before,
            claimBound,
            uncertain,
            prepared,
            planHash: originalPlan,
            commits,
            lostClaimResponseRecovered: !loseClaimResponse,
            sourceWorkerId: source.selection.branch.workerId,
            userHead: head,
            refs,
          }),
        );
      },
      true,
    ),
  );
}, 900_000);
