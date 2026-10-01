// Real owned Git, fixed Node validation and private command evidence; no model doubles.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AppState,
  appendMutation,
  isWaveValidationReceipt,
  mergeByIdMutation,
  setMutation,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import {
  createValidationDispatchVerifier,
  decide,
  GlobalScheduler,
  planIntegrationWave,
} from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { LocalCodingPreparation } from '../../../apps/web/src/server/local-coding-preparation';
import { LocalGitWaveValidationService } from '../../../apps/web/src/server/local-git-wave-validation';
import { LocalInitialValidationPreparation } from '../../../apps/web/src/server/local-initial-validation';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { LocalIntegrationAuthority } from '../../../packages/runtime/sandbox/src/local-integration-authority';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationCompletion } from '../../../packages/runtime/sandbox/src/local-integration-completion';
import { LocalIntegrationHandoff } from '../../../packages/runtime/sandbox/src/local-integration-handoff';
import { LocalIntegrationPreparation } from '../../../packages/runtime/sandbox/src/local-integration-preparation';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationSources } from '../../../packages/runtime/sandbox/src/local-integration-sources';
import { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { LocalValidationGitRegistrationSource } from '../../../packages/runtime/sandbox/src/local-validation-git-registration-source';
import { LocalValidationPreparationConfirmation } from '../../../packages/runtime/sandbox/src/local-validation-preparation-confirmation';
import { LocalValidationPreparationControl } from '../../../packages/runtime/sandbox/src/local-validation-preparation-control';
import { LocalValidationPreparationPublication } from '../../../packages/runtime/sandbox/src/local-validation-preparation-publication';
import { LocalValidationPreparationRecords } from '../../../packages/runtime/sandbox/src/local-validation-preparation-records';
import { LocalValidationPreparationSource } from '../../../packages/runtime/sandbox/src/local-validation-preparation-source';
import { serializeWorkspaceOperation } from '../../../packages/runtime/sandbox/src/local-workspace-operation';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import {
  fixture,
  hash,
  manifest,
  manifestBytes,
  toolchainRoot,
} from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

async function runAcceptedScenario(
  scenario: 'baseline' | 'published' | 'ack' | 'handoff' | 'validation' | 'receipt' | 'review',
  failedSource = false,
  reviewerSource = false,
) {
  await fixture(async (f) =>
    registeredFixture(f, async (ctx) => {
      const started = performance.now();
      const mark = (stage: string) =>
        writeFileSync(
          join(f.privateRoot, 'accepted-wave-stage.json'),
          JSON.stringify({ scenario, stage, elapsedMs: Math.round(performance.now() - started) }),
        );
      const initialCoderId = failedSource || reviewerSource ? 'worker:wave:0' : 'coder';
      const codingSubtask = failedSource || reviewerSource ? 'code' : 'B';
      let codingWaveId = failedSource ? 'wave' : 'next-wave';
      let codingAttempt = failedSource ? 2 : 1;
      let returnedDispatch: AppState | undefined;
      if (failedSource || reviewerSource)
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', 'coder', { status: 'failed' }),
          mergeByIdMutation('workers', initialCoderId, {
            role: 'CODER',
            executor: 'harness',
            status: 'pending',
            subtaskId: 'code',
            startedTs: 1,
          }),
        ]);
      const testerId = 'worker:dispatch:0';
      let coderId = 'worker:next-wave:0';
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', testerId, {
          role: 'TESTER',
          executor: 'harness',
          status: 'pending',
          startedTs: 1,
        }),
      ]);
      await new LocalGitWorkspaces(ctx).registerInitial({
        ...ctx.request,
        expectedRevision: (await ctx.control.snapshot()).revision,
        targets: ctx.request.targets.map((target) =>
          target.purpose === 'validation'
            ? { ...target, workerId: testerId }
            : target.purpose === 'coding'
              ? { ...target, workerId: initialCoderId }
              : target,
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
        join(validationRoot.path, 'follow-up.test.cjs'),
        failedSource
          ? "const { test } = require('node:test'); const { strictEqual } = require('node:assert'); const { readFileSync } = require('node:fs'); const { join } = require('node:path'); test('follow-up', () => { strictEqual(2 + 2, 4); strictEqual(readFileSync(join(__dirname, 'file.txt'), 'utf8'), 'repaired\\n'); });\n"
          : "const { test } = require('node:test'); const { strictEqual } = require('node:assert'); test('follow-up', () => strictEqual(2 + 2, 4));\n",
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
        subtasks: [
          { id: 'code', title: 'First', dependsOn: [] },
          ...(reviewerSource ? [] : [{ id: 'B', title: 'Second', dependsOn: ['code'] }]),
        ],
      };
      await ctx.store.commit(ctx.scope, [
        setMutation('phase', 'testing'),
        setMutation('architecture', { executionPlan: plan }),
        mergeByIdMutation('subtasks', 'code', {
          id: 'code',
          title: 'First',
          status: 'in_progress',
          worktree: coderRef,
        }),
        mergeByIdMutation('subtasks', 'B', {
          id: 'B',
          title: 'Second',
          ownerRole: 'CODER',
          dependsOn: ['code'],
          status: 'todo',
        }),
        mergeByIdMutation('workers', initialCoderId, {
          status: 'done',
          worktree: coderRef,
          subtaskId: 'code',
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
            coderWorkerIds: [initialCoderId],
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
            { workerId: initialCoderId, subtaskId: 'code', topologicalRank: 0, worktree: coderRef },
          ],
          mergedBranches: [
            {
              workerId: initialCoderId,
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
          display: 'First wave',
          ts: 2,
          payload: {
            kind: 'coding_wave',
            planId: 'plan',
            nextRole: 'CODER',
            attempt: 1,
            base: { branch: integration.branch, commit: integration.baseCommit },
            subtaskIds: ['code'],
            workerIds: [initialCoderId],
          },
        }),
        appendMutation('messages', {
          msgId: 'dispatch',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          display: 'Validate',
          ts: 3,
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
      const proveReview = async (
        state: Awaited<ReturnType<typeof ctx.control.assertClosed>>,
        workerId: string,
      ): Promise<WorkspaceVersionV1> => {
        if (!service) throw Error('local_git_review_proof_unavailable');
        return service.verifiedReviewVersion(state, workerId);
      };
      const sessions = await LocalWorkspaceSessions.create({
        ...ctx,
        filesHelper: resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        tools: {
          manifestHash: hash(manifestBytes),
          node: { path: node, sha256: hash(readFileSync(node)), version: manifest.versions.node },
          bootstrap: tool('local-command-bootstrap'),
          processControl: tool('local-process-control'),
        },
        grantForAssignment: async () => ctx.grant.grantId,
        versionForAssignment: async (admission) =>
          admission.role === 'REVIEWER'
            ? proveReview(await ctx.control.assertClosed(ctx.scope), admission.workerId)
            : undefined,
        verifyReviewCandidate: proveReview,
      });
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
      const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, testerId);
      try {
        const session = await sessions.open({
          ...ctx.scope,
          workerId: testerId,
          role: 'TESTER',
          sessionId: 'session:tester',
          assertLease: () => scheduler.assertActive(lease),
        });
        try {
          await session.checkpoint('complete');
          const completed = await session.completeWorktree?.();
          if (!completed?.headCommit) throw Error('missing completed TESTER worktree');
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', testerId, { worktree: completed }),
          ]);
          const mutations = await service.complete(
            await ctx.control.assertClosed(ctx.scope),
            testerId,
            session,
          );
          await ctx.store.commit(ctx.scope, mutations);
        } finally {
          await session.close();
        }
      } finally {
        await scheduler.release(lease);
      }
      const validated = await ctx.control.assertClosed(ctx.scope);
      const receiptMessage = validated.messages.find((m) => m.msgId === 'wave-validation:dispatch');
      if (!isWaveValidationReceipt(receiptMessage?.payload)) throw Error('missing native receipt');
      const accepted = receiptMessage.payload;
      const base = { branch: accepted.worktree.branch, commit: accepted.worktree.headCommit };
      if (reviewerSource) {
        expect(accepted.results.passed).toBe(true);
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', testerId, { status: 'done' }),
        ]);
        let sequence = 0;
        if (!validated.parallelExecution) throw Error('missing validated execution');
        const options = {
          newId: () => `review-control-${++sequence}`,
          now: () => 4 + sequence,
          parallel: {
            initialBase: validated.parallelExecution.initialBase,
            controlFingerprint: accepted.controlFingerprint,
          },
        };
        await ctx.store.commit(
          ctx.scope,
          decide(await ctx.control.assertClosed(ctx.scope), options).mutations,
        );
        const reviewing = await ctx.control.assertClosed(ctx.scope);
        const reviewer = reviewing.workers.find((worker) => worker.role === 'REVIEWER');
        if (!reviewer) throw Error('missing review dispatch');
        await service.verifiedReviewVersion(reviewing, reviewer.workerId);
        // The verdict is explicit control input; native provenance is real, not model execution.
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', reviewer.workerId, { status: 'done' }),
          appendMutation('reviewComments', {
            id: 'review-rework-verdict',
            kind: 'verdict',
            verdict: 'changes_requested',
            issueScope: 'implementation',
            summary: 'Repair the first contribution',
            subtaskIds: ['code'],
          }),
        ]);
        returnedDispatch = (
          await ctx.store.commit(
            ctx.scope,
            decide(await ctx.control.assertClosed(ctx.scope), options).mutations,
          )
        ).state;
        const wave = (await ctx.control.assertClosed(ctx.scope)).parallelExecution?.activeWave;
        if (!wave?.coderWorkerIds[0]) throw Error('missing review rework wave');
        codingWaveId = wave.waveId;
        codingAttempt = wave.attempt;
        coderId = wave.coderWorkerIds[0];
      } else if (failedSource) {
        expect(accepted.results).toMatchObject({ passed: false, total: 1, failed: 1 });
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', testerId, { status: 'done' }),
        ]);
        const current = await ctx.control.assertClosed(ctx.scope);
        if (!current.parallelExecution) throw Error('missing retry execution');
        returnedDispatch = (
          await ctx.store.commit(
            ctx.scope,
            decide(current, {
              newId: () => 'next-wave',
              now: () => 4,
              parallel: {
                initialBase: current.parallelExecution.initialBase,
                controlFingerprint: accepted.controlFingerprint,
              },
            }).mutations,
          )
        ).state;
      } else
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', testerId, { status: 'done' }),
          mergeByIdMutation('subtasks', 'code', { status: 'done' }),
          mergeByIdMutation('subtasks', 'B', { status: 'in_progress' }),
          mergeByIdMutation('workers', coderId, {
            role: 'CODER',
            executor: 'harness',
            status: 'pending',
            subtaskId: 'B',
            startedTs: 4,
          }),
          appendMutation('messages', {
            msgId: 'next-wave',
            channelId: 'main',
            fromRole: 'COORDINATOR',
            type: 'announce',
            display: 'Second wave',
            ts: 4,
            payload: {
              kind: 'coding_wave',
              planId: 'plan',
              nextRole: 'CODER',
              attempt: 1,
              base,
              subtaskIds: ['B'],
              workerIds: [coderId],
            },
          }),
          setMutation('parallelExecution', {
            version: 1,
            planId: 'plan',
            initialBase: { branch: integration.branch, commit: integration.baseCommit },
            acceptedReceiptId: 'wave-validation:dispatch',
            activeWave: {
              waveId: 'next-wave',
              attempt: 1,
              base,
              subtaskIds: ['B'],
              coderWorkerIds: [coderId],
            },
          }),
          setMutation('phase', 'coding'),
          setMutation('nextRole', 'CODER'),
          setMutation('integration', undefined),
        ]);
      const manager = new LocalGitWorkspaces({
        ...ctx,
        verifyAcceptedVersion: (state, receipt, version) =>
          service.verifiedAcceptedVersion(state, receipt, version),
      });
      const version = validated.testResults?.workspaceVersion;
      if (version?.kind !== 'git') throw Error('missing accepted Git version');
      let codingPreparation: LocalCodingPreparation | undefined;
      if ((failedSource || reviewerSource) && scenario === 'baseline') {
        const preparation = new LocalCodingPreparation({
          control: ctx.control,
          objects: ctx.objects,
          workspaces: manager,
          verifyReceipt: (state, receiptId) => service.verifyReceiptHead(state, receiptId),
          runTaskSerial: (scope, operation) =>
            serializeWorkspaceOperation(
              { ...scope, workspaceId: 'coding-task-control' },
              operation,
            ),
        });
        codingPreparation = preparation;
        if (!returnedDispatch) throw Error('missing returned coding dispatch');
        expect(
          returnedDispatch.subtasks.some(
            (s) => Object.hasOwn(s, 'worktree') && s.worktree === undefined,
          ),
        ).toBe(true);
        const prepared = await preparation.prepare(returnedDispatch);
        expect(prepared.parallelExecution?.acceptedReceiptId).toBe(
          reviewerSource ? 'wave-validation:dispatch' : undefined,
        );
        expect(await preparation.prepare(prepared)).toEqual(prepared);
      } else
        await manager.registerCodingWave({
          ...ctx.scope,
          actionId: 'register-second-wave',
          waveId: codingWaveId,
          attempt: codingAttempt,
          sourceWorkspaceId: validation.workspaceId,
          rootId: ctx.root.rootId,
          grantId: ctx.grant.grantId,
          expectedRevision: (await ctx.control.snapshot()).revision,
          version,
          targets: [{ workspaceId: 'coding-second', purpose: 'coding', workerId: coderId }],
        });
      mark('coding-registered');
      const before = await ctx.control.assertClosed(ctx.scope);
      const registry = await ctx.control.snapshot();
      writeFileSync(join(f.root, 'file.txt'), 'later user edit\n');
      if (scenario === 'baseline') {
        const baseline = await manager.readAcceptedCodingBaseline({
          ...ctx.scope,
          workerId: coderId,
        });
        expect(baseline.baseCommit).toBe(accepted.worktree.headCommit);
        expect(baseline.manifest.files.some((file) => file.path === 'follow-up.test.cjs')).toBe(
          true,
        );
        expect(baseline.manifest.files.find((file) => file.path === 'file.txt')?.contentHash).toBe(
          hash('working\n'),
        );
        expect(await ctx.control.assertClosed(ctx.scope)).toEqual(before);
        expect(await ctx.control.snapshot()).toEqual(registry);
      }
      expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
      expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
      const privateEvidence = join(
        ctx.owner.root,
        'projects',
        ctx.scope.projectId,
        'tasks',
        ctx.scope.taskId,
        'artifacts',
        'validation',
        'dispatch.json',
      );
      if (scenario === 'baseline') {
        renameSync(privateEvidence, `${privateEvidence}.held`);
        try {
          if (codingPreparation) await expect(codingPreparation.prepare(before)).rejects.toThrow();
          await expect(
            manager.readAcceptedCodingBaseline({ ...ctx.scope, workerId: coderId }),
          ).rejects.toThrow();
        } finally {
          renameSync(`${privateEvidence}.held`, privateEvidence);
        }
        const sourceFile = join(validationRoot.path, 'file.txt');
        writeFileSync(sourceFile, 'external validation drift\n');
        try {
          await expect(
            manager.readAcceptedCodingBaseline({ ...ctx.scope, workerId: coderId }),
          ).rejects.toThrow();
        } finally {
          writeFileSync(sourceFile, 'working\n');
        }
        const child = registry.linkedRoots?.find(
          (record) =>
            record.workspaceId ===
            before.localExecution?.bindings.find((binding) => binding.workerId === coderId)
              ?.workspaceId,
        );
        if (!child) throw Error('missing second-wave coding root');
        const childFile = join(child.path, 'file.txt');
        writeFileSync(childFile, 'external coding drift\n');
        try {
          await expect(
            manager.readAcceptedCodingBaseline({ ...ctx.scope, workerId: coderId }),
          ).rejects.toThrow();
        } finally {
          writeFileSync(childFile, 'working\n');
        }
        return;
      }
      const coderLease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, coderId);
      try {
        const worktree = await manager.resolveAssignment({ ...ctx.scope, workerId: coderId });
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', coderId, {
            status: 'running',
            sessionId: 'session:second-coder',
            worktree,
          }),
        ]);
        const coder = await sessions.open({
          ...ctx.scope,
          workerId: coderId,
          role: 'CODER',
          subtaskId: codingSubtask,
          sessionId: 'session:second-coder',
          assertLease: () => scheduler.assertActive(coderLease),
        });
        try {
          const read = await coder.tools.read(`tool:${hash('second-read')}`, 'second.txt');
          await coder.tools.apply(
            `tool:${hash('second-write')}`,
            [
              {
                path: 'second.txt',
                expected: read.version,
                readReceiptId: read.readReceiptId,
                content: 'second wave\n',
                encoding: 'utf8',
              },
            ],
            [],
          );
          if (scenario === 'receipt' || scenario === 'review') {
            const testFile = await coder.tools.read(
              `tool:${hash('second-test-read')}`,
              'second.test.cjs',
            );
            await coder.tools.apply(
              `tool:${hash('second-test-write')}`,
              [
                {
                  path: 'second.test.cjs',
                  expected: testFile.version,
                  readReceiptId: testFile.readReceiptId,
                  content:
                    "const { test } = require('node:test'); const { strictEqual } = require('node:assert'); const { readFileSync } = require('node:fs'); const { join } = require('node:path'); test('second wave', () => strictEqual(readFileSync(join(__dirname, 'second.txt'), 'utf8'), 'second wave\\n'));\n",
                  encoding: 'utf8',
                },
              ],
              [],
            );
          }
          if (failedSource) {
            const read = await coder.tools.read(`tool:${hash('repair-read')}`, 'file.txt');
            await coder.tools.apply(
              `tool:${hash('repair-write')}`,
              [
                {
                  path: 'file.txt',
                  expected: read.version,
                  readReceiptId: read.readReceiptId,
                  content: 'repaired\n',
                  encoding: 'utf8',
                },
              ],
              [],
            );
          }
          await coder.checkpoint('complete');
          const completed = await coder.completeWorktree?.();
          if (!completed?.headCommit) throw Error('missing completed second CODER tree');
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', coderId, { worktree: completed }),
            mergeByIdMutation('subtasks', codingSubtask, { worktree: completed }),
          ]);
        } finally {
          await coder.close();
        }
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', coderId, { status: 'done' }),
        ]);
      } finally {
        await scheduler.release(coderLease);
      }
      mark('coding-completed');
      const integrationRegistration = {
        ...ctx.scope,
        actionId: 'register-second-integration',
        waveId: codingWaveId,
        attempt: codingAttempt,
        sourceWorkspaceId: validation.workspaceId,
        rootId: ctx.root.rootId,
        grantId: ctx.grant.grantId,
        expectedRevision: (await ctx.control.snapshot()).revision,
        version,
        targets: [{ workspaceId: 'integration-second', purpose: 'integration' as const }],
      };
      const target = await manager.registerIntegrationWave(integrationRegistration);
      expect(target).toHaveLength(1);
      if (target[0]?.mode !== 'linked-worktree') throw Error('missing linked integration');
      expect(target[0]?.baseCommit).toBe(accepted.worktree.headCommit);
      const secondRoot = (await ctx.control.snapshot()).linkedRoots?.find(
        (record) => record.workspaceId === 'integration-second',
      );
      if (!secondRoot) throw Error('missing second integration root');
      expect(readFileSync(join(secondRoot.path, 'follow-up.test.cjs'), 'utf8')).toContain(
        'follow-up',
      );
      expect(readFileSync(join(secondRoot.path, 'file.txt'), 'utf8')).toBe('working\n');
      expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
      const ready = await ctx.control.assertClosed(ctx.scope);
      const wavePlan = planIntegrationWave(ready, {
        waveId: codingWaveId,
        workerIds: [coderId],
        baseBranch: base.branch,
      });
      let nativeBatches: LocalIntegrationTreeBatch | undefined;
      const authority = new LocalIntegrationAuthority({
        ...ctx,
        assertControl: async () => {
          await ctx.control.assertClosed(ctx.scope);
        },
        verifyClosure: async (claim) => {
          if (!nativeBatches) throw Error('missing native batches');
          return nativeBatches.closure(claim);
        },
      });
      const prepared = await new LocalIntegrationPreparation({
        ...ctx,
        request: {
          ...ctx.scope,
          actionId: 'prepare-second-integration',
          workspaceId: 'integration-second',
          registration: integrationRegistration,
        },
        workspaces: manager,
        authority,
        state: ctx.store,
        assertControl: async () => {
          await ctx.control.assertClosed(ctx.scope);
        },
      }).prepare(ready, wavePlan);
      mark('integration-prepared');
      expect(prepared.state.phase).toBe('integrating');
      expect(prepared.state.integration?.base).toEqual(base);
      expect(prepared.state.integration?.integrationWorktree.path).toBe(secondRoot.path);
      expect(prepared.call.workspaceId).toBe('integration-second');
      const source =
        scenario === 'published'
          ? await new LocalIntegrationSources({
              authority,
              sessions,
              workspaces: manager,
            }).readNext(prepared.call)
          : undefined;
      if (source) {
        expect(source.selection.base).toEqual(base);
        expect(source.baseline.baseCommit).toBe(base.commit);
        expect(source.source.worktree.headCommit).toBe(
          prepared.state.integration?.pendingBranches[0]?.worktree.headCommit,
        );
      }
      const helper = resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64');
      nativeBatches = await LocalIntegrationTreeBatch.open(
        ctx.owner,
        ctx.objects,
        ctx.versions,
        authority,
        helper,
      );
      const batches = nativeBatches;
      const candidates = new LocalIntegrationCandidates({
        ...ctx,
        authority,
        sources: new LocalIntegrationSources({ authority, sessions, workspaces: manager }),
        candidates: await LocalMergeCandidates.open(ctx.owner, ctx.objects, ctx.versions, helper),
        historyBatches: batches,
      });
      const publication = new LocalIntegrationPublication({
        ...ctx,
        authority,
        candidates,
        batches,
        state: ctx.store,
      });
      const application = { call: prepared.call, actionId: 'apply-second-wave' };
      const applied = await publication.applyNext(application);
      mark('application-published');
      expect(applied.publication.previousCommit).toBe(base.commit);
      expect(readFileSync(join(secondRoot.path, 'second.txt'), 'utf8')).toBe('second wave\n');
      if (scenario === 'published') {
        if (!source) throw Error('missing current source');
        const replayed = await new LocalIntegrationSources({
          authority,
          sessions,
          workspaces: manager,
        }).readPublished(application);
        expect(replayed.baseline.baseCommit).toBe(base.commit);
        expect(replayed.source.worktree.headCommit).toBe(source.source.worktree.headCommit);
        renameSync(privateEvidence, `${privateEvidence}.held`);
        try {
          await expect(
            new LocalIntegrationSources({
              authority,
              sessions,
              workspaces: manager,
            }).readPublished(application),
          ).rejects.toThrow();
        } finally {
          renameSync(`${privateEvidence}.held`, privateEvidence);
        }
        return;
      }
      await publication.acknowledgePublished(application);
      mark('application-acknowledged');
      const acknowledged = await ctx.control.assertClosed(ctx.scope);
      expect(acknowledged.integration?.mergedBranches).toHaveLength(1);
      expect(acknowledged.integration?.mergedBranches[0]?.mergeCommit).toBe(
        applied.publication.commit,
      );
      if (
        scenario === 'handoff' ||
        scenario === 'validation' ||
        scenario === 'receipt' ||
        scenario === 'review'
      ) {
        const completion = new LocalIntegrationCompletion({
          ...ctx,
          authority,
          candidates,
          state: { compareAndCommit: ctx.store.compareAndCommit.bind(ctx.store) },
        });
        const complete = await completion.complete(prepared.call, acknowledged);
        mark('integration-completed');
        expect(complete.integration?.status).toBe('done');
        expect(complete.integration?.resultCommit).toBe(applied.publication.commit);
        const handoff = new LocalIntegrationHandoff({
          ...ctx,
          authority,
          completion,
          batches,
        });
        const released = await handoff.release(prepared.call);
        mark('integration-released');
        expect(released.state.integration).toEqual(complete.integration);
        expect(released.version).toMatchObject({
          kind: 'git',
          commit: applied.publication.commit,
        });
        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
        if (scenario === 'validation' || scenario === 'receipt' || scenario === 'review') {
          const initialBase = released.state.parallelExecution?.initialBase;
          if (!initialBase) throw Error('missing validation context');
          const context = { initialBase, controlFingerprint: 'f'.repeat(64) };
          const roster = [
            {
              role: 'TESTER' as const,
              executor: 'harness' as const,
              systemPrompt: '',
              tools: [],
              projection: [],
              routeWhen: 'always' as const,
            },
            {
              role: 'REVIEWER' as const,
              executor: 'harness' as const,
              systemPrompt: '',
              tools: [],
              projection: [],
              routeWhen: 'always' as const,
            },
          ];
          const scope = {
            ...ctx.scope,
            waveId: codingWaveId,
            attempt: codingAttempt,
            integrationId: prepared.call.integrationId,
          };
          const records = new LocalValidationPreparationRecords(ctx.objects);
          const validationPublication = new LocalValidationPreparationPublication({
            control: ctx.control,
            objects: ctx.objects,
            records,
            handoff,
          });
          const preparationControl = new LocalValidationPreparationControl({
            control: ctx.control,
            objects: ctx.objects,
            records,
            verifier: createValidationDispatchVerifier(async () => ({ context, roster })),
          });
          const physical = new LocalValidationPreparationSource({
            control: preparationControl,
            completion,
          });
          const proof = new LocalValidationGitRegistrationSource({
            control: ctx.control,
            objects: ctx.objects,
            records,
            physical,
            preparationControl,
          });
          const validationWorkspaces = new LocalGitWorkspaces({
            ...ctx,
            verifyValidationPreparation: proof.verifyBefore.bind(proof),
            verifyValidationSlot: proof.verifySlot.bind(proof),
            verifyValidationRegistered: proof.verifyRegistered.bind(proof),
          });
          const confirmation = new LocalValidationPreparationConfirmation({
            control: ctx.control,
            objects: ctx.objects,
            records,
            workspaces: validationWorkspaces,
          });
          const preparation = new LocalInitialValidationPreparation({
            runTaskSerial: (current, operation) =>
              serializeWorkspaceOperation(
                { ...current, workspaceId: 'validation-task-control' },
                operation,
              ),
            createInitialInput: async () => ({
              scope,
              call: prepared.call,
              actionId: 'prepare-second-validation',
              validationWorkspaceId: 'validation-second',
              seed: {
                dispatchId: 'second-validation',
                dispatchTs: 40,
                ledgerId: 'second-validation-progress',
                ledgerTs: 41,
              },
            }),
            dispatch: {
              source: physical,
              state: ctx.store,
              readControl: async () => ({ context, roster }),
              publication: validationPublication,
            },
            control: ctx.control,
            objects: ctx.objects,
            records,
            physical,
            confirmation,
            workspaces: validationWorkspaces,
          });
          const dispatched = await preparation.prepare(released.state);
          mark('validation-registered');
          expect(dispatched.phase).toBe('testing');
          expect(dispatched.parallelExecution?.activeWave?.validation).toMatchObject({
            dispatchId: 'second-validation',
            workerId: 'worker:second-validation:0',
            integrationId: prepared.call.integrationId,
            inputCommit: applied.publication.commit,
          });
          const registered = await confirmation.read(scope);
          expect(registered.workspaceId).toBe('validation-second');
          expect(registered.workerId).toBe('worker:second-validation:0');
          expect(await preparation.admit(dispatched, registered.workerId)).toEqual(dispatched);
          expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
          expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
          if (scenario === 'receipt' || scenario === 'review') {
            const testerId = registered.workerId;
            const admissionWorkspaces = new LocalGitWorkspaces({
              ...ctx,
              verifyValidationAdmission: async (state, workerId) => {
                await confirmation.admitPending(state, workerId);
              },
            });
            const testerWorktree = await admissionWorkspaces.resolveAssignment({
              ...ctx.scope,
              workerId: testerId,
            });
            await ctx.store.commit(ctx.scope, [
              mergeByIdMutation('workers', testerId, {
                status: 'running',
                worktree: testerWorktree,
              }),
            ]);
            const testerLease = await scheduler.acquire(
              ctx.scope.projectId,
              ctx.scope.taskId,
              testerId,
            );
            try {
              const testerSession = await sessions.open({
                ...ctx.scope,
                workerId: testerId,
                role: 'TESTER',
                sessionId: 'session:worker:second-validation:0',
                assertLease: () => scheduler.assertActive(testerLease),
              });
              try {
                await testerSession.checkpoint('complete');
                const completedTest = await testerSession.completeWorktree?.();
                if (!completedTest?.headCommit) throw Error('missing second TESTER worktree');
                await ctx.store.commit(ctx.scope, [
                  mergeByIdMutation('workers', testerId, { worktree: completedTest }),
                ]);
                await ctx.store.commit(
                  ctx.scope,
                  await service.complete(
                    await ctx.control.assertClosed(ctx.scope),
                    testerId,
                    testerSession,
                  ),
                );
              } catch (error) {
                writeFileSync(
                  join(f.privateRoot, 'second-validation-failure.json'),
                  JSON.stringify({
                    stage: 'fixed-command-or-receipt',
                    code:
                      error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/.test(error.message)
                        ? error.message
                        : 'unknown_error',
                  }),
                );
                throw error;
              } finally {
                await testerSession.close();
              }
            } finally {
              await scheduler.release(testerLease);
            }
            mark('second-validation-receipt');
            const validatedSecond = await ctx.control.assertClosed(ctx.scope);
            const receipt = validatedSecond.messages.find(
              (message) => message.msgId === 'wave-validation:second-validation',
            );
            if (!isWaveValidationReceipt(receipt?.payload))
              throw Error('missing second wave validation receipt');
            expect(receipt.payload.results).toMatchObject({ passed: true, total: 2, failed: 0 });
            expect(receipt.payload.inputCommit).toBe(applied.publication.commit);
            expect(validatedSecond.testResults?.workspaceVersion).toMatchObject({ kind: 'git' });
            expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
            expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
            if (scenario === 'review') {
              await ctx.store.commit(ctx.scope, [
                mergeByIdMutation('workers', testerId, { status: 'done' }),
              ]);
              let serial = 0;
              const reviewDecision = decide(await ctx.control.assertClosed(ctx.scope), {
                parallel: {
                  ...context,
                  controlFingerprint: receipt.payload.controlFingerprint,
                },
                roster,
                newId: () => `second-review-control-${++serial}`,
                now: () => 50 + serial,
              });
              expect(reviewDecision.route).toMatchObject({
                kind: 'worker',
                batch: [{ role: 'REVIEWER' }],
              });
              await ctx.store.commit(ctx.scope, reviewDecision.mutations);
              const reviewState = await ctx.control.assertClosed(ctx.scope);
              const reviewDispatch = [...reviewState.messages]
                .reverse()
                .find((message) => message.payload.kind === 'parallel_review_dispatch');
              const reviewerIds = reviewDispatch?.payload.workerIds;
              const reviewerId = Array.isArray(reviewerIds) ? reviewerIds[0] : undefined;
              if (typeof reviewerId !== 'string') throw Error('missing second review dispatch');
              await expect(proveReview(reviewState, reviewerId)).resolves.toEqual(
                validatedSecond.testResults?.workspaceVersion,
              );
              mark('second-review-proof');
              const reviewWorkspaces = new LocalGitWorkspaces({
                ...ctx,
                verifyReviewCandidate: proveReview,
              });
              await reviewWorkspaces.registerReviewer({ ...ctx.scope, workerId: reviewerId });
              mark('second-review-registered');
              await expect(
                reviewWorkspaces.resolveAssignment({ ...ctx.scope, workerId: reviewerId }),
              ).resolves.toEqual(receipt.payload.worktree);
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
                const reviewSession = await sessions.open({
                  ...ctx.scope,
                  workerId: reviewerId,
                  role: 'REVIEWER',
                  sessionId: `session:${reviewerId}`,
                  assertLease: () => scheduler.assertActive(reviewLease),
                });
                try {
                  const reviewed = await reviewSession.tools.read(
                    `tool:${hash('second-review-read')}`,
                    'second.test.cjs',
                  );
                  expect(reviewed.kind).toBe('file');
                  if (reviewed.kind !== 'file') throw Error('missing cumulative review input');
                  expect(reviewed.content.toString('utf8')).toContain("test('second wave'");
                  await expect(
                    reviewSession.tools.apply(
                      `tool:${hash('second-review-write')}`,
                      [
                        {
                          path: 'second.test.cjs',
                          expected: reviewed.version,
                          readReceiptId: reviewed.readReceiptId,
                          content: 'forbidden',
                          encoding: 'utf8',
                        },
                      ],
                      [],
                    ),
                  ).rejects.toThrow('authorization_closed');
                  expect(reviewSession.completeWorktree).toBeUndefined();
                  expect(reviewSession.runFixedGitValidation).toBeUndefined();
                } finally {
                  await reviewSession.close();
                }
              } finally {
                await scheduler.release(reviewLease);
              }
              mark('second-review-read-only');
              expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
              expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
            }
          }
        }
      }
    }),
  );
}

it(
  'registers a failed validation source without advancing accepted progress',
  () => runAcceptedScenario('baseline', true),
  600_000,
);
it(
  'repairs and revalidates the first failed Git wave through independent TESTER',
  () => runAcceptedScenario('receipt', true),
  3_600_000,
);
it(
  'registers a canonical REVIEWER rework from its verified validation tree',
  () => runAcceptedScenario('baseline', false, true),
  600_000,
);

it.each(['baseline', 'published', 'ack'] as const)(
  'proves accepted second-wave source: %s',
  (scenario) => runAcceptedScenario(scenario),
  600_000,
);

it(
  'proves accepted second-wave Integration completion and released handoff',
  () => runAcceptedScenario('handoff'),
  2_700_000,
);

it(
  'registers an independent TESTER worktree from the accepted second-wave Integration',
  () => runAcceptedScenario('validation'),
  3_600_000,
);

it(
  'executes cumulative TESTER tests and records the accepted second-wave receipt',
  () => runAcceptedScenario('receipt'),
  3_600_000,
);

it(
  'dispatches and registers REVIEWER against the accepted second-wave validated version',
  () => runAcceptedScenario('review'),
  3_600_000,
);
