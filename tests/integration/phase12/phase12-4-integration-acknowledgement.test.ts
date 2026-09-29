// Real native files, Git and canonical State. Fault injection wraps actual persistence;
// it never substitutes the workspace backend or asserts product orchestration G5.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendMutation } from '@agora/core-domain';
import { expect, it } from 'vitest';
import {
  applicationPhase,
  readCompletedApplication,
} from '../../../packages/runtime/sandbox/src/local-integration-application-records';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { completedIntegration } from './local-completed-integration-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it.each(['uncertain-commit', 'late-invalid'] as const)(
  'confirms completed publication without replaying effects: %s',
  async (scenario) => {
    expect(LocalIntegrationPublication.prototype.acknowledgePublished).toBeTypeOf('function');
    await fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          let stopKey = '';
          let stop = false;
          const setup = await completedIntegration(ctx, {
            assertControl: async () => {
              if (stop && (await ctx.objects.getReference(stopKey)))
                throw Error('fixture_confirmation_stopped');
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
          let commits = 0;
          let fail = scenario === 'uncertain-commit';
          const state = {
            compareAndCommit: async (...args: Parameters<typeof ctx.store.compareAndCommit>) => {
              commits++;
              const result = await ctx.store.compareAndCommit(...args);
              if (fail) throw Error('fixture_lost_commit_response');
              return result;
            },
          };
          const service = () =>
            new LocalIntegrationPublication({ ...ctx, ...setup, candidates, batches, state });
          const request = { call: setup.call, actionId: 'acknowledge-first' };
          const before = await ctx.control.assertClosed(ctx.scope);
          const userHead = f.git(['rev-parse', 'HEAD']);
          const userIndex = readFileSync(join(f.root, '.git/index'));
          const receipt = await service().applyNext(request);
          await expect(
            service().acknowledgePublished({ ...request, actionId: 'unknown' }),
          ).rejects.toThrow();
          const proof = await readCompletedApplication(ctx.objects, request);
          if (scenario === 'late-invalid') {
            stopKey = applicationPhase(proof.key, 'state-confirmed');
            stop = true;
            await expect(service().acknowledgePublished(request)).rejects.toThrow(
              'fixture_confirmation_stopped',
            );
            stop = false;
            expect(
              await ctx.objects.getReference(applicationPhase(proof.key, 'state-invalid')),
            ).toBeTypeOf('string');
            await expect(service().acknowledgePublished(request)).rejects.toThrow(
              'integration_application_recovery_required',
            );
            await expect(setup.authority.assertCall(setup.call, 'edit')).rejects.toThrow();
            expect(commits).toBe(1);
            expect(
              (await ctx.control.assertClosed(ctx.scope)).integration?.mergedBranches,
            ).toHaveLength(1);
            expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
            expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
            writeFileSync(
              join(f.privateRoot, 'integration-acknowledgement-proof.json'),
              JSON.stringify({
                scenario,
                request,
                receipt,
                commits,
                lateFailureInvalidated: true,
                originalStateHash: localRecordHash(before),
                proof,
                state: await ctx.control.assertClosed(ctx.scope),
                references: await ctx.objects.references(),
              }),
            );
            return;
          }
          await expect(service().acknowledgePublished(request)).rejects.toThrow(
            'fixture_lost_commit_response',
          );
          const after = await ctx.control.assertClosed(ctx.scope);
          expect(after.integration?.mergedBranches).toEqual([
            {
              workerId: setup.integration.pendingBranches[0]?.workerId,
              subtaskId: setup.integration.pendingBranches[0]?.subtaskId,
              branch: setup.integration.pendingBranches[0]?.worktree.branch,
              headCommit: setup.integration.pendingBranches[0]?.worktree.headCommit,
              mergeCommit: receipt.publication.commit,
            },
          ]);
          expect(after.integration?.integrationWorktree.headCommit).toBe(
            receipt.publication.commit,
          );
          expect(after.integration?.status).toBe('merging');
          expect(after.integration?.resultCommit).toBeUndefined();
          expect(after.workers).toEqual(before.workers);
          await expect(setup.authority.assertCall(setup.call, 'edit')).rejects.toThrow();
          fail = false;
          await expect(service().acknowledgePublished(request)).resolves.toEqual(receipt);
          expect(commits).toBe(1);
          await setup.authority.assertCall(setup.call, 'read');
          const refs = await ctx.objects.references();
          const completionPath = join(
            ctx.owner.root,
            'local-workspaces/objects',
            `${applicationPhase(proof.key, 'completion')}.ref`,
          );
          renameSync(completionPath, `${completionPath}.held`);
          try {
            await expect(service().acknowledgePublished(request)).rejects.toThrow(
              'integration_application_recovery_required',
            );
          } finally {
            renameSync(`${completionPath}.held`, completionPath);
          }
          await expect(service().acknowledgePublished(request)).resolves.toEqual(receipt);
          expect(await ctx.objects.references()).toEqual(refs);
          expect(commits).toBe(1);
          await expect(service().applyNext(request)).rejects.toThrow(
            'integration_application_recovery_required',
          );
          expect(f.git(['-C', setup.physical.path, 'rev-parse', 'HEAD'])).toBe(
            receipt.publication.commit,
          );
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
          await ctx.store.commit(ctx.scope, [
            appendMutation('messages', {
              msgId: 'later-control',
              channelId: 'main',
              fromRole: 'leader',
              type: 'chat',
              payload: {},
              display: 'later control',
              ts: 1,
            }),
          ]);
          await expect(service().acknowledgePublished(request)).rejects.toThrow();
          expect(commits).toBe(1);
          writeFileSync(
            join(f.privateRoot, 'integration-acknowledgement-proof.json'),
            JSON.stringify({
              scenario,
              request,
              receipt,
              proof,
              state: after,
              references: refs,
              beforeHash: localRecordHash(before),
              afterHash: localRecordHash(after),
              uncertainCommitRecovered: true,
              exactReplayReadOnly: true,
              missingPublicationRejected: true,
              commits,
              workersUnchanged: true,
              userHead,
              userIndexUnchanged: true,
            }),
          );
        },
        true,
      ),
    );
  },
  900_000,
);
