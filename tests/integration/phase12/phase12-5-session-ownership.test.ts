// Actual shared registry owner, canonical TaskState and global lease. This checks
// capability ownership across facades; it does not replace complete Harness G5.
import { resolve } from 'node:path';
import { mergeByIdMutation } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it(
  'refuses a second capability through another facade and exposes the actual first capability until close',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', 'pm', {
            workerId: 'pm',
            role: 'PM',
            executor: 'harness',
            status: 'running',
            sessionId: 'session:pm',
            startedTs: 1,
          }),
        ]);
        const scheduler = new GlobalScheduler();
        const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'pm');
        const options = {
          ...ctx,
          filesHelper: resolve(
            'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
          ),
          grantForAssignment: async () => ctx.grant.grantId,
        };
        const first = await LocalWorkspaceSessions.create(options);
        const second = await LocalWorkspaceSessions.create(options);
        const admission = {
          ...ctx.scope,
          workerId: 'pm',
          role: 'PM' as const,
          sessionId: 'session:pm',
          assertLease: () => scheduler.assertActive(lease),
        };
        const session = await first.openControl(admission);
        try {
          await expect(second.openControl(admission)).rejects.toThrow(
            'workspace_worker_already_active',
          );
          expect(second.rangeCapabilities(ctx.scope)).toEqual([
            { workerId: 'pm', sessionId: 'session:pm', closing: false, fileCapabilities: false },
          ]);
          await session.close();
          expect(second.rangeCapabilities(ctx.scope)).toEqual([]);
          expect(scheduler.activity(ctx.scope).leasedWorkerIds).toEqual(['pm']);
        } finally {
          await session.close();
          await scheduler.release(lease);
        }
      }),
    ),
  45_000,
);
