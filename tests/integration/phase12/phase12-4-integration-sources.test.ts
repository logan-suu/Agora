// Real D17 dispatch, local grants, leases, native files, Git and persisted close evidence.
// Worker lifecycle facts and a deliberate concurrent control mutation are test-owned;
// they do not replace infrastructure or claim Harness/model completion coverage.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setMutation } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it(
  'reads only the next current wave completion and rejects a control change during the read',
  async () =>
    fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          let changeDuringRead = false;
          const { wave, integration, target, physical, call, sources } = await completedIntegration(
            ctx,
            {
              afterGrant: async () => {
                if (!changeDuringRead) return;
                changeDuringRead = false;
                const current = await ctx.control.assertClosed(ctx.scope);
                const execution = current.parallelExecution;
                if (!execution?.activeWave) throw Error('missing wave');
                await ctx.store.commit(ctx.scope, [
                  setMutation('parallelExecution', {
                    ...execution,
                    activeWave: {
                      ...execution.activeWave,
                      attempt: execution.activeWave.attempt + 1,
                    },
                  }),
                ]);
              },
            },
          );
          const before = await ctx.control.assertClosed(ctx.scope),
            refs = await ctx.objects.references();
          const result = await sources.readNext(call);
          expect(result.source.workerId).toBe(integration.pendingBranches[0]?.workerId);
          expect(result.source.worktree).toEqual(integration.pendingBranches[0]?.worktree);
          expect(result.selection.position).toBe(0);
          expect(result.baseline.baseCommit).toBe(result.selection.base.commit);
          expect(await ctx.objects.references()).toEqual(refs);
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
          expect(readFileSync(join(result.source.worktree.path, 'result-0.txt'), 'utf8')).toBe(
            'worker 0\n',
          );
          expect(f.git(['-C', physical.path, 'rev-parse', 'HEAD'])).toBe(target.baseCommit);
          await expect(sources.readNext({ ...call, integrationId: 'stale' })).rejects.toThrow();
          changeDuringRead = true;
          await expect(sources.readNext(call)).rejects.toThrow('integration_selection_changed');
          const changed = await ctx.control.assertClosed(ctx.scope);
          expect(changed.parallelExecution?.activeWave?.attempt).toBe(wave.attempt + 1);
          expect(await ctx.objects.references()).toEqual(refs);
          writeFileSync(
            join(f.privateRoot, 'integration-source-selection.json'),
            JSON.stringify({
              result,
              referencesUnchanged: true,
              stateUnchangedOnSuccess: true,
              concurrentControlRejected: true,
              targetHead: f.git(['-C', physical.path, 'rev-parse', 'HEAD']),
            }),
          );
        },
        true,
      ),
    ),
  180_000,
);
