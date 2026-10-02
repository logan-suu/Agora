// Actual registry, native operation readers and global leases. No worker or
// control closure is substituted; unexpected live-session evidence fails closed.
import { expect, it } from 'vitest';
import { LocalQuiescentWriters } from '../../../packages/runtime/sandbox/src/local-quiescent-writers';
import { localWorkspacePhysical } from '../../../packages/runtime/sandbox/src/local-range-admission';
import { nativeRangeFixture } from './local-range-native-fixture';

it(
  'requires real idle leases/queues and closed native operations before proving undo writers',
  async () =>
    nativeRangeFixture(async (ctx) => {
      const service = new LocalQuiescentWriters({
        ...ctx,
        activity: (scope) => ({ ...scope, activeWorkerIds: [], ...ctx.scheduler.activity(scope) }),
        capabilities: (scope) => ctx.sessions.rangeCapabilities(scope),
        operations: (scope) => ctx.sessions.rangeOperations(scope),
        workerClosure: async () => {
          throw Error('actual_worker_closure_required');
        },
        controlClosure: async () => {
          throw Error('actual_control_closure_required');
        },
        verifyClosure: async () => {
          throw Error('unexpected_closure');
        },
      });
      const registry = await ctx.control.snapshot(),
        workspace = registry.workspaces.find((w) => w.workspaceId === 'coding');
      if (!workspace) throw Error('missing actual workspace');
      const physical = localWorkspacePhysical(registry, workspace),
        before = await service.capture(physical);
      expect(before.targets.cohort).toEqual([]);
      expect(before.record.claimProofs.some((p) => p.kind === 'unopened')).toBe(true);
      expect(await service.read(before.hash)).toEqual(before.record);
      const lease = await ctx.scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'coder');
      try {
        await expect(service.capture(physical)).rejects.toThrow('workspace_writer_still_active');
        await expect(service.verifyCurrent(before.hash)).rejects.toThrow(
          'workspace_writer_still_active',
        );
      } finally {
        await ctx.scheduler.release(lease);
      }
      await service.verifyCurrent(before.hash);
      const ref = await ctx.objects.put({ ...before.record, claimProofs: [] });
      await expect(service.read(ref)).rejects.toThrow('workspace_writer_proof_invalid');
    }),
  60_000,
);
