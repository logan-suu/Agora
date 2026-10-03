// Real fixed-root APFS/file/Git/registry/TaskState checks. Idle cohorts exercise
// return capture and qualification only; no active Harness/Fork completion claim.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Message,
  mergeByIdMutation,
  PHASE0_ROSTER,
  parseWorkspaceControl,
  workspaceVersionChanges,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalRangeReturnController } from '../../../packages/runtime/sandbox/src/local-range-return-controller';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { nativeRangeFixture } from './local-range-native-fixture';

function message(
  scope: { projectId: string; taskId: string },
  actionId: string,
  verb: string,
  revision: number,
  extra: unknown,
): Message {
  const display =
    '/workspace ' +
    verb +
    ' ' +
    JSON.stringify({ ...scope, actionId, expectedRevision: revision, ...(extra as object) });
  return {
    msgId: actionId,
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    display,
    ts: 5,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
}
it(
  'captures real user edits, additions, deletion and rename before canonical invalidation and durable release; cold replay never captures again',
  async () =>
    nativeRangeFixture(async (ctx) => {
      const initial = await ctx.control.snapshot();
      const codingRoot = initial.linkedRoots?.find((r) => r.workspaceId === 'coding');
      if (!codingRoot) throw Error('missing coding');
      const userSource = readFileSync(join(ctx.root.path, 'file.txt'));
      writeFileSync(join(codingRoot.path, 'deleted.txt'), 'old file to delete\n');
      writeFileSync(join(codingRoot.path, 'rename-before.txt'), 'old file to rename\n');
      const take = message(
        ctx.scope,
        'native-return-take',
        'takeover',
        (await ctx.control.snapshot()).revision,
        { workspaceId: 'coding', paths: ['file.txt'] },
      );
      await ctx.controller.commit(ctx.scope, take);
      const held = await ctx.controller.hold('takeover:native-return-take');
      expect(await ctx.sessions.isBlocked(ctx.scope)).toBe(true);
      expect(await ctx.sessions.canAcquire({ ...ctx.scope, workerId: 'coder' })).toBe(false);
      const registry = await ctx.control.snapshot(),
        coding = registry.linkedRoots?.find((r) => r.workspaceId === 'coding');
      if (!coding) throw Error('missing coding');
      const original = readFileSync(join(coding.path, 'file.txt'));
      writeFileSync(join(coding.path, 'file.txt'), 'user edited after takeover\n');
      writeFileSync(join(coding.path, 'added.txt'), 'new user file\n');
      unlinkSync(join(coding.path, 'deleted.txt'));
      renameSync(join(coding.path, 'rename-before.txt'), join(coding.path, 'rename-after.txt'));
      const returned = message(
        ctx.scope,
        'native-return',
        'return',
        (await ctx.control.snapshot()).revision,
        { takeoverReceiptId: held.plan.takeoverId },
      );
      await ctx.returns.commit(ctx.scope, returned);
      expect((await ctx.control.snapshot()).rangeHolds?.[0]?.stage).toBe('returnRequested');
      ctx.control.setRangeEvidenceVerifier((r, s) => ctx.evidence.verifyAdmission(r, s));
      const released = await ctx.returns.release(held.plan.takeoverId);
      expect(released.stage).toBe('released');
      expect(await ctx.returns.view(held.plan.takeoverId)).toEqual({
        released: true,
        needsAttention: false,
      });
      const state = await ctx.control.assertClosed(ctx.scope),
        changes = workspaceVersionChanges(state);
      expect(changes).toHaveLength(1);
      expect(changes[0]?.affectedWorkerIds).toEqual(['coder', 'tester']);
      const version = changes[0]?.returnedVersion;
      if (!version) throw Error('missing version');
      const manifest = await ctx.versions.read(version, ctx.versionScope);
      expect(manifest.files.map((f) => f.path)).toContain('added.txt');
      expect(manifest.files.map((f) => f.path)).toContain('rename-after.txt');
      expect(manifest.files.map((f) => f.path)).not.toContain('deleted.txt');
      expect(manifest.files.map((f) => f.path)).not.toContain('rename-before.txt');
      expect(
        await ctx.objects.getBytes(
          manifest.files.find((f) => f.path === 'file.txt')?.contentHash as string,
        ),
      ).toEqual(Buffer.from('user edited after takeover\n'));
      expect(readFileSync(join(coding.path, 'file.txt'))).not.toEqual(original);
      const before = localRecordHash(await ctx.control.snapshot());
      const cold = new LocalRangeReturnController({
        ...ctx,
        tasks: ctx.store,
        evidence: ctx.evidence,
      });
      await cold.commit(ctx.scope, { ...returned, ts: 999 });
      expect(localRecordHash(await ctx.control.snapshot())).toBe(before);
      await expect(cold.release(held.plan.takeoverId)).rejects.toThrow('range_return_not_live');
      const reopened = await LocalBindingCoordinator.open(ctx.owner, ctx.store);
      expect(await reopened.assertClosed(ctx.scope)).toEqual(state);
      expect(await ctx.sessions.isBlocked(ctx.scope)).toBe(false);
      expect(await ctx.sessions.canAcquire({ ...ctx.scope, workerId: 'coder' })).toBe(true);
      expect(readFileSync(join(ctx.root.path, 'file.txt'))).toEqual(userSource);
      const heldManifest = await ctx.versions.read(
        changes[0]?.heldVersion as NonNullable<typeof version>,
        ctx.versionScope,
      );
      expect(heldManifest.files.map((f) => f.path)).toContain('deleted.txt');
      expect(heldManifest.files.map((f) => f.path)).toContain('rename-before.txt');
      // Owned immutable evidence deletion is a fault injection, never user data.
      unlinkSync(
        join(ctx.owner.root, 'local-workspaces', 'objects', `${changes[0]?.privateProofHash}.json`),
      );
      await expect(reopened.assertClosed(ctx.scope)).rejects.toThrow();
      await expect(ctx.sessions.isBlocked(ctx.scope)).rejects.toThrow();
      await expect(ctx.sessions.canAcquire({ ...ctx.scope, workerId: 'coder' })).rejects.toThrow();
      let prepared = false;
      await expect(
        ctx.sessions.activate({ ...ctx.scope, workerId: 'coder' }, async () => {
          prepared = true;
        }),
      ).rejects.toThrow();
      expect(prepared).toBe(false);
      expect(await cold.view(held.plan.takeoverId)).toEqual({
        released: false,
        needsAttention: true,
      });
      expect(readFileSync(join(coding.path, 'file.txt'), 'utf8')).toBe(
        'user edited after takeover\n',
      );
    }),
  180_000,
);
it(
  'preserves the barrier when user files change after capture and never writes over the newer edit',
  async () =>
    nativeRangeFixture(async (ctx) => {
      const take = message(
        ctx.scope,
        'unstable-take',
        'takeover',
        (await ctx.control.snapshot()).revision,
        { workspaceId: 'coding', paths: ['file.txt'] },
      );
      await ctx.controller.commit(ctx.scope, take);
      const held = await ctx.controller.hold('takeover:unstable-take');
      const coding = (await ctx.control.snapshot()).linkedRoots?.find(
        (r) => r.workspaceId === 'coding',
      );
      if (!coding) throw Error('missing coding');
      const real = ctx.evidence.verifyReleased.bind(ctx.evidence);
      ctx.evidence.verifyReleased = async (h, p) => {
        await real(h, p);
        writeFileSync(join(coding.path, 'file.txt'), 'newer user edit\n');
      };
      const returned = message(
        ctx.scope,
        'unstable-return',
        'return',
        (await ctx.control.snapshot()).revision,
        { takeoverReceiptId: held.plan.takeoverId },
      );
      await ctx.returns.commit(ctx.scope, returned);
      await expect(ctx.returns.release(held.plan.takeoverId)).rejects.toThrow(
        'range_return_needs_attention',
      );
      expect((await ctx.control.snapshot()).rangeHolds?.[0]?.stage).toBe('returnRequested');
      expect(readFileSync(join(coding.path, 'file.txt'), 'utf8')).toBe('newer user edit\n');
      expect(await ctx.returns.view(held.plan.takeoverId)).toMatchObject({
        released: false,
        needsAttention: true,
      });
    }),
  180_000,
);

it(
  'closes a real pending range while all global slots remain held by unrelated tasks',
  async () =>
    nativeRangeFixture(async (ctx) => {
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', 'coder', { sessionId: 'session:coder' }),
      ]);
      const leases = await Promise.all(
        Array.from({ length: ctx.scheduler.cap }, (_, i) =>
          ctx.scheduler.acquire('other-project', 'other-task', `other-${i}`),
        ),
      );
      const runtime = new WorkerRuntime(
        {
          roster: PHASE0_ROSTER,
          loadState: () => ctx.store.load(ctx.scope),
          transition: async (_old, mutations) =>
            (await ctx.store.commit(ctx.scope, mutations)).state,
          localWorkspace: ctx.sessions,
          rangeAdmission: ctx.sessions,
          buildExecutor: () => {
            throw Error('queued_worker_must_not_execute');
          },
          buildLocalExecutor: async () => {
            throw Error('queued_worker_must_not_execute');
          },
        },
        ctx.scheduler,
      );
      ctx.bindRuntime(runtime);
      const state = await ctx.store.load(ctx.scope);
      if (!state) throw Error('missing task');
      const running = runtime.runOne(state, {
        workerId: 'coder',
        role: 'CODER',
        subtaskId: 'code',
      });
      try {
        await expect
          .poll(() => runtime.rangeActivity(ctx.scope).queuedWorkerIds)
          .toEqual(['coder']);
        const take = message(
          ctx.scope,
          'queue-take',
          'takeover',
          (await ctx.control.snapshot()).revision,
          { workspaceId: 'coding', paths: ['file.txt'] },
        );
        await ctx.controller.commit(ctx.scope, take);
        const held = await ctx.controller.hold('takeover:queue-take');
        expect(held.plan.cohort).toEqual([]);
        expect((await ctx.controller.view(held.plan.takeoverId)).editable).toBe(true);
        expect(runtime.rangeActivity(ctx.scope)).toMatchObject({
          activeWorkerIds: [],
          leasedWorkerIds: [],
          queuedWorkerIds: [],
        });
        expect(ctx.scheduler.activeCount).toBe(ctx.scheduler.cap);
        expect(
          (await ctx.store.load(ctx.scope))?.workers.find((w) => w.workerId === 'coder'),
        ).toMatchObject({ status: 'pending', sessionId: 'session:coder' });
        await running;
      } finally {
        for (const lease of leases) await ctx.scheduler.release(lease);
        await running;
        expect(ctx.scheduler.activeCount).toBe(0);
      }
    }),
  120000,
);

it.each(['foreign-session', 'safe-point'] as const)(
  'rejects a pending assignment with %s instead of treating it as unopened',
  async (kind) =>
    nativeRangeFixture(async (ctx) => {
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', 'coder', {
          sessionId: kind === 'foreign-session' ? 'already-opened-session' : 'session:coder',
          ...(kind === 'safe-point' ? { safePoint: 'existing-checkpoint' } : {}),
        }),
      ]);
      const take = message(
        ctx.scope,
        'pending-evidence-take',
        'takeover',
        (await ctx.control.snapshot()).revision,
        { workspaceId: 'coding', paths: ['file.txt'] },
      );
      await ctx.controller.commit(ctx.scope, take);
      await expect(ctx.controller.hold('takeover:pending-evidence-take')).rejects.toThrow();
      expect((await ctx.controller.view('takeover:pending-evidence-take')).editable).toBe(false);
      expect(await ctx.sessions.canAcquire({ ...ctx.scope, workerId: 'coder' })).toBe(false);
    }),
  120000,
);
