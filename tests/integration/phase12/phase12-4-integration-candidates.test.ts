// Real local grants, completed Git workers and native candidates. Canonical
// lifecycle facts and post-publication control changes are fixture-owned.
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setMutation } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it.each(['normal', 'publication-drift'] as const)(
  'binds a private candidate to canonical completed sources: %s',
  async (scenario) =>
    fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          let invalidatePublication = scenario === 'publication-drift';
          const key = localRecordHash({
            kind: 'integration-candidate',
            ...ctx.scope,
            actionId: 'prepare-next',
          });
          const phase = (stage: string) =>
            localRecordHash({ kind: 'integration-candidate', key, stage });
          const setup = await completedIntegration(ctx, {
            assertControl: async () => {
              if (!invalidatePublication || !(await ctx.objects.getReference(phase('completion'))))
                return;
              invalidatePublication = false;
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
          });
          writeFileSync(join(f.root, 'user-later.txt'), 'user commit after completion\n');
          f.git(['-C', f.root, 'add', 'user-later.txt']);
          f.git(['-C', f.root, 'commit', '-m', 'Advance user checkout']);
          const userHead = f.git(['-C', f.root, 'rev-parse', 'HEAD']);
          const userIndex = readFileSync(join(f.root, '.git/index'));
          const candidates = new LocalIntegrationCandidates({
            ...ctx,
            ...setup,
            candidates: await LocalMergeCandidates.open(
              ctx.owner,
              ctx.objects,
              ctx.versions,
              resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
            ),
          });
          const request = { call: setup.call, actionId: 'prepare-next' };
          const before = await ctx.control.assertClosed(ctx.scope);
          if (scenario === 'publication-drift') {
            await expect(candidates.prepareNext(request)).rejects.toThrow(
              'integration_selection_changed',
            );
            const invalid = await ctx.objects.getReference(phase('invalid'));
            expect(invalid).toBeDefined();
            expect(await ctx.objects.getReference(phase('completion'))).toBeDefined();
            await ctx.store.commit(ctx.scope, [
              setMutation('parallelExecution', before.parallelExecution),
            ]);
            await expect(candidates.prepareNext(request)).rejects.toThrow(
              'integration_candidate_recovery_required',
            );
            expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(
              setup.target.baseCommit,
            );
            expect(f.git(['-C', f.root, 'rev-parse', 'HEAD'])).toBe(userHead);
            expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
            writeFileSync(
              join(f.privateRoot, 'canonical-candidate-proof.json'),
              JSON.stringify({
                scenario,
                invalid,
                postPublicationChangeRejected: true,
                restoredControlStillRejected: true,
                targetHead: setup.target.baseCommit,
                userHead,
                unchangedUserIndex: true,
              }),
            );
            return;
          }
          const originalRefs = await ctx.objects.references();
          mkdirSync(join(setup.physical.path, 'unbound-empty'));
          await expect(candidates.prepareNext(request)).rejects.toThrow(
            'integration_target_changed',
          );
          expect(await ctx.objects.references()).toEqual(originalRefs);
          rmdirSync(join(setup.physical.path, 'unbound-empty'));
          const result = await candidates.prepareNext(request);
          expect(result.sources.selection.position).toBe(0);
          expect(result.candidate.candidate.targetHead).toBe(setup.target.baseCommit);
          expect(result.candidate.candidate.sourceHead).toBe(
            result.sources.source.worktree.headCommit,
          );
          expect(readFileSync(join(result.candidate.binding.root, 'result-0.txt'), 'utf8')).toBe(
            'worker 0\n',
          );
          expect(result.candidate.candidate.result.kind).toBe('merged');
          const refs = await ctx.objects.references();
          expect(await candidates.prepareNext(request)).toEqual(result);
          expect(await ctx.objects.references()).toEqual(refs);
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
          const completionPath = join(
            ctx.owner.root,
            'local-workspaces/objects',
            `${phase('completion')}.ref`,
          );
          renameSync(completionPath, `${completionPath}.held`);
          try {
            await expect(candidates.prepareNext(request)).rejects.toThrow(
              'integration_candidate_recovery_required',
            );
          } finally {
            renameSync(`${completionPath}.held`, completionPath);
          }
          expect(await ctx.objects.references()).toEqual(refs);

          expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(
            setup.target.baseCommit,
          );
          expect(f.git(['-C', setup.physical.path, 'status', '--porcelain'])).toBe('');
          expect(f.git(['-C', f.root, 'rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
          const execution = before.parallelExecution;
          if (!execution?.activeWave) throw Error('missing wave');
          await ctx.store.commit(ctx.scope, [
            setMutation('parallelExecution', {
              ...execution,
              activeWave: { ...execution.activeWave, attempt: execution.activeWave.attempt + 1 },
            }),
          ]);
          await expect(candidates.prepareNext(request)).rejects.toThrow();
          expect(await ctx.objects.references()).toEqual(refs);
          writeFileSync(
            join(f.privateRoot, 'canonical-candidate-proof.json'),
            JSON.stringify({
              scenario,
              result,
              unboundEmptyDirectoryRejected: true,
              missingCompletionRejected: true,
              stateHash: localRecordHash(before),
              unchangedState: true,
              targetHead: setup.target.baseCommit,
              userHead,
              unchangedUserIndex: true,
              replayIdentical: true,
              changedSelectionRejected: true,
            }),
          );
        },
        true,
      ),
    ),
  300_000,
);
