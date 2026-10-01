// Real owned Git worktrees, native validation and private command evidence
// cover the TESTER receipt through REVIEWER admission without model doubles.
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  appendMutation,
  buildCompletionResolution,
  currentCompletionEvidence,
  isWaveValidationReceipt,
  mergeByIdMutation,
  setMutation,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect, it } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { LocalDeliveryRevalidation } from '../../../apps/web/src/server/local-delivery-revalidation';
import { LocalDeliveryRevalidationControl } from '../../../apps/web/src/server/local-delivery-revalidation-control';
import { createLocalGitDeliveryComparisons } from '../../../apps/web/src/server/local-git-delivery-sources';
import { LocalGitWaveValidationService } from '../../../apps/web/src/server/local-git-wave-validation';
import { LocalValidationService } from '../../../apps/web/src/server/local-validation';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { LocalDeliveryCandidates } from '../../../packages/runtime/sandbox/src/local-delivery-candidates';
import { verifyLocalDeliveryGitMetadata } from '../../../packages/runtime/sandbox/src/local-delivery-git-current';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import {
  fixture,
  hash,
  manifest,
  manifestBytes,
  toolchainRoot,
} from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { exerciseDeliveryHarness } from './local-delivery-harness-fixture';
import { exerciseInitialGitApplication } from './local-initial-git-application-fixture';
import { exerciseInitialGitReview } from './local-initial-git-review-harness-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

async function nativeReviewScenario(
  archiveCandidate = false,
  liveRound = false,
  initialApply = false,
  liveReview = false,
  repairRound = false,
) {
  await fixture(async (f) =>
    registeredFixture(
      f,
      async (ctx) => {
        const started = Date.now();
        const stages = join(
          'test-outputs/task124',
          `reviewer-native-stages-${basename(f.base)}.jsonl`,
        );
        const mark = (stage: string) =>
          appendFileSync(stages, `${JSON.stringify({ stage, elapsedMs: Date.now() - started })}\n`);
        mark('fixture-ready');
        const testerId = 'worker:dispatch:0';
        const reviewerId = 'worker:review:0';
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('requirements', 'fixed-file-artifact', {
            story:
              'Preserve and verify the fixed file artifact through native Git validation and Leader completion.',
            acceptance: [
              'file.txt contains exactly working followed by a newline.',
              'new.txt is an intentional input fixture containing exactly untracked followed by a newline; preserve it in the validated artifact.',
              'review.test.cjs preserves the existing arithmetic assertion and verifies both artifact files from its own directory.',
            ],
            nonGoals: ['Do not add application features or change the fixed input files.'],
          }),
          mergeByIdMutation('workers', testerId, {
            role: 'TESTER',
            executor: 'harness',
            status: 'pending',
            subtaskId: undefined,
            startedTs: 1,
          }),
        ]);
        await new LocalGitWorkspaces(ctx).registerInitial({
          ...ctx.request,
          expectedRevision: (await ctx.control.snapshot()).revision,
          targets: ctx.request.targets.map((target) =>
            target.purpose === 'validation' ? { ...target, workerId: testerId } : target,
          ),
        });
        const initial = await ctx.control.assertClosed(ctx.scope);
        const workspaces = initial.localExecution?.workspaces ?? [];
        const testerBinding = initial.localExecution?.bindings.find((b) => b.workerId === testerId);
        const validation = workspaces.find((w) => w.workspaceId === testerBinding?.workspaceId);
        const integration = workspaces.find((w) => w.purpose === 'integration');
        const coding = workspaces.find((w) => w.purpose === 'coding');
        const physical = (await ctx.control.snapshot()).linkedRoots ?? [];
        const validationRoot = physical.find((r) => r.workspaceId === validation?.workspaceId);
        const integrationRoot = physical.find((r) => r.workspaceId === integration?.workspaceId);
        const codingRoot = physical.find((r) => r.workspaceId === coding?.workspaceId);
        if (
          validation?.mode !== 'linked-worktree' ||
          integration?.mode !== 'linked-worktree' ||
          coding?.mode !== 'linked-worktree' ||
          !validationRoot ||
          !integrationRoot ||
          !codingRoot
        )
          throw Error('missing real linked workspaces');
        writeFileSync(
          join(validationRoot.path, 'review.test.cjs'),
          "const { test } = require('node:test'); const { strictEqual } = require('node:assert'); const { readFileSync } = require('node:fs'); const { join } = require('node:path'); test('review', () => { strictEqual(2 + 2, 4); strictEqual(readFileSync(join(__dirname, 'file.txt'), 'utf8'), 'working\\n'); strictEqual(readFileSync(join(__dirname, 'new.txt'), 'utf8'), 'untracked\\n'); });\n",
        );
        const userHead = f.git(['rev-parse', 'HEAD']);
        const userIndex = readFileSync(join(f.root, '.git/index'));
        const coderRef = {
          path: codingRoot.path,
          branch: coding.branch,
          baseCommit: coding.baseCommit,
          headCommit: coding.baseCommit,
        };
        const integrationRef = {
          path: integrationRoot.path,
          branch: integration.branch,
          baseCommit: integration.baseCommit,
          headCommit: integration.baseCommit,
        };
        const validationRef = {
          path: validationRoot.path,
          branch: validation.branch,
          baseCommit: validation.baseCommit,
        };
        const plan = {
          version: 1 as const,
          subtasks: [{ id: 'code', title: 'Code', dependsOn: [] }],
        };
        await ctx.store.commit(ctx.scope, [
          setMutation('phase', 'testing'),
          setMutation('architecture', { executionPlan: plan }),
          mergeByIdMutation('subtasks', 'code', { status: 'in_progress', worktree: coderRef }),
          mergeByIdMutation('workers', 'coder', {
            status:
              archiveCandidate || liveRound || initialApply || liveReview ? 'running' : 'done',
            ...(archiveCandidate || liveRound || initialApply || liveReview
              ? { sessionId: 'session:coder' }
              : {}),
            worktree: coderRef,
          }),
          mergeByIdMutation('workers', testerId, {
            status: 'running',
            sessionId: 'session:tester',
            worktree: validationRef,
          }),
          setMutation('parallelExecution', {
            version: 1,
            planId: 'plan',
            initialBase: { branch: integration.branch, commit: integration.baseCommit },
            activeWave: {
              waveId: 'wave',
              attempt: 1,
              base: { branch: integration.branch, commit: integration.baseCommit },
              subtaskIds: ['code'],
              coderWorkerIds: ['coder'],
              validation: {
                dispatchId: 'dispatch',
                workerId: testerId,
                integrationId: 'integration',
                inputCommit: integration.baseCommit,
                worktree: { ...validationRef, headCommit: integration.baseCommit },
              },
            },
          }),
          setMutation('integration', {
            integrationId: 'integration',
            waveId: 'wave',
            base: { branch: integration.branch, commit: integration.baseCommit },
            integrationWorktree: integrationRef,
            pendingBranches: [
              { workerId: 'coder', subtaskId: 'code', topologicalRank: 0, worktree: coderRef },
            ],
            mergedBranches: [
              {
                workerId: 'coder',
                subtaskId: 'code',
                branch: coderRef.branch,
                headCommit: integration.baseCommit,
                mergeCommit: integration.baseCommit,
              },
            ],
            conflicts: [],
            status: 'done',
            resultCommit: integration.baseCommit,
          }),
          appendMutation('messages', {
            msgId: 'plan',
            channelId: 'main',
            fromRole: 'COORDINATOR',
            type: 'announce',
            display: 'Plan',
            ts: 1,
            payload: { kind: 'execution_plan', plan },
          }),
          appendMutation('messages', {
            msgId: 'wave',
            channelId: 'main',
            fromRole: 'COORDINATOR',
            type: 'announce',
            display: 'Coding wave',
            ts: 2,
            payload: { kind: 'coding_wave' },
          }),
          appendMutation('messages', {
            msgId: 'dispatch',
            channelId: 'main',
            fromRole: 'COORDINATOR',
            type: 'announce',
            display: 'Validate',
            ts: 2,
            payload: {
              kind: 'wave_validation_dispatch',
              planId: 'plan',
              waveId: 'wave',
              attempt: 1,
              integrationId: 'integration',
              inputCommit: integration.baseCommit,
              subtaskIds: ['code'],
            },
          }),
        ]);
        const scheduler = new GlobalScheduler();
        const tool = (name: string) => {
          const path = resolve(`packages/runtime/sandbox/build/${name}-darwin-arm64`);
          return { path, sha256: hash(readFileSync(path)) };
        };
        const node = join(toolchainRoot, 'node/bin/node');
        let service: LocalGitWaveValidationService | undefined;
        const prove = async (
          state: Awaited<ReturnType<typeof ctx.control.assertClosed>>,
          workerId: string,
        ): Promise<WorkspaceVersionV1> => {
          if (!service) throw Error('local_git_review_proof_unavailable');
          return service.verifiedReviewVersion(state, workerId);
        };
        const sessionOptions: Parameters<typeof LocalWorkspaceSessions.create>[0] = {
          ...ctx,
          filesHelper: resolve(
            'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
          ),
          tools: {
            manifestHash: hash(manifestBytes),
            node: { path: node, sha256: hash(readFileSync(node)), version: manifest.versions.node },
            bootstrap: tool('local-command-bootstrap'),
            processControl: tool('local-process-control'),
          },
          grantForAssignment: async () => ctx.grant.grantId,
          versionForAssignment: async (admission) =>
            admission.role === 'REVIEWER'
              ? prove(await ctx.control.assertClosed(ctx.scope), admission.workerId)
              : undefined,
          verifyReviewCandidate: prove,
        };
        const sessions = await LocalWorkspaceSessions.create(sessionOptions);
        service = new LocalGitWaveValidationService(
          sessions,
          () => ctx.control.assertClosed(ctx.scope),
          join(
            ctx.owner.root,
            'projects',
            ctx.scope.projectId,
            'tasks',
            ctx.scope.taskId,
            'artifacts',
          ),
        );
        if (archiveCandidate || liveRound || initialApply || liveReview) {
          // The retained coding claim needs a real closed native session even
          // when this fixture starts with an unchanged candidate tree.
          const coderLease = await scheduler.acquire(
            ctx.scope.projectId,
            ctx.scope.taskId,
            'coder',
          );
          try {
            const session = await sessions.open({
              ...ctx.scope,
              workerId: 'coder',
              role: 'CODER',
              subtaskId: 'code',
              sessionId: 'session:coder',
              assertLease: () => scheduler.assertActive(coderLease),
            });
            await session.close();
            await ctx.store.commit(ctx.scope, [
              mergeByIdMutation('workers', 'coder', { status: 'done' }),
            ]);
          } finally {
            await scheduler.release(coderLease);
          }
          mark('coder-claim-closed');
        }
        const testerLease = await scheduler.acquire(
          ctx.scope.projectId,
          ctx.scope.taskId,
          testerId,
        );
        try {
          const session = await sessions.open({
            ...ctx.scope,
            workerId: testerId,
            role: 'TESTER',
            sessionId: 'session:tester',
            assertLease: () => scheduler.assertActive(testerLease),
          });
          try {
            await session.checkpoint('complete');
            const completed = await session.completeWorktree?.();
            if (!completed?.headCommit) throw Error('missing completed TESTER worktree');
            await ctx.store.commit(ctx.scope, [
              mergeByIdMutation('workers', testerId, { worktree: completed }),
            ]);
            const state = await ctx.control.assertClosed(ctx.scope);
            const mutations = await service.complete(state, testerId, session);
            await ctx.store.commit(ctx.scope, mutations);
            mark('tester-receipt-committed');
            await expect(
              service.verifyReceiptHead(
                await ctx.control.assertClosed(ctx.scope),
                'wave-validation:dispatch',
              ),
            ).resolves.toMatchObject({ kind: 'git', commit: completed.headCommit });
          } finally {
            await session.close();
          }
        } finally {
          await scheduler.release(testerLease);
        }
        const validated = await ctx.control.assertClosed(ctx.scope);
        const receipt = validated.messages.find((m) => m.msgId === 'wave-validation:dispatch');
        if (!isWaveValidationReceipt(receipt?.payload)) throw Error('missing native receipt');
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', testerId, { status: 'done' }),
          mergeByIdMutation('subtasks', 'code', { status: 'done' }),
          setMutation('parallelExecution', {
            version: 1,
            planId: 'plan',
            initialBase: { branch: integration.branch, commit: integration.baseCommit },
            acceptedReceiptId: 'wave-validation:dispatch',
          }),
          setMutation('phase', 'review'),
          setMutation('nextRole', 'REVIEWER'),
          mergeByIdMutation('workers', reviewerId, {
            role: 'REVIEWER',
            executor: 'harness',
            status: 'pending',
            startedTs: 4,
          }),
          appendMutation('messages', {
            msgId: 'review',
            channelId: 'main',
            fromRole: 'COORDINATOR',
            type: 'announce',
            display: 'Review',
            ts: 4,
            payload: {
              kind: 'parallel_review_dispatch',
              nextRole: 'REVIEWER',
              workerIds: [reviewerId],
              reviewCommentCursor: 0,
              reviewBinding: {
                planId: 'plan',
                validationReceiptId: 'wave-validation:dispatch',
                commit: receipt.payload.worktree.headCommit,
                controlFingerprint: receipt.payload.controlFingerprint,
              },
            },
          }),
        ]);
        const reviewState = await ctx.control.assertClosed(ctx.scope);
        await expect(service.verifiedReviewVersion(reviewState, reviewerId)).resolves.toEqual(
          validated.testResults?.workspaceVersion,
        );
        mark('review-proof');
        if (liveReview) {
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', 'tester', { status: 'failed' }),
          ]);
          const state = await ctx.control.assertClosed(ctx.scope);
          const registry = await ctx.control.snapshot();
          const local = structuredClone(state.localExecution);
          if (!local) throw Error('missing_local_execution');
          local.delivery = {
            schemaVersion: 'local-delivery-v1',
            goal: 'artifact_only',
            rootId: ctx.root.rootId,
            currentRoundId: null,
            rounds: [],
          };
          await ctx.control.commitBinding({
            ...ctx.scope,
            actionId: 'fixture-delivery-goal',
            sourceMessageId: ctx.grant.leaderMessageId,
            expectedRevision: registry.revision,
            nextLocalExecution: local,
            records: {
              roots: registry.roots,
              grants: registry.grants,
              workspaces: registry.workspaces,
              claims: registry.claims,
              linkedRoots: registry.linkedRoots ?? [],
            },
          });
          const result = await exerciseInitialGitReview(ctx, sessionOptions, scheduler);
          writeFileSync(
            join(f.privateRoot, 'initial-git-review-harness.json'),
            JSON.stringify(result),
          );
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
          mark('live-initial-review-complete');
          return;
        }

        const manager = new LocalGitWorkspaces({ ...ctx, verifyReviewCandidate: prove });
        await manager.registerReviewer({ ...ctx.scope, workerId: reviewerId });
        mark('review-registered');
        await expect(
          manager.resolveAssignment({ ...ctx.scope, workerId: reviewerId }),
        ).resolves.toEqual(receipt.payload.worktree);
        mark('review-resolved');
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', reviewerId, {
            status: 'running',
            worktree: receipt.payload.worktree,
          }),
        ]);
        const reviewLease = await scheduler.acquire(
          ctx.scope.projectId,
          ctx.scope.taskId,
          reviewerId,
        );
        try {
          const session = await sessions.open({
            ...ctx.scope,
            workerId: reviewerId,
            role: 'REVIEWER',
            sessionId: 'session:reviewer',
            assertLease: () => scheduler.assertActive(reviewLease),
          });
          mark('review-session-open');
          try {
            const read = await session.tools.read(
              `tool:${hash('reviewer-native-read')}`,
              'file.txt',
            );
            mark('review-read');
            expect(read.kind).toBe('file');
            if (read.kind !== 'file') throw Error('missing reviewed file');
            expect(read.content.toString('utf8')).toBe('working\n');
            await expect(
              session.tools.apply(
                `tool:${hash('reviewer-native-write')}`,
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
            mark('review-write-rejected');
            expect(session.completeWorktree).toBeUndefined();
            expect(session.runFixedGitValidation).toBeUndefined();
          } finally {
            await session.close();
          }
        } finally {
          await scheduler.release(reviewLease);
        }
        const deliveryState = await ctx.control.assertClosed(ctx.scope);
        const deliveryRegistry = await ctx.control.snapshot();
        const deliveryLocal = structuredClone(deliveryState.localExecution);
        if (!deliveryLocal) throw Error('missing_local_execution');
        deliveryLocal.delivery = {
          schemaVersion: 'local-delivery-v1',
          goal: archiveCandidate ? 'artifact_only' : 'apply_to_directory',
          rootId: ctx.root.rootId,
          currentRoundId: null,
          rounds: [],
        };
        await ctx.control.commitBinding({
          ...ctx.scope,
          actionId: 'fixture-delivery-goal',
          sourceMessageId: ctx.grant.leaderMessageId,
          expectedRevision: deliveryRegistry.revision,
          nextLocalExecution: deliveryLocal,
          records: {
            roots: deliveryRegistry.roots,
            grants: deliveryRegistry.grants,
            workspaces: deliveryRegistry.workspaces,
            claims: deliveryRegistry.claims,
            linkedRoots: deliveryRegistry.linkedRoots ?? [],
          },
        });
        const comparisons = createLocalGitDeliveryComparisons(ctx, service);
        const comparison = await comparisons.prepare(ctx.scope);
        expect(comparison.source.artifact.kind).toBe('git');
        expect(comparison.source.baseline.kind).toBe('files');
        expect(comparison.source.targetIndexHash).not.toBeNull();
        expect(comparison.comparison.status).toBe('matches_artifact');
        expect(await comparisons.verifyCurrent(comparison.deliveryComparisonId)).toEqual(
          comparison,
        );
        mark('delivery-comparison-verified');
        if (liveRound) {
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', reviewerId, { status: 'done' }),
            mergeByIdMutation('workers', 'tester', { status: 'failed' }),
          ]);
          writeFileSync(join(f.root, 'delivery-user-note.txt'), 'preserve this independent edit');
          const compared = await comparisons.prepare(ctx.scope);
          expect(compared.comparison.status).toBe('requires_validation');
          const runtime = new MessageRuntime(
            join(ctx.owner.root, 'tasks'),
            new ChannelStream(),
            DEFAULT_ROSTER,
          );
          const before = await ctx.control.assertClosed(ctx.scope);
          await runtime.initializeState(ctx.scope, before);
          const candidates = await LocalDeliveryCandidates.open(
            ctx.owner,
            ctx.objects,
            ctx.versions,
            comparisons,
          );
          const controller = new LocalDeliveryRevalidation(
            ctx.control,
            comparisons,
            candidates,
            (scope) => runtime.store.load(scope),
            async (state) => {
              if (
                scheduler.activeCount !== 0 ||
                state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
              )
                throw Error('fixture_run_not_closed');
            },
          );
          const request = {
            ...ctx.scope,
            actionId: 'git-delivery-revalidate',
            expectedRevision: (await ctx.control.snapshot()).revision,
            deliveryComparisonId: compared.deliveryComparisonId,
            inputHash: compared.inputHash,
          };
          const proof = await exerciseDeliveryHarness({
            options: sessionOptions,
            candidates,
            runtime,
            scheduler,
            root: f.root,
            started: before,
            repair: repairRound,
            rejectCompletion: repairRound,
            applyOrder: 'after_approval',
            registration: controller,
            expectedTests: 1,
            expectedFiles: {
              'file.txt': 'working\n',
              'delivery-user-note.txt': 'preserve this independent edit',
            },
            applicationSources: (local) =>
              createLocalGitDeliveryComparisons(
                ctx,
                service,
                new LocalValidationService(local, async () => ctx.control.assertClosed(ctx.scope)),
                local,
              ),
            verifyTargetMetadata: (state, source) =>
              verifyLocalDeliveryGitMetadata(ctx, state, source),
            register: async (tasks) => {
              let registered: typeof before | undefined;
              let starts = 0;
              runtime.bindWorkspaceControlPort(
                new LocalDeliveryRevalidationControl(
                  controller,
                  (scope) => runtime.store.load(scope),
                  async (state) => {
                    registered = state;
                    starts++;
                    await tasks.startDeliveryRound(state);
                  },
                  {
                    commit: async () => {
                      throw Error('fixture_control_not_selected');
                    },
                  },
                ),
              );
              const post = () =>
                createPostMessage(runtime)(
                  new Request('http://localhost/api/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      ...ctx.scope,
                      channelId: 'main',
                      msgId: request.actionId,
                      display: `/workspace revalidate ${JSON.stringify(request)}`,
                    }),
                  }),
                );
              const response = await post();
              expect(response.status, JSON.stringify(await response.json())).toBe(202);
              expect(starts).toBe(1);
              const replay = await post();
              expect(replay.status, JSON.stringify(await replay.json())).toBe(202);
              expect(starts).toBe(1);
              if (!registered) throw Error('missing_registered_round');
              return registered;
            },
          });
          expect(readFileSync(join(f.root, 'review.test.cjs'), 'utf8')).toContain(
            'strictEqual(2 + 2, 4)',
          );
          expect(readFileSync(join(f.root, 'file.txt'), 'utf8')).toBe('working\n');
          writeFileSync(
            join(f.privateRoot, 'git-delivery-live-result.json'),
            JSON.stringify(proof),
          );
          mark('git-round-applied');
        }
        if (archiveCandidate || initialApply) {
          // Canonical approval facts isolate native archival. This scenario does
          // not claim a model REVIEWER verdict or a real Harness Fork.
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', reviewerId, { status: 'done' }),
            mergeByIdMutation('workers', 'tester', { status: 'failed' }),
            appendMutation('reviewComments', {
              id: 'native-verdict',
              kind: 'verdict',
              verdict: 'approved',
            }),
          ]);
          const reviewed = await ctx.control.assertClosed(ctx.scope);
          await service.verifyCompletion(reviewed);
          await expect(service.archive(reviewed, sessions)).rejects.toThrow(
            'local_archive_requires_resumed_approval',
          );
          const actionId = 'native-approval',
            gateId = 'human-gate:native-verdict',
            ts = Date.now();
          const built = buildCompletionResolution(reviewed, {
            actionId,
            reviewId: 'native-verdict',
            option: 'approve_completion',
            ts,
          });
          await ctx.store.commit(ctx.scope, [
            appendMutation('decisionLedger', built.decision),
            appendMutation('messages', {
              msgId: actionId,
              fromRole: 'leader',
              channelId: 'main',
              type: 'chat',
              ts,
              display: `/resolve-gate ${gateId} approve_completion`,
              payload: {
                kind: 'leader_intent',
                intent: { kind: 'resolve_human_gate', gateId, option: 'approve_completion' },
                action: { status: 'applied' },
                resolution: {
                  gateId,
                  option: 'approve_completion',
                  safePointRefs: [],
                  resumeSessionId: `human-gate-resume:${actionId}`,
                  completionEvidence: currentCompletionEvidence(reviewed),
                },
                completionResolution: built.action,
              },
            }),
            appendMutation('messages', {
              msgId: `human-gate-resumed:${actionId}`,
              fromRole: 'COORDINATOR',
              channelId: 'main',
              type: 'announce',
              ts,
              display: 'Synthetic native archive boundary',
              payload: {
                kind: 'human_gate_resumed',
                actionId,
                gateId,
                resumeSessionId: `human-gate-resume:${actionId}`,
              },
            }),
            setMutation('phase', initialApply ? 'review' : 'done'),
          ]);
          if (initialApply) {
            const proof = await exerciseInitialGitApplication(ctx, sessions, service, scheduler);
            writeFileSync(
              join(f.privateRoot, 'initial-git-application-result.json'),
              JSON.stringify(proof),
            );
            mark('initial-git-applied');
          }
          const completed = await ctx.control.assertClosed(ctx.scope);
          const links = (await ctx.control.snapshot()).linkedRoots;
          const artifact = await service.archive(completed, sessions);
          expect(artifact.workspaceVersion).toEqual(validated.testResults?.workspaceVersion);
          expect(artifact.workspaceVersion.kind).toBe('git');
          expect(readFileSync(join(artifact.path, 'file.txt'), 'utf8')).toBe('working\n');
          expect(readFileSync(join(artifact.path, 'review.test.cjs'), 'utf8')).toContain(
            'strictEqual(2 + 2, 4)',
          );
          expect((await ctx.control.assertClosed(ctx.scope)).workers).toEqual(completed.workers);
          expect((await ctx.control.snapshot()).linkedRoots).toEqual(links);
          expect((await ctx.control.snapshot()).claims.every((c) => c.status === 'released')).toBe(
            true,
          );
          expect(
            await service.archive(await ctx.control.assertClosed(ctx.scope), sessions),
          ).toEqual(artifact);
          mark('git-artifact-released');
          // Simulate independent owner corruption, restoring the original mode
          // so verification must reject changed bytes rather than permissions.
          chmodSync(join(artifact.path, 'review.test.cjs'), 0o600);
          writeFileSync(join(artifact.path, 'review.test.cjs'), 'independent artifact corruption');
          chmodSync(join(artifact.path, 'review.test.cjs'), 0o400);
          await expect(
            service.archive(await ctx.control.assertClosed(ctx.scope), sessions),
          ).rejects.toThrow();
          expect(readFileSync(join(artifact.path, 'review.test.cjs'), 'utf8')).toBe(
            'independent artifact corruption',
          );
          writeFileSync(
            join(f.privateRoot, 'native-git-artifact-result.json'),
            JSON.stringify({
              artifact,
              historicalWorkersUnchanged: true,
              linkedRootsRetained: true,
              claimsReleased: true,
              tamperRejected: true,
            }),
          );
        }

        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
        mark('complete');
      },
      false,
      false,
      liveRound
        ? 'Revalidate the fixed arithmetic candidate: file.txt must contain exactly working followed by a newline. Preserve review.test.cjs, whose existing test checks 2 + 2 = 4, and the independent delivery-user-note.txt content. Inspect this manifest and these files without expanding scope. The trusted runtime executes the fixed test after TESTER; REVIEWER assesses these requirements. Apply the verified files to the selected directory after explicit Leader confirmation.'
        : liveReview
          ? 'Review the fixed arithmetic candidate: file.txt must contain exactly working followed by a newline. Preserve review.test.cjs, whose existing test checks 2 + 2 = 4. Inspect these files without expanding scope. The trusted runtime already executed the fixed test. Produce the verified artifact after explicit Leader confirmation.'
          : 'Real linked registration',
    ),
  );
}

it(
  'reproves a real TESTER command before registering and reading the REVIEWER candidate',
  () => nativeReviewScenario(),
  600_000,
);
it(
  'archives the exact native Git candidate and retains released linked identities',
  () => nativeReviewScenario(true),
  900_000,
);
it(
  'revalidates a Git-origin candidate with real Harness and applies only after Leader approval',
  () => nativeReviewScenario(false, true),
  900000,
);
it(
  'repairs a Git-origin candidate after Leader rejection while retaining linked claims',
  () => nativeReviewScenario(false, true, false, false, true),
  900000,
);
it(
  'applies the original reviewed Git candidate without inventing another validation round',
  () => nativeReviewScenario(false, false, true),
  900000,
);

it(
  'reviews the original Git candidate with real Harness and completes through Leader D16',
  () => nativeReviewScenario(false, false, false, true),
  900000,
);
