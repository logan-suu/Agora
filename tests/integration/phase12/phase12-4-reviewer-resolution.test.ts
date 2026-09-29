// Real registry and owned Git worktree cover REVIEWER resolution. The candidate
// callback supplies fixed control evidence here; private command evidence is
// covered separately and this test does not claim full product G5 admission.

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendMutation, mergeByIdMutation, setMutation } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalGitVersionStore } from '../../../packages/runtime/sandbox/src/local-git-version-store';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { fixture, hash } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it('resolves a registered read-only REVIEWER to the exact validated physical worktree', async () => {
  await fixture(async (f) =>
    registeredFixture(f, async (ctx) => {
      const testerId = 'worker:dispatch:0';
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', testerId, {
          role: 'TESTER',
          executor: 'harness',
          status: 'pending',
          startedTs: 1,
        }),
      ]);
      const base = new LocalGitWorkspaces(ctx);
      await base.registerInitial({
        ...ctx.request,
        expectedRevision: (await ctx.control.snapshot()).revision,
        targets: ctx.request.targets.map((target) =>
          target.purpose === 'validation' ? { ...target, workerId: testerId } : target,
        ),
      });
      const initial = await ctx.control.assertClosed(ctx.scope);
      const integration = initial.localExecution?.workspaces.find(
        (item) => item.purpose === 'integration',
      );
      const binding = initial.localExecution?.bindings.find((item) => item.workerId === testerId);
      const workspace = initial.localExecution?.workspaces.find(
        (item) => item.workspaceId === binding?.workspaceId,
      );
      const physical = (await ctx.control.snapshot()).linkedRoots?.find(
        (item) => item.workspaceId === workspace?.workspaceId,
      );
      if (
        workspace?.mode !== 'linked-worktree' ||
        integration?.mode !== 'linked-worktree' ||
        !physical
      )
        throw Error('missing validation workspace');
      const worktree = {
        path: physical.path,
        branch: workspace.branch,
        baseCommit: workspace.baseCommit,
        headCommit: workspace.baseCommit,
      };
      const fingerprint = 'f'.repeat(64);
      const reviewerId = 'worker:review:0';
      const version = await new LocalGitVersionStore(ctx.objects, ctx.versions).capture(
        ctx.versionScope,
        {
          ...ctx.gitOptions,
          ...ctx.scope,
          root: ctx.root.path,
          sourceRoot: ctx.root,
          workspace,
          record: physical,
          expectedHead: worktree.headCommit,
          actionId: physical.initialization.actionId,
          creationActionId: physical.creation.actionId,
          bindingReceiptId: physical.bindingReceiptId,
          authorize: async () => {
            await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
            return true;
          },
        },
      );
      await ctx.store.commit(ctx.scope, [
        setMutation('phase', 'review'),
        setMutation('nextRole', 'REVIEWER'),
        setMutation('architecture', {
          executionPlan: { version: 1, subtasks: [{ id: 'code', title: 'Code', dependsOn: [] }] },
        }),
        mergeByIdMutation('subtasks', 'code', { status: 'done' }),
        setMutation('parallelExecution', {
          version: 1,
          planId: 'plan',
          initialBase: { branch: integration.branch, commit: integration.baseCommit },
          acceptedReceiptId: 'wave-validation:dispatch',
        }),
        setMutation('testResults', {
          passed: true,
          total: 1,
          failed: 0,
          failures: [],
          workspaceVersion: version,
        }),
        mergeByIdMutation('workers', testerId, {
          status: 'done',
          subtaskId: undefined,
          worktree,
        }),
        mergeByIdMutation('workers', reviewerId, {
          role: 'REVIEWER',
          executor: 'harness',
          status: 'pending',
          startedTs: 3,
        }),
        appendMutation('messages', {
          msgId: 'plan',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          display: 'Plan',
          ts: 0,
          payload: {
            kind: 'execution_plan',
            plan: { version: 1, subtasks: [{ id: 'code', title: 'Code', dependsOn: [] }] },
          },
        }),
        appendMutation('messages', {
          msgId: 'dispatch',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          display: 'Validate',
          ts: 1,
          payload: {
            kind: 'wave_validation_dispatch',
            planId: 'plan',
            waveId: 'wave',
            attempt: 1,
            integrationId: 'integration',
            inputCommit: workspace.baseCommit,
            subtaskIds: ['code'],
          },
        }),
        appendMutation('messages', {
          msgId: 'wave-validation:dispatch',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          display: 'Validated',
          ts: 2,
          payload: {
            kind: 'wave_validation',
            version: 1,
            planId: 'plan',
            waveId: 'wave',
            attempt: 1,
            dispatchId: 'dispatch',
            workerId: testerId,
            integrationId: 'integration',
            inputCommit: workspace.baseCommit,
            worktree,
            subtaskIds: ['code'],
            controlFingerprint: fingerprint,
            results: { passed: true, total: 1, failed: 0, failures: [] },
            evidence: {
              path: 'validation/dispatch.json',
              sha256: 'd'.repeat(64),
              exitCode: 0,
              timedOut: false,
            },
          },
        }),
        appendMutation('messages', {
          msgId: 'review',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          display: 'Review',
          ts: 3,
          payload: {
            kind: 'parallel_review_dispatch',
            nextRole: 'REVIEWER',
            workerIds: [reviewerId],
            reviewCommentCursor: 0,
            reviewBinding: {
              planId: 'plan',
              validationReceiptId: 'wave-validation:dispatch',
              commit: worktree.headCommit,
              controlFingerprint: fingerprint,
            },
          },
        }),
      ]);
      let failStateCommit = true;
      const interrupted = await LocalBindingCoordinator.open(ctx.owner, {
        load: (input) => ctx.store.load(input),
        commit: async (input, mutations) => {
          if (failStateCommit) {
            failStateCommit = false;
            throw Error('simulated_state_commit_failure');
          }
          return ctx.store.commit(input, mutations);
        },
      });
      const interruptedManager = new LocalGitWorkspaces({
        ...ctx,
        control: interrupted,
        verifyReviewCandidate: async () => version,
      });
      const manager = new LocalGitWorkspaces({
        ...ctx,
        control: await LocalBindingCoordinator.open(ctx.owner, ctx.store),
        verifyReviewCandidate: async () => version,
      });
      const scope = { ...ctx.scope, workerId: reviewerId };
      await expect(manager.resolveAssignment(scope)).rejects.toThrow(
        'workspace_assignment_mismatch',
      );
      await expect(interruptedManager.registerReviewer(scope)).rejects.toThrow(
        'simulated_state_commit_failure',
      );
      const prepared = (await ctx.control.snapshot()).operations.filter(
        (operation) => operation.stage === 'prepared',
      );
      expect(prepared).toHaveLength(1);
      expect(prepared[0]?.actionId).toBe('review-binding:review');
      await manager.registerReviewer(scope);
      expect(
        (await ctx.control.snapshot()).operations.some(
          (operation) =>
            operation.actionId === 'review-binding:review' && operation.stage === 'prepared',
        ),
      ).toBe(false);
      await expect(manager.resolveAssignment(scope)).resolves.toEqual(worktree);
      const before = await ctx.control.snapshot();
      await expect(manager.resolveAssignment(scope)).resolves.toEqual(worktree);
      expect((await ctx.control.snapshot()).revision).toBe(before.revision);
      expect(before.claims.some((claim) => claim.workerId === reviewerId)).toBe(false);
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', reviewerId, { status: 'running', worktree }),
      ]);
      const scheduler = new GlobalScheduler();
      const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, reviewerId);
      const sessions = await LocalWorkspaceSessions.create({
        ...ctx,
        filesHelper: resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        grantForAssignment: async () => ctx.grant.grantId,
        versionForAssignment: async () => version,
        verifyReviewCandidate: async () => version,
      });
      try {
        const session = await sessions.open({
          ...scope,
          role: 'REVIEWER',
          sessionId: 'session:reviewer',
          assertLease: () => scheduler.assertActive(lease),
        });
        try {
          expect(session.completeWorktree).toBeUndefined();
          expect(session.inspectCommittedGit).toBeUndefined();
          expect(session.runFixedGitValidation).toBeUndefined();
          const read = await session.tools.read(`tool:${hash('review-read')}`, 'file.txt');
          expect(read.kind).toBe('file');
          if (read.kind !== 'file') throw Error('missing reviewed file');
          expect(read.content.toString('utf8')).toBe('working\n');
          await expect(
            session.tools.apply(
              `tool:${hash('review-write')}`,
              [
                {
                  path: 'file.txt',
                  expected: read.version,
                  readReceiptId: read.readReceiptId,
                  content: 'forbidden',
                  encoding: 'utf8',
                },
              ],
              [],
            ),
          ).rejects.toThrow('authorization_closed');
          writeFileSync(join(worktree.path, 'file.txt'), 'external drift\n');
          try {
            await expect(
              session.tools.read(`tool:${hash('review-after-drift')}`, 'file.txt'),
            ).rejects.toThrow();
          } finally {
            writeFileSync(join(worktree.path, 'file.txt'), 'working\n');
          }
        } finally {
          await session.close();
        }
      } finally {
        await scheduler.release(lease);
      }
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', reviewerId, { status: 'paused' }),
      ]);
      const pausedRevision = (await ctx.control.snapshot()).revision;
      await manager.registerReviewer(scope);
      await expect(manager.resolveAssignment(scope)).resolves.toEqual(worktree);
      expect((await ctx.control.snapshot()).revision).toBe(pausedRevision);
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', reviewerId, {
          status: 'running',
          worktree: { ...worktree, headCommit: 'a'.repeat(40) },
        }),
      ]);
      await expect(
        sessions.open({
          ...scope,
          role: 'REVIEWER',
          sessionId: 'session:reviewer-after-change',
          assertLease: () => undefined,
        }),
      ).rejects.toThrow('local_git_review_proof_unavailable');
    }),
  );
}, 120_000);
