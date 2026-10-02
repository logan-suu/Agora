// Real owned registry, canonical TaskState, native manifest and linked Git trees.
// This first unit tests durable admission; it does not replace Harness/return/undo G5.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendMutation, mergeByIdMutation, parseWorkspaceControl } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { localWorkspacePhysical } from '../../../packages/runtime/sandbox/src/local-range-admission';
import { parseLocalRangeHold } from '../../../packages/runtime/sandbox/src/local-range-records';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import {
  LocalWorkspaceAuthority,
  localRootBinding,
} from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { fixture } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it(
  'persists the takeover barrier before canonical closure, retains it on reopen and rejects new writer registration without touching user changes',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
        const initial = await ctx.control.snapshot();
        const workspace = initial.workspaces.find((w) => w.workspaceId === 'coding');
        const physical = initial.linkedRoots?.find((r) => r.workspaceId === 'coding');
        const claim = initial.claims.find((c) => c.workerId === 'coder');
        if (workspace?.mode !== 'linked-worktree' || !physical || !claim)
          throw Error('missing real binding');
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
        const startVersion = await ctx.versions.capture(
          ctx.versionScope,
          localRootBinding({ ...ctx.root, ...physical }),
          async () => {
            await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
            return true;
          },
        );
        const display = `/workspace takeover ${JSON.stringify({ ...ctx.scope, actionId: 'take', expectedRevision: initial.revision, workspaceId: 'coding', paths: ['file.txt'] })}`;
        const sourceMessage = {
          msgId: 'take',
          fromRole: 'leader',
          channelId: 'main',
          type: 'chat',
          display,
          ts: 2,
          payload: {
            kind: 'leader_intent',
            intent: parseWorkspaceControl(display),
            action: { status: 'applied' },
          },
        };
        const plan = {
          schemaVersion: 'local-range-plan-v1',
          takeoverId: 'takeover:take',
          ...ctx.scope,
          workspaceId: 'coding',
          rootId: ctx.root.rootId,
          grantId: ctx.grant.grantId,
          grantRevision: ctx.grant.revision,
          expectedRevision: initial.revision,
          sourceMessage,
          requestedPaths: ['file.txt'],
          effectiveScope: 'workspace',
          physical: localWorkspacePhysical(initial, workspace),
          startVersion,
          cohort: [
            {
              ...ctx.scope,
              workerId: 'coder',
              sessionId: 'session:coder',
              assignmentHash: localRecordHash({ role: 'CODER', subtaskId: 'code' }),
            },
          ],
        };
        const requested = parseLocalRangeHold({
          plan,
          planHash: localRecordHash(plan),
          controlStage: 'prepared',
          stage: 'requested',
          evidence: [],
          returnMessage: null,
        });
        const userHead = f.git(['rev-parse', 'HEAD']),
          userIndex = readFileSync(join(f.metadata, 'index')),
          userWorking = readFileSync(join(f.root, 'file.txt'));
        await ctx.control.updateRangeHold(initial.revision, requested);
        const revision = (await ctx.control.snapshot()).revision;
        expect(
          (await ctx.control.snapshot()).operations.every((o) => o.stage === 'committed'),
        ).toBe(true);
        expect(await ctx.control.updateRangeHold(initial.revision, requested)).toEqual(requested);
        expect((await ctx.control.snapshot()).revision).toBe(revision);
        const reopened = await LocalBindingCoordinator.open(ctx.owner, ctx.store);
        expect((await reopened.snapshot()).rangeHolds).toEqual([requested]);
        await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
        const scheduler = new GlobalScheduler();
        const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'coder');
        const authority = new LocalWorkspaceAuthority(
          reopened,
          ctx.roots,
          ctx.versions,
          () => scheduler.assertActive(lease),
          ctx.verifyGrant,
          undefined,
          ctx.gitOptions,
        );
        const call = {
          ...ctx.scope,
          workerId: 'coder',
          workspaceId: 'coding',
          actionId: 'after-take',
          writerEpoch: claim.writerEpoch,
          grantRevision: ctx.grant.revision,
        };
        try {
          await expect(authority.assertCall(call, 'edit')).rejects.toThrow('file_taken_over');
          await expect(authority.assertQuiescence(call)).resolves.toMatchObject({ workspace });
          const canonicalRef = await ctx.objects.put({
            schemaVersion: 'local-range-canonical-v1',
            planHash: requested.planHash,
            sourceMessage: requested.plan.sourceMessage,
          });
          const committed = parseLocalRangeHold({
            ...requested,
            controlStage: 'committed',
            evidence: [{ phase: 'canonical', workerKey: null, ref: canonicalRef }],
          });
          await expect(reopened.updateRangeHold(revision, committed)).rejects.toThrow(
            'workspace_control_source_invalid',
          );
          await ctx.store.commit(ctx.scope, [
            appendMutation('messages', requested.plan.sourceMessage),
          ]);
          await reopened.updateRangeHold(revision, committed);
          const state = await reopened.assertClosed(ctx.scope),
            snapshot = await reopened.snapshot();
          if (!state.localExecution) throw Error('missing canonical execution');
          await expect(
            reopened.commitBinding({
              ...ctx.scope,
              actionId: 'new-writer',
              sourceMessageId: ctx.grant.leaderMessageId,
              expectedRevision: snapshot.revision,
              nextLocalExecution: {
                ...state.localExecution,
                bindings: [
                  ...state.localExecution.bindings,
                  {
                    workerId: 'later-writer',
                    workspaceId: 'coding',
                    receiptId: 'binding:new-writer',
                  },
                ],
              },
              records: {
                roots: snapshot.roots,
                grants: snapshot.grants,
                workspaces: snapshot.workspaces,
                claims: snapshot.claims,
                linkedRoots: snapshot.linkedRoots ?? [],
              },
            }),
          ).rejects.toThrow('file_taken_over');
          expect((await reopened.snapshot()).revision).toBe(snapshot.revision);
          expect((await reopened.snapshot()).rangeHolds?.[0]?.stage).toBe('requested');
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.metadata, 'index'))).toEqual(userIndex);
          expect(readFileSync(join(f.root, 'file.txt'))).toEqual(userWorking);
        } finally {
          await scheduler.release(lease);
        }
      }),
    ),
  45_000,
);
