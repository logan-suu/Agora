// Actual canonical binding, global lease and trusted native file writes. No
// executor, grant, file transaction or persistent object adapter is substituted.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeByIdMutation } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalUndoOriginalEffects } from '../../../packages/runtime/sandbox/src/local-undo-original-effects';
import { LocalWorkspaceApply } from '../../../packages/runtime/sandbox/src/local-workspace-apply';
import { LocalWorkspaceAuthority } from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { LocalWorkspaceFiles } from '../../../packages/runtime/sandbox/src/local-workspace-files';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it.each(['normal', 'same-name-at-completion', 'batch'])(
  'reads original proven effects through %s without reacquiring a capability or overwriting later user changes',
  async (scenario) =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
        const snapshot = await ctx.control.snapshot(),
          workspace = snapshot.workspaces.find((w) => w.workspaceId === 'coding'),
          physical = snapshot.linkedRoots?.find((r) => r.workspaceId === 'coding'),
          claim = snapshot.claims.find((c) => c.workerId === 'coder');
        if (workspace?.mode !== 'linked-worktree' || !physical || !claim)
          throw Error('missing actual binding');
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', 'coder', {
            status: 'running',
            sessionId: 'session:coder',
            worktree: {
              path: physical.path,
              branch: workspace.branch,
              baseCommit: workspace.baseCommit,
            },
          }),
        ]);
        const scheduler = new GlobalScheduler(),
          lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'coder');
        const target = join(physical.path, 'file.txt'),
          content = Buffer.from('A version');
        let raced = false;
        const authority = new LocalWorkspaceAuthority(
          ctx.control,
          ctx.roots,
          ctx.versions,
          () => scheduler.assertActive(lease),
          async (scope, grantId) => {
            await ctx.verifyGrant(scope, grantId);
            if (
              scenario === 'same-name-at-completion' &&
              !raced &&
              readFileSync(target).equals(content)
            ) {
              const dir = join(ctx.owner.root, 'local-workspaces', 'file-transactions');
              const io = await import('node:fs');
              if (
                existsSync(dir) &&
                io
                  .readdirSync(dir)
                  .some((name) => existsSync(join(dir, name, 'native-outcome.json')))
              ) {
                renameSync(target, join(physical.path, 'original-A'));
                writeFileSync(target, content);
                raced = true;
              }
            }
          },
          undefined,
          ctx.gitOptions,
        );
        const helper = resolve(
          'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
        );
        const files = new LocalWorkspaceFiles(authority, ctx.objects, helper);
        const writer = await LocalWorkspaceApply.open(
          ctx.owner,
          authority,
          ctx.objects,
          files,
          helper,
        );
        const call = {
          ...ctx.scope,
          workerId: 'coder',
          workspaceId: 'coding',
          writerEpoch: claim.writerEpoch,
          grantRevision: ctx.grant.revision,
          actionId: 'read-basis',
        };
        const userHead = f.git(['rev-parse', 'HEAD']),
          userIndex = readFileSync(join(f.metadata, 'index'));
        try {
          const read = await files.readFile(call, 'file.txt'),
            candidate = await files.storeContent({ ...call, actionId: 'candidate' }, content);
          const absent =
            scenario === 'batch'
              ? await files.readFile({ ...call, actionId: 'absent-basis' }, 'created125.txt')
              : undefined;
          if (absent) expect(absent.version.kind).toBe('absent');
          const basis = absent
            ? await files.prepareReadSet({ ...call, actionId: 'read-set' }, [
                { path: 'file.txt', version: read.version, readReceiptId: read.readReceiptId },
                {
                  path: 'created125.txt',
                  version: absent.version,
                  readReceiptId: absent.readReceiptId,
                },
              ])
            : read.readReceiptId;
          const applied = await writer.applyFiles(
            { ...call, actionId: 'actual-write' },
            [
              { op: 'put', path: 'file.txt', expected: read.version, contentRef: candidate },
              ...(absent
                ? [
                    {
                      op: 'put' as const,
                      path: 'created125.txt',
                      expected: absent.version,
                      contentRef: candidate,
                    },
                  ]
                : []),
            ],
            basis,
          );
          expect(applied.effect).toBe(true);
          expect(applied.stage).toBe(
            scenario === 'same-name-at-completion' ? 'recoveryRequired' : 'applied',
          );
          expect(raced).toBe(scenario === 'same-name-at-completion');
          await scheduler.release(lease);
          writeFileSync(target, 'later U');
          const batch =
            scenario === 'batch'
              ? await writer.readActualBatch(
                  { ...ctx.scope, workspaceId: 'coding' },
                  applied.receiptId,
                )
              : undefined;
          const actual = batch
            ? batch.effects[0]
            : await writer.readActualFileEffect(
                { ...ctx.scope, workspaceId: 'coding' },
                applied.receiptId,
              );
          const original = await new LocalUndoOriginalEffects({
            objects: ctx.objects,
            files: writer,
          }).read({ ...ctx.scope, workspaceId: 'coding' }, applied.receiptId);
          expect(original.receiptHash).toBe(batch?.receiptHash ?? actual?.receiptHash);
          expect(original.effects[0]).toMatchObject({
            operation: 'put',
            path: 'file.txt',
            effect: true,
            installed: content,
          });
          expect(readFileSync(target, 'utf8')).toBe('later U');
          if (batch) {
            expect(batch.effects.map((e) => e.kind)).toEqual(['replace', 'create']);
            expect(batch.receiptHash).toBe(await ctx.objects.put(applied));
            expect(batch.effects.every((e) => e.effect && e.installedVersion)).toBe(true);
            await expect(
              writer.readActualBatch(
                { ...ctx.scope, taskId: 'wrong', workspaceId: 'coding' },
                applied.receiptId,
              ),
            ).rejects.toThrow();
            const resultKey = localRecordHash({
              key: applied.receiptId.slice(6),
              phase: 'batch-result',
            });
            const refPath = join(ctx.owner.root, 'local-workspaces', 'objects', `${resultKey}.ref`);
            const originalRef = readFileSync(refPath);
            unlinkSync(refPath);
            try {
              await expect(
                writer.readActualBatch({ ...ctx.scope, workspaceId: 'coding' }, applied.receiptId),
              ).rejects.toThrow('workspace_file_recovery_required');
            } finally {
              writeFileSync(refPath, originalRef, { flag: 'wx', mode: 0o400 });
            }
          }
          expect(actual).toMatchObject({
            schemaVersion: 'workspace-actual-file-effect-v1',
            effect: true,
            ...(batch ? {} : { receiptId: applied.receiptId }),
            baselineVersion: read.version,
            candidateContentRef: candidate,
            installedVersion: { kind: 'regular', sha256: candidate },
          });
          await expect(
            writer.readActualFileEffect(
              { ...ctx.scope, taskId: 'other', workspaceId: 'coding' },
              applied.receiptId,
            ),
          ).rejects.toThrow();
          const inventory = await writer.readClosedOperations({
            ...ctx.scope,
            workspaceId: 'coding',
          });
          expect(inventory).toHaveLength(batch ? 3 : 1);
          expect(readFileSync(target, 'utf8')).toBe('later U');
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
        } finally {
          await scheduler.release(lease);
        }
      }),
    ),
  60_000,
);
