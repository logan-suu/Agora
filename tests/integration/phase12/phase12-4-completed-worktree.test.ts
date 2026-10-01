// Real grant, scheduler lease, session, native writes, Git commit and close evidence.
// Worker lifecycle commits are explicit fixture control facts, not a Harness/model G5.
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeByIdMutation } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { fixture, hash } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it.each(['normal', 'user-advanced', 'missing-close', 'missing-completion', 'missing-git'] as const)(
  'reads only a closed canonical worker version: %s',
  async (scenario) =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const manager = new LocalGitWorkspaces(ctx);
        await manager.registerInitial(ctx.request);
        const worktree = await manager.resolveAssignment({ ...ctx.scope, workerId: 'coder' });
        const sessions = await LocalWorkspaceSessions.create({
          ...ctx,
          filesHelper: resolve(
            'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
          ),
          grantForAssignment: async () => ctx.grant.grantId,
        });
        const scheduler = new GlobalScheduler();
        const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'coder');
        try {
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', 'coder', {
              status: 'running',
              sessionId: 'completion-session',
              worktree,
            }),
          ]);
          const session = await sessions.open({
            ...ctx.scope,
            workerId: 'coder',
            role: 'CODER',
            subtaskId: 'code',
            sessionId: 'completion-session',
            assertLease: () => scheduler.assertActive(lease),
          });
          const scope = { ...ctx.scope, workerId: 'coder' };
          await expect(sessions.readCompletedWorktree(scope)).rejects.toThrow(
            'workspace_completion_unavailable',
          );
          const file = await session.tools.read(`tool:${hash('completion-read')}`, 'result.txt');
          await session.tools.apply(
            `tool:${hash('completion-write')}`,
            [
              {
                path: 'result.txt',
                expected: file.version,
                readReceiptId: file.readReceiptId,
                content: 'fixed result\n',
                encoding: 'utf8',
              },
            ],
            [],
          );
          await session.checkpoint('complete');
          if (!session.completeWorktree) throw Error('missing completion');
          const completed = await session.completeWorktree();
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', 'coder', { worktree: completed }),
          ]);
          await session.close();
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', 'coder', { status: 'done' }),
          ]);
          await scheduler.release(lease);
          const before = await ctx.control.assertClosed(ctx.scope);
          const refs = await ctx.objects.references();
          const originalUserHead = f.git(['rev-parse', 'HEAD']);
          if (scenario === 'user-advanced') {
            writeFileSync(join(f.root, 'file.txt'), 'later user commit\n');
            f.git(['add', 'file.txt']);
            f.git(['commit', '-qm', 'Advance user checkout after worker completion']);
          }
          const userHead = f.git(['rev-parse', 'HEAD']);
          const userIndex = readFileSync(join(f.metadata, 'index'));
          let hidden: string | undefined;
          if (scenario.startsWith('missing-')) {
            if (scenario === 'missing-git') {
              const { readdirSync } = await import('node:fs');
              hidden = join(
                f.privateRoot,
                readdirSync(f.privateRoot).find((p) => p.endsWith('.commit-completed.json')) ??
                  'missing',
              );
            } else {
              for (const ref of refs) {
                const value = (await ctx.objects.get(ref.valueHash)) as Record<string, unknown>;
                if (
                  (scenario === 'missing-close' && value.reason === 'close') ||
                  (scenario === 'missing-completion' && value.receipt && value.worktree)
                ) {
                  hidden = join(ctx.owner.root, 'local-workspaces/objects', `${ref.key}.ref`);
                  break;
                }
              }
            }
            if (!hidden) throw Error('missing fault target');
            renameSync(hidden, `${hidden}.held`);
            await expect(sessions.readCompletedWorktree(scope)).rejects.toThrow();
            expect(() => readFileSync(hidden as string)).toThrow();
            renameSync(`${hidden}.held`, hidden);
          }
          const proof = await sessions.readCompletedWorktree(scope);
          expect(proof.worktree).toEqual(completed);
          expect(proof.workerId).toBe('coder');
          expect(proof.version.kind).toBe('files');
          expect(proof.completionReceiptId).toMatch(/^completion:[a-f0-9]{64}$/);
          const manifest = await ctx.versions.read(proof.version, ctx.versionScope);
          expect(manifest.files.some((file) => file.path === 'result.txt')).toBe(true);
          expect(await ctx.objects.references()).toEqual(refs);
          expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
          expect(f.git(['-C', completed.path, 'rev-parse', 'HEAD'])).toBe(completed.headCommit);
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
          if (scenario === 'user-advanced') expect(userHead).not.toBe(originalUserHead);
          writeFileSync(
            join(f.privateRoot, 'completed-source-proof.json'),
            JSON.stringify({
              scenario,
              proof,
              referencesUnchanged: true,
              stateUnchanged: true,
              workerHeadUnchanged: true,
              originalUserHead,
              userHead,
              userHeadAndIndexUnchanged: true,
            }),
          );
          if (scenario === 'normal') {
            const completionKey = proof.completionReceiptId.slice('completion:'.length);
            const completionHash = await ctx.objects.getReference(completionKey);
            if (!completionHash) throw Error('missing proof reference');
            const complete = (await ctx.objects.get(completionHash)) as {
              receipt: { tree: string };
            };
            const forged = await ctx.objects.put({
              ...complete,
              receipt: { ...complete.receipt, tree: '0'.repeat(40) },
            });
            const refPath = join(
              ctx.owner.root,
              'local-workspaces/objects',
              `${completionKey}.ref`,
            );
            const forgedRef = { key: completionKey, valueHash: forged };
            renameSync(refPath, `${refPath}.held`);
            writeFileSync(
              refPath,
              JSON.stringify({ ...forgedRef, sha256: localRecordHash(forgedRef) }),
            );
            chmodSync(refPath, 0o400);
            await expect(sessions.readCompletedWorktree(scope)).rejects.toThrow(
              'workspace_completion_invalid',
            );
            unlinkSync(refPath);
            renameSync(`${refPath}.held`, refPath);

            const reopened = await LocalWorkspaceSessions.create({
              ...ctx,
              filesHelper: resolve(
                'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
              ),
              grantForAssignment: async () => ctx.grant.grantId,
            });
            expect(await reopened.readCompletedWorktree(scope)).toEqual(proof);
            await expect(
              reopened.readCompletedWorktree({ ...scope, workerId: 'tester' }),
            ).rejects.toThrow();
            await ctx.store.commit(ctx.scope, [
              mergeByIdMutation('workers', 'coder', { sessionId: 'different-session' }),
            ]);
            await expect(reopened.readCompletedWorktree(scope)).rejects.toThrow();
            await ctx.store.commit(ctx.scope, [
              mergeByIdMutation('workers', 'coder', { sessionId: 'completion-session' }),
            ]);
            const path = join(completed.path, 'result.txt');
            const old = readFileSync(path);
            writeFileSync(path, 'changed after done\n');
            await expect(reopened.readCompletedWorktree(scope)).rejects.toThrow();
            renameSync(path, join(f.base, 'changed-source-original'));
            writeFileSync(path, old);
            // A different inode with restored bytes is not the completed file.
            await expect(reopened.readCompletedWorktree(scope)).rejects.toThrow();
          }
        } finally {
          await scheduler.release(lease);
        }
      }),
    ),
  120_000,
);
