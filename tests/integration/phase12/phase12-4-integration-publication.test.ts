// Real canonical workers, native tree effects and Git publication.
// Lifecycle facts are fixture-owned; this is not product orchestration G5.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectIntegrationBranch } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it.each(['normal', 'interrupted', 'late-invalid'] as const)(
  'binds canonical tree effects to exact publication without acknowledging State: %s',
  async (scenario) => {
    expect(LocalIntegrationPublication.prototype.applyNext).toBeTypeOf('function');
    await fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          let stop = false;
          let stopKey = '';
          const injection = { calls: 0, elapsedMs: 0, maxMs: 0 };
          const setup = await completedIntegration(ctx, {
            assertControl: async () => {
              if (!stop) return;
              const started = performance.now();
              try {
                if (await ctx.objects.getReference(stopKey)) throw Error('fixture_control_stopped');
              } finally {
                const duration = performance.now() - started;
                injection.calls++;
                injection.elapsedMs += duration;
                injection.maxMs = Math.max(injection.maxMs, duration);
              }
            },
          });
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
          const publication = new LocalIntegrationPublication({
            ...ctx,
            ...setup,
            candidates,
            batches,
          });
          const request = { call: setup.call, actionId: 'apply-first-source' };
          const original = await ctx.control.assertClosed(ctx.scope);
          const registry = await ctx.control.snapshot();
          const userHead = f.git(['rev-parse', 'HEAD']);
          const userIndex = readFileSync(join(f.root, '.git/index'));
          const targetHead = f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD']);
          const targetIndex = f.git(['-C', setup.physical.path, 'write-tree']);
          const selection = selectIntegrationBranch(original, setup.call.integrationId);
          const slot = localRecordHash({
            kind: 'integration-application',
            ...ctx.scope,
            workspaceId: setup.call.workspaceId,
            integrationId: setup.call.integrationId,
            waveId: selection.waveId,
            attempt: selection.attempt,
            position: selection.position,
          });
          stopKey = localRecordHash({
            kind: 'integration-application',
            key: slot,
            stage: scenario === 'late-invalid' ? 'completion' : 'effects',
          });
          stop = scenario !== 'normal';
          let receipt: Awaited<ReturnType<LocalIntegrationPublication['applyNext']>> | null = null;
          if (stop) {
            await expect(
              publication.applyNext(request).catch((error) => {
                writeFileSync(
                  join(f.privateRoot, 'injection-diagnostic.json'),
                  JSON.stringify({
                    injection,
                    error: error instanceof Error ? error.stack : String(error),
                  }),
                );
                throw error;
              }),
            ).rejects.toThrow('fixture_control_stopped');
            stop = false;
            if (scenario === 'interrupted') {
              expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(targetHead);
              expect(f.git(['-C', setup.physical.path, 'write-tree'])).toBe(targetIndex);
            }
          } else {
            receipt = await publication.applyNext(request);
            expect(receipt.publication.previousCommit).toBe(targetHead);
            expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(
              receipt.publication.commit,
            );
            expect(f.git(['-C', setup.physical.path, 'write-tree'])).toBe(receipt.publication.tree);
            const parents = f
              .git(['-C', setup.physical.path, 'show', '-s', '--format=%P', 'HEAD'])
              .split(' ');
            expect(parents).toEqual([
              targetHead,
              setup.integration.pendingBranches[0]?.worktree.headCommit,
            ]);
            expect(receipt.version.kind).toBe('git');
            if (receipt.version.kind !== 'git') throw Error('missing Git version');
            expect(receipt.version.commit).toBe(receipt.publication.commit);
            await expect(setup.authority.assertCall(setup.call, 'edit')).rejects.toThrow();
          }
          const refs = await ctx.objects.references();
          const effects = [];
          const applications = [];
          for (const ref of refs) {
            const value = (await ctx.objects.get(ref.valueHash)) as { schemaVersion?: string };
            if (value.schemaVersion?.startsWith('local-integration-application-'))
              applications.push({ ...ref, value });
            if (value.schemaVersion === 'local-integration-application-effects-v1')
              effects.push(value);
          }
          expect(effects).toHaveLength(1);
          const invalid = applications.filter(
            (r) => r.value.schemaVersion === 'local-integration-application-invalid-v1',
          );
          expect(invalid).toHaveLength(scenario === 'late-invalid' ? 1 : 0);
          if (scenario === 'late-invalid') {
            const saved = applications.find(
              (r) => r.value.schemaVersion === 'local-integration-application-result-v1',
            )?.value as typeof receipt;
            if (!saved) throw Error('missing invalidated result');
            expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(
              saved.publication.commit,
            );
            expect(f.git(['-C', setup.physical.path, 'write-tree'])).toBe(saved.publication.tree);
            expect(saved.publication.commit).not.toBe(targetHead);
            await expect(setup.authority.assertCall(setup.call, 'edit')).rejects.toThrow();
          }
          expect(readFileSync(join(setup.physical.path, 'result-0.txt'), 'utf8')).toBe(
            'worker 0\n',
          );
          await expect(publication.applyNext(request)).rejects.toThrow(
            'integration_application_recovery_required',
          );
          await expect(
            publication.applyNext({ ...request, actionId: 'different-action' }),
          ).rejects.toThrow('integration_application_recovery_required');
          expect(await ctx.objects.references()).toEqual(refs);
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(original);
          expect(await ctx.control.snapshot()).toEqual(registry);
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
          writeFileSync(
            join(f.privateRoot, 'integration-publication-proof.json'),
            JSON.stringify({
              scenario,
              request,
              receipt,
              applications,
              stateHash: localRecordHash(original),
              stateUnchanged: true,
              registryUnchanged: true,
              userHead,
              userIndexUnchanged: true,
              targetHeadBefore: targetHead,
              targetHeadAfter: f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD']),
              indexAfter: f.git(['-C', setup.physical.path, 'write-tree']),
              injection,
            }),
          );
        },
        true,
      ),
    );
  },
  600_000,
);
