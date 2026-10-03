// Real registry/TaskState, fixed-root manifests and owned linked Git proofs.
// Worker/session/writer closure is deliberately unavailable: this source test
// cannot promote a request to heldByLeader or replace the complete live G5 suite.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Message, parseWorkspaceControl } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { verifyLocalLinkedRoot } from '../../../packages/runtime/sandbox/src/local-linked-root';
import { LocalNativeRangeSources } from '../../../packages/runtime/sandbox/src/local-native-range-sources';
import { LocalRangeController } from '../../../packages/runtime/sandbox/src/local-range-controller';
import {
  type LocalRangeSourceProof,
  localRangeSourceKey,
} from '../../../packages/runtime/sandbox/src/local-range-evidence';
import { LocalRangeWritersEvidence } from '../../../packages/runtime/sandbox/src/local-range-writers-evidence';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it(
  'captures exact native source facts and commits only the durable request, preserving user HEAD/index/working changes',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
        const registry = await ctx.control.snapshot();
        const display =
          '/workspace takeover ' +
          JSON.stringify({
            ...ctx.scope,
            actionId: 'take-native',
            expectedRevision: registry.revision,
            workspaceId: 'coding',
            paths: ['file.txt'],
          });
        const message: Message = {
          msgId: 'take-native',
          fromRole: 'leader',
          channelId: 'main',
          type: 'chat',
          display,
          ts: 3,
          payload: {
            kind: 'leader_intent',
            intent: parseWorkspaceControl(display),
            action: { status: 'applied' },
          },
        };
        const head = f.git(['rev-parse', 'HEAD']),
          index = readFileSync(join(f.metadata, 'index')),
          content = readFileSync(join(f.root, 'file.txt'));
        let linked = 0;
        const sources = new LocalNativeRangeSources({
          ...ctx,
          inspector: ctx.gitOptions.helpers.inspector,
          tasks: ctx.store,
          verifyLinked: async (plan, snapshot) => {
            const record = snapshot.linkedRoots?.find((r) => r.workspaceId === plan.workspaceId),
              workspace = snapshot.workspaces.find((w) => w.workspaceId === plan.workspaceId);
            if (!record || workspace?.mode !== 'linked-worktree')
              throw Error('missing owned target');
            await verifyLocalLinkedRoot({
              ...ctx.gitOptions,
              ...ctx.scope,
              root: ctx.root.path,
              sourceRoot: ctx.root,
              workspace,
              record,
              expectedHead: workspace.baseCommit,
              actionId: record.initialization.actionId,
              creationActionId: record.creation.actionId,
              bindingReceiptId: record.bindingReceiptId,
              authorize: async () => {
                await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
                return true;
              },
            });
            linked++;
          },
          verifyWorkerClosure: async () => {
            throw Error('live_worker_proof_unavailable');
          },
          verifyWritersClosure: async () => {
            throw Error('native_writer_proof_unavailable');
          },
        });
        const controller = new LocalRangeController({
          control: ctx.control,
          objects: ctx.objects,
          tasks: ctx.store,
          sources,
          lifecycle: {
            closeWorkers: async () => {
              throw Error('live_worker_proof_unavailable');
            },
            proveWriters: async () => {
              throw Error('native_writer_proof_unavailable');
            },
          },
        });
        const committed = await controller.commit(ctx.scope, message);
        expect(committed.messages.find((m) => m.msgId === message.msgId)).toEqual(message);
        const hold = (await ctx.control.snapshot()).rangeHolds?.[0];
        if (!hold) throw Error('missing durable hold');
        expect(hold).toMatchObject({
          stage: 'requested',
          controlStage: 'committed',
          plan: { cohort: [] },
        });
        const sourceHash = await ctx.objects.getReference(localRangeSourceKey(hold.plan));
        if (!sourceHash) throw Error('missing source');
        const proof = (await ctx.objects.get(sourceHash)) as LocalRangeSourceProof;
        await sources.verifySource(hold.plan, proof);
        await expect(
          sources.verifySource(hold.plan, { ...proof, targetFactsHash: 'f'.repeat(64) }),
        ).rejects.toThrow('range_control_source_invalid');
        expect(await controller.commit(ctx.scope, { ...message, ts: 99 })).toEqual(committed);
        expect(await controller.view(hold.plan.takeoverId)).toMatchObject({
          stage: 'requested',
          editable: false,
          needsAttention: false,
        });
        expect(linked).toBeGreaterThan(0);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
        expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
        expect(readFileSync(join(f.root, 'file.txt'))).toEqual(content);
        expect(localRecordHash(await ctx.objects.get(sourceHash))).toBe(sourceHash);
      }),
    ),
  60_000,
);

it(
  'shares preparation serialization across reopened facades of the same actual owner',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const reopened = await LocalBindingCoordinator.open(ctx.owner, ctx.store);
        let release = () => {},
          started = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
          }),
          beginning = new Promise<void>((r) => {
            started = r;
          });
        const events: string[] = [];
        const first = ctx.control.serializeRangeAdmission(async () => {
          events.push('preparing');
          started();
          await gate;
          events.push('active');
        });
        await beginning;
        const second = reopened.serializeRangeAdmission(async () => {
          events.push('publish');
        });
        try {
          expect(events).toEqual(['preparing']);
        } finally {
          release();
          await first;
          await second;
        }
        expect(events).toEqual(['preparing', 'active', 'publish']);
      }),
    ),
  45_000,
);

it(
  'proves an idle native range only after actual capabilities, leases and journals are closed, then reads its immutable held version',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
        const sessions = await LocalWorkspaceSessions.create({
          ...ctx,
          filesHelper: resolve(
            'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
          ),
          grantForAssignment: async () => ctx.grant.grantId,
        });
        const scheduler = new GlobalScheduler();
        const writers = new LocalRangeWritersEvidence({
          ...ctx,
          tasks: ctx.store,
          capabilities: (scope) => sessions.rangeCapabilities(scope),
          activity: (scope) => ({ ...scope, activeWorkerIds: [], ...scheduler.activity(scope) }),
          operations: (scope) => sessions.rangeOperations(scope),
          controlWriter: async () => {
            throw Error('unexpected_control_writer');
          },
        });
        const sources = new LocalNativeRangeSources({
          ...ctx,
          tasks: ctx.store,
          inspector: ctx.gitOptions.helpers.inspector,
          verifyLinked: async (plan, registry) => {
            const workspace = registry.workspaces.find((w) => w.workspaceId === plan.workspaceId);
            const record = registry.linkedRoots?.find((r) => r.workspaceId === plan.workspaceId);
            if (workspace?.mode !== 'linked-worktree' || !record)
              throw Error('missing linked binding');
            await verifyLocalLinkedRoot({
              ...ctx.gitOptions,
              ...ctx.scope,
              root: ctx.root.path,
              sourceRoot: ctx.root,
              workspace,
              record,
              expectedHead: workspace.baseCommit,
              actionId: record.initialization.actionId,
              creationActionId: record.creation.actionId,
              bindingReceiptId: record.bindingReceiptId,
              authorize: async () => {
                await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
                return true;
              },
            });
          },
          verifyWorkerClosure: async () => {
            throw Error('unexpected_worker');
          },
          verifyWritersClosure: (plan, proof, targets) => writers.verify(plan, proof, targets),
        });
        const controller = new LocalRangeController({
          ...ctx,
          tasks: ctx.store,
          sources,
          lifecycle: {
            closeWorkers: async (hold) => {
              if (hold.plan.cohort.length) throw Error('unexpected_worker');
              return [];
            },
            proveWriters: (hold, sourceRef, workers) => writers.prove(hold, sourceRef, workers),
          },
        });
        const snapshot = await ctx.control.snapshot();
        const display =
          '/workspace takeover ' +
          JSON.stringify({
            ...ctx.scope,
            actionId: 'idle-take',
            expectedRevision: snapshot.revision,
            workspaceId: 'coding',
            paths: ['file.txt'],
          });
        const message: Message = {
          msgId: 'idle-take',
          fromRole: 'leader',
          channelId: 'main',
          type: 'chat',
          display,
          ts: 4,
          payload: {
            kind: 'leader_intent',
            intent: parseWorkspaceControl(display),
            action: { status: 'applied' },
          },
        };
        await controller.commit(ctx.scope, message);
        const held = await controller.hold('takeover:idle-take');
        expect(held.stage).toBe('heldByLeader');
        expect(await controller.view(held.plan.takeoverId)).toMatchObject({
          editable: true,
          needsAttention: false,
        });
        const heldRef = held.evidence.find((e) => e.phase === 'held')?.ref;
        if (!heldRef) throw Error('missing held proof');
        const proof = (await ctx.objects.get(
          heldRef,
        )) as import('../../../packages/runtime/sandbox/src/local-range-evidence').LocalRangeHeldProof;
        const record = await writers.read(held.plan, proof);
        expect(record.heldVersion.kind).toBe('files');
        const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'coder');
        try {
          expect(await controller.view(held.plan.takeoverId)).toMatchObject({
            editable: false,
            needsAttention: true,
          });
        } finally {
          await scheduler.release(lease);
        }
        expect(await controller.view(held.plan.takeoverId)).toMatchObject({
          editable: true,
          needsAttention: false,
        });
      }),
    ),
  60_000,
);
