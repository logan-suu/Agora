// Real Coordinator, registry, Git and native registration. Failed/pending lifecycle
// facts are explicit control fixtures; this does not claim model execution or G5.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeByIdMutation } from '@agora/core-domain';
import { decide } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { firstCodingWave, registeredFixture } from './local-linked-workspace-fixture';

it(
  'registers the real Coordinator retry from its original wave without recapturing user edits',
  async () =>
    fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          const { manager, request, state } = await firstCodingWave(ctx);
          await manager.registerCodingWave(request);
          const original = await ctx.control.snapshot();
          const failedId = state.parallelExecution?.activeWave?.coderWorkerIds[0];
          if (!failedId) throw Error('missing worker');
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', failedId, { status: 'failed' }),
          ]);
          let sequence = 0;
          const decision = decide(await ctx.control.assertClosed(ctx.scope), {
            newId: () => `retry-control-${++sequence}`,
            now: () => 20,
            parallel: {
              initialBase: state.parallelExecution?.initialBase as {
                branch: string;
                commit: string;
              },
              controlFingerprint: 'f'.repeat(64),
            },
          });
          const retryState = (await ctx.store.commit(ctx.scope, decision.mutations)).state;
          const wave = retryState.parallelExecution?.activeWave;
          const dispatch = retryState.messages.find((m) => m.payload.kind === 'coding_retry');
          if (!wave || !dispatch) throw Error('missing retry');
          expect(dispatch.payload.planId).toBeUndefined();
          expect(wave.attempt).toBe(1);
          expect(wave.base).toEqual(state.parallelExecution?.activeWave?.base);
          expect(dispatch.payload.failedWorkerIds).toEqual(
            state.parallelExecution?.activeWave?.coderWorkerIds,
          );
          writeFileSync(join(f.root, 'file.txt'), 'later user edit\n');
          const retry = {
            ...request,
            actionId: 'register-retry',
            expectedRevision: original.revision,
            targets: wave.coderWorkerIds.map((workerId, i) => ({
              workspaceId: `retry-coder-${i}`,
              purpose: 'coding' as const,
              workerId,
            })),
          };
          const registered = await manager.registerCodingWave(retry);
          expect(registered).toHaveLength(2);
          const after = await ctx.control.assertClosed(ctx.scope);
          expect(after.workers).toEqual(retryState.workers);
          expect(after.parallelExecution).toEqual(retryState.parallelExecution);
          const snapshot = await ctx.control.snapshot();
          expect(snapshot.linkedRoots).toHaveLength(5);
          for (const old of original.linkedRoots ?? [])
            expect(snapshot.linkedRoots).toContainEqual(old);
          for (const target of retry.targets) {
            const ref = await manager.resolveAssignment({
              ...ctx.scope,
              workerId: target.workerId,
            });
            expect(ref.baseCommit).toBe(wave.base.commit);
            expect(readFileSync(join(ref.path, 'file.txt'), 'utf8')).toBe('working\n');
          }
          expect(await manager.registerCodingWave(retry)).toEqual(registered);
          expect((await ctx.control.snapshot()).revision).toBe(snapshot.revision);
          expect(readFileSync(join(f.root, 'file.txt'), 'utf8')).toBe('later user edit\n');
          const retryWorkerId = retry.targets[0]?.workerId;
          if (!retryWorkerId) throw Error('missing retry worker');
          const proof = await manager.readCodingBaseline({
            ...ctx.scope,
            workerId: retryWorkerId,
          });
          expect(proof.lineage.base).toEqual(wave.base);
          expect(proof.codingBatch.receipt.actionId).toBe(retry.actionId);
          writeFileSync(
            join(f.privateRoot, 'coding-retry-lineage.json'),
            JSON.stringify({
              originalWorkerIds: state.parallelExecution?.activeWave?.coderWorkerIds,
              retryWorkerIds: wave.coderWorkerIds,
              dispatchId: dispatch.msgId,
              base: wave.base,
              originalRootsRetained: true,
              userEditsPreserved: true,
              replayRevision: snapshot.revision,
              baseline: proof,
            }),
          );
        },
        true,
      ),
    ),
  90_000,
);
