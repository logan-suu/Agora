// Real Coordinator, WorkerRuntime, scheduler, persistence and native commands.
// Mock reason (R11): a deterministic Executor isolates lifecycle ordering from
// the external model. Fault probes close admission after the first native write
// or drop the final completion marker; native effects and other records stay real.
// Actual Harness/provider/D16 acceptance remains separate.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mutation } from '@agora/core-domain';
import {
  appendMutation,
  applyMutations,
  buildCompletionResolution,
  currentApprovedReviewId,
  currentCompletionEvidence,
  currentLocalCompletionEvidence,
  deliveryReaderAssignment,
  deliveryValidationDispatch,
  isLocalReviewBinding,
  latestCoordinationLedger,
  type Message,
  parseWorkspaceControl,
} from '@agora/core-domain';
import { decide, type GlobalScheduler, WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import type { WorkspaceWorkerSession } from '@agora/runtime-sandbox';
import { expect } from 'vitest';
import { LocalDeliveryApplication } from '../../../apps/web/src/server/local-delivery-application';
import { LocalDeliveryApplicationProposals } from '../../../apps/web/src/server/local-delivery-application-proposals';
import { LocalDeliveryApplyControl } from '../../../apps/web/src/server/local-delivery-apply-control';
import { LocalDeliveryFinalization } from '../../../apps/web/src/server/local-delivery-finalization';
import { LocalDeliveryRevalidation } from '../../../apps/web/src/server/local-delivery-revalidation';
import { LocalDeliveryRevalidationControl } from '../../../apps/web/src/server/local-delivery-revalidation-control';
import { createLocalDirectDeliveryComparisons } from '../../../apps/web/src/server/local-direct-delivery-composition';
import { LocalValidationService } from '../../../apps/web/src/server/local-validation';
import { completeLocalTesterAssignment } from '../../../apps/web/src/server/local-validation-routing';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import type { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { LocalDeliveryAuthority } from '../../../packages/runtime/sandbox/src/local-delivery-authority';
import { LocalDeliveryCandidates } from '../../../packages/runtime/sandbox/src/local-delivery-candidates';
import { LocalDeliveryTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';

export async function exerciseDeliveryValidation(input: {
  options: Parameters<typeof LocalWorkspaceSessions.create>[0];
  local: LocalWorkspaceSessions;
  runtime: MessageRuntime;
  scheduler: GlobalScheduler;
  root: string;
  expectedPass: boolean;
  repairValidation?: boolean;
  repairOrchestration?: boolean;
  repairLive?: boolean;
  rejectCompletion?: boolean;
  reviewRepair?: boolean;
  liveHarness?: boolean;
  liveApplication?: 'before_approval' | 'after_approval' | undefined;
  applicationPreview?: boolean;
  applicationAdmission?: boolean;
  applicationEffects?:
    | 'success'
    | 'receipt'
    | 'receipt-recovery'
    | 'post'
    | 'finalize'
    | 'partial'
    | 'missing-completion'
    | undefined;
}) {
  const scope = { projectId: 'project', taskId: 'task' };
  const { options, runtime, scheduler } = input;
  const began = Date.now();
  const mark = (stage: string) =>
    writeFileSync(
      join(options.owner.root, 'delivery-validation-stage.json'),
      JSON.stringify({ stage, elapsedMs: Date.now() - began }),
    );
  mark('starting');
  let before = await options.control.assertClosed(scope);
  if (input.applicationEffects === 'finalize' || input.liveApplication) {
    const local = structuredClone(before.localExecution);
    if (!local || local.delivery || !local.rootIds[0]) throw Error('fixture_delivery_goal_not_new');
    local.delivery = {
      schemaVersion: 'local-delivery-v1',
      rootId: local.rootIds[0],
      goal: 'apply_to_directory',
      currentRoundId: null,
      rounds: [],
    };
    const snapshot = await options.control.snapshot();
    await options.control.commitBinding({
      ...scope,
      actionId: 'delivery-finalize-goal',
      sourceMessageId: snapshot.grants[0]?.leaderMessageId ?? 'missing',
      expectedRevision: snapshot.revision,
      nextLocalExecution: local,
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        workspaces: snapshot.workspaces,
        claims: snapshot.claims,
      },
    });
    before = await options.control.assertClosed(scope);
  }
  expect(before.phase).toBe('done');
  const original = readFileSync(join(input.root, 'sentinel'), 'utf8');
  const comparisons = createLocalDirectDeliveryComparisons(options, input.local);
  const compared = await comparisons.prepare(scope);
  mark('compared');
  expect(compared.comparison.status).toBe('requires_validation');
  const candidates = await LocalDeliveryCandidates.open(
    options.owner,
    options.objects,
    options.versions,
    comparisons,
  );
  const controller = new LocalDeliveryRevalidation(
    options.control,
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
  const action = {
    ...scope,
    actionId: 'fixture-revalidate',
    expectedRevision: (await options.control.snapshot()).revision,
    deliveryComparisonId: compared.deliveryComparisonId,
    inputHash: compared.inputHash,
  };
  const display = `/workspace revalidate ${JSON.stringify(action)}`;
  const message: Message = {
    msgId: action.actionId,
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    ts: Date.now(),
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  if (input.liveHarness) {
    const { exerciseDeliveryHarness } = await import('./local-delivery-harness-fixture');
    const proof = await exerciseDeliveryHarness({
      options,
      candidates,
      repair: input.repairLive === true,
      rejectCompletion: input.rejectCompletion === true,
      reviewRepair: input.reviewRepair === true,
      ...(input.repairLive
        ? {
            expectedFiles: {
              sentinel: 'fixed user content',
              ...(input.reviewRepair
                ? {
                    'review-note.txt': 'reviewed delivery',
                    'delivery-user-note.txt': 'preserve this independent edit',
                  }
                : {}),
              'sentinel.test.cjs': readFileSync(join(input.root, 'sentinel.test.cjs'), 'utf8'),
            },
          }
        : {}),
      runtime,
      scheduler,
      root: input.root,
      started: before,
      applyOrder: input.liveApplication,
      registration: controller,
      register: async (tasks) => {
        let registered: typeof before | undefined;
        let starts = 0;
        runtime.bindWorkspaceControlPort(
          new LocalDeliveryRevalidationControl(
            controller,
            (s) => runtime.store.load(s),
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
                ...scope,
                channelId: 'main',
                msgId: message.msgId,
                display: message.display,
              }),
            }),
          );
        const response = await post();
        const result = await response.json();
        expect(response.status, JSON.stringify(result)).toBe(202);
        expect(starts).toBe(1);
        const replay = await post();
        expect(replay.status).toBe(202);
        expect(await replay.json()).toMatchObject({ published: false });
        expect(starts).toBe(1);
        if (!registered) throw Error('missing_registered_round');
        expect(registered.workers).toEqual(before.workers);
        expect(registered.iterationCount).toBe(before.iterationCount);
        return registered;
      },
    });
    const after = await options.control.assertClosed(scope);
    await controller.commit(scope, { ...message, ts: Date.now() });
    expect(await options.control.assertClosed(scope)).toEqual(after);
    expect(readFileSync(join(input.root, 'sentinel'), 'utf8')).toBe(original);
    return proof;
  }
  const started = await controller.commit(scope, message);
  mark('round-registered');
  const selected = deliveryValidationDispatch(started);
  if (!selected) throw Error('missing_delivery_dispatch');
  expect(started.phase).toBe('testing');
  expect(started.testResults).toBeUndefined();
  expect(started.workers).toEqual(before.workers);
  expect(started.iterationCount).toBe(before.iterationCount);
  const candidate = await candidates.read(compared.deliveryComparisonId);
  expect(candidate.version).not.toEqual(compared.source.artifact);

  const workerId = selected.workerId;
  const toolAction = (kind: string) =>
    `tool:${localRecordHash({ ...scope, workerId, roundId: selected.round.roundId, kind })}`;
  const local = await LocalWorkspaceSessions.create({
    ...options,
    deliveryCandidates: candidates,
    versionForAssignment: async (admission) => {
      const selected = deliveryReaderAssignment(
        await options.control.assertClosed(scope),
        admission.workerId,
      );
      if (selected?.workerId !== admission.workerId) throw Error('unexpected_delivery_worker');
      return selected.round.candidateVersion;
    },
  });
  const validator = new LocalValidationService(local, () => options.control.assertClosed(scope));
  const validationReceiptId = `workspace-validation:${selected.message.msgId}`;
  let commandReceiptId: string | undefined;
  let workspaceId: string | undefined;
  const createRuntime = (
    read: (session: WorkspaceWorkerSession) => Promise<void>,
    complete?: (session: WorkspaceWorkerSession) => Promise<readonly Mutation[]>,
  ) =>
    new WorkerRuntime(
      {
        roster: DEFAULT_ROSTER,
        loadState: () => runtime.store.load(scope),
        transition: async (_old, mutations) =>
          (await runtime.commitMutations(scope, mutations)).state,
        localWorkspace: local,
        resolveWorktree: async () => {
          throw Error('fixed_candidate_must_not_resolve_old_git_wave');
        },
        buildExecutor: () => {
          throw Error('unexpected_legacy_executor');
        },
        buildLocalExecutor: async (_spec, _assignment, session) => ({
          async step() {
            await read(session);
            return { kind: 'done' as const, output: {}, reachedSafeBoundary: true, mutations: [] };
          },
          async saveSafePoint() {
            throw Error('deterministic_fixture_has_no_harness_checkpoint');
          },
          async loadSafePoint() {
            throw Error('deterministic_fixture_has_no_harness_checkpoint');
          },
          injectInbox() {},
        }),
        completeLocalAssignment: async (_state, _assignment, session) =>
          complete ? complete(session) : [],
      },
      scheduler,
    );
  const testerRuntime = createRuntime(
    async (session) => {
      workspaceId = session.workspace.workspaceId;
      mark('session-open');
      const assigned = await options.control.assertClosed(scope);
      const grant = (await options.control.snapshot()).grants.find(
        (entry) => entry.grantId === selected.round.grantId,
      );
      if (!grant) throw Error('missing_delivery_grant');
      for (const [state, id, version, authority] of [
        [assigned, 'worker', candidate.version, grant],
        [assigned, workerId, compared.source.artifact, grant],
        [assigned, workerId, candidate.version, { ...grant, revision: grant.revision + 1 }],
        [{ ...assigned, phase: 'coding' as const }, workerId, candidate.version, grant],
      ] as const) {
        await expect(candidates.validationBinding(state, id, version, authority)).rejects.toThrow(
          'delivery_candidate_assignment_mismatch',
        );
      }
      const read = await session.tools.read(toolAction('read'), 'sentinel');
      expect(read.kind).toBe('file');
      if (read.kind !== 'file') throw Error('missing_candidate_file');
      expect(read.content.toString('utf8')).toBe(original);
      if (input.expectedPass) {
        const note = await session.tools.read(
          toolAction('read-user-note'),
          'delivery-user-note.txt',
        );
        expect(note.kind).toBe('file');
        if (note.kind !== 'file') throw Error('missing_user_edit');
        expect(note.content.toString('utf8')).toBe('preserve this independent edit');
      }
      await expect(
        session.tools.apply(
          toolAction('write'),
          [
            {
              path: 'sentinel',
              expected: read.version,
              readReceiptId: read.readReceiptId,
              content: 'forbidden',
              encoding: 'utf8',
            },
          ],
          [],
        ),
      ).rejects.toThrow('authorization_closed');
      const inspection = await session.tools.inspect(toolAction('inspect'));
      expect(inspection.version).toEqual(candidate.version);
    },
    async (session) => {
      const mutations = await completeLocalTesterAssignment(
        await options.control.assertClosed(scope),
        workerId,
        session,
        { direct: validator },
      );
      const committed = {
        state: applyMutations(await options.control.assertClosed(scope), mutations),
      };
      const receipt = await validator.verify(committed.state, validationReceiptId);
      mark('command-complete');
      expect(receipt.results).toMatchObject({
        passed: input.expectedPass,
        total: 2,
        failed: input.expectedPass ? 0 : 1,
      });
      expect(receipt.workspaceVersion).toEqual(candidate.version);
      expect(receipt.roundId).toBe(selected.round.roundId);
      expect(receipt.sourceWorkspaceId).toBe(session.workspace.workspaceId);
      expect(committed.state.testResults).toEqual(receipt.results);
      expect(
        await completeLocalTesterAssignment(committed.state, workerId, session, {
          direct: validator,
        }),
      ).toEqual([]);
      commandReceiptId = receipt.commandReceiptId;
      return mutations;
    },
  );
  const testRoute = decide(started).route;
  if (testRoute.kind !== 'worker' || testRoute.batch[0].workerId !== workerId)
    throw Error('missing_delivery_test_route');
  await testerRuntime.runOne(started, testRoute.batch[0]);
  expect(
    (await options.control.assertClosed(scope)).workers.find((w) => w.workerId === workerId)
      ?.status,
  ).toBe('done');
  expect(scheduler.activeCount).toBe(0);
  if (!workspaceId || !commandReceiptId) throw Error('missing_native_delivery_proof');
  const verified = await local.verifyCommand({ ...scope, workspaceId }, commandReceiptId);
  expect(verified.command.inputVersion).toEqual(candidate.version);
  await local.verifyCurrentVersion({ ...scope, workspaceId }, candidate.version);
  mark('proof-verified');
  let after = await options.control.assertClosed(scope);
  await validator.verify(after, validationReceiptId);
  if (input.expectedPass)
    expect(await validator.reviewBinding(after, validationReceiptId)).toMatchObject({
      roundId: selected.round.roundId,
      workspaceVersion: candidate.version,
    });
  else
    await expect(validator.reviewBinding(after, validationReceiptId)).rejects.toThrow(
      'local_review_requires_passing_validation',
    );
  expect(() => currentLocalCompletionEvidence(after)).toThrow();
  let reviewerId: string | undefined;
  if (input.expectedPass) {
    const binding = await validator.reviewBinding(after, validationReceiptId);
    const decision = decide(after);
    if (decision.route.kind !== 'worker' || decision.route.batch[0].role !== 'REVIEWER')
      throw Error('missing_delivery_review_route');
    reviewerId = decision.route.batch[0].workerId;
    await runtime.commitMutations(scope, decision.mutations);
    const reviewerRuntime = createRuntime(async (review) => {
      const action = (kind: string) =>
        `tool:${localRecordHash({ ...scope, workerId: reviewerId, kind })}`;
      const read = await review.tools.read(action('read'), 'delivery-user-note.txt');
      if (read.kind !== 'file') throw Error('missing_review_candidate');
      expect(read.content.toString('utf8')).toBe('preserve this independent edit');
      await expect(
        review.tools.apply(
          action('write'),
          [
            {
              path: 'delivery-user-note.txt',
              expected: read.version,
              readReceiptId: read.readReceiptId,
              content: 'forbidden',
              encoding: 'utf8',
            },
          ],
          [],
        ),
      ).rejects.toThrow('authorization_closed');
      expect((await review.tools.inspect(action('inspect'))).version).toEqual(candidate.version);
    });
    await reviewerRuntime.runOne(
      await options.control.assertClosed(scope),
      decision.route.batch[0],
    );
    expect(scheduler.activeCount).toBe(0);
    after = await options.control.assertClosed(scope);
    expect(currentLocalCompletionEvidence(after)).toEqual(binding);
    if (input.applicationPreview) {
      if (input.applicationEffects) {
        for (const path of ['agent-created.txt', 'agent-other.txt'])
          unlinkSync(join(input.root, path));
      }
      const nextComparison = await createLocalDirectDeliveryComparisons(options, local).prepare(
        scope,
      );
      expect(nextComparison.source.baseline).toEqual(compared.source.baseline);
      expect(nextComparison.source.artifact).toEqual(candidate.version);
      expect(nextComparison.source.sourceReceipts.artifact).toBe(validationReceiptId);
      expect(nextComparison.comparison.status).toBe('matches_artifact');
      const proposals = new LocalDeliveryApplicationProposals(
        options.objects,
        createLocalDirectDeliveryComparisons(options, local),
        () => options.control.assertClosed(scope),
      );
      await expect(proposals.prepare(scope, nextComparison.deliveryComparisonId)).rejects.toThrow();
      after = (
        await runtime.commitMutations(scope, [
          appendMutation('reviewComments', {
            id: 'fixture-current-delivery-review',
            kind: 'verdict',
            verdict: 'approved',
          }),
        ])
      ).state;
      const proposal = await proposals.prepare(scope, nextComparison.deliveryComparisonId);
      if (!isLocalReviewBinding(proposal.evidence)) throw Error('expected_file_review_binding');
      expect(proposal.evidence.workspaceVersion).toEqual(candidate.version);
      expect(proposal.roundId).toBe(selected.round.roundId);
      expect(proposal.source.baseline).toEqual(compared.source.baseline);
      expect(
        await proposals.verifyCurrent(scope, proposal.deliveryProposalId, proposal.inputHash),
      ).toEqual(proposal);
      await expect(
        proposals.verifyCurrent(scope, proposal.deliveryProposalId, '0'.repeat(64)),
      ).rejects.toThrow('delivery_application_proposal_changed');
      if (input.applicationAdmission) {
        let faultActive = false;
        const authority = new LocalDeliveryAuthority({
          control: options.control,
          verifyCurrent: (s, id, hash) => proposals.verifyCurrent(s, id, hash),
          verifyBinding: (s, id, hash) => proposals.verifyBinding(s, id, hash),
          verifyGrant: async (s, grantId) => {
            await options.verifyGrant(s, grantId);
            if (
              faultActive &&
              input.applicationEffects === 'partial' &&
              existsSync(join(input.root, 'agent-created.txt'))
            )
              throw Error('fixture_delivery_authority_closed');
          },
          verifyClosedClaim: (s, claim) => local.verifyClosedClaim(s, claim),
          assertControl: async (state) => {
            expect(scheduler.activeCount).toBe(0);
            if (state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status)))
              throw Error('delivery_application_busy');
          },
        });
        const registry = await options.control.snapshot();
        const action = {
          ...scope,
          actionId: 'fixture-apply-c',
          expectedRevision: registry.revision,
          deliveryProposalId: proposal.deliveryProposalId,
          inputHash: proposal.inputHash,
        };
        const display = `/workspace apply ${JSON.stringify(action)}`;
        const source: Message = {
          msgId: action.actionId,
          fromRole: 'leader',
          channelId: 'main',
          type: 'chat',
          ts: Date.now(),
          display,
          payload: {
            kind: 'leader_intent',
            intent: parseWorkspaceControl(display),
            action: { status: 'applied' },
          },
        };
        if (input.applicationEffects === 'post') {
          const batch = await LocalDeliveryTreeBatch.open(
            options.owner,
            options.objects,
            options.versions,
            authority,
            options.filesHelper,
          );
          const application = new LocalDeliveryApplication({
            control: options.control,
            objects: options.objects,
            authority,
            proposals,
            batch,
          });
          runtime.bindWorkspaceControlPort(
            new LocalDeliveryApplyControl({
              control: options.control,
              authority,
              batch,
              application,
              fallback: {
                commit: async () => {
                  throw Error('fixture_control_not_selected');
                },
              },
            }),
          );
          const events: { msgId?: string }[] = [];
          const unsubscribe = runtime.stream.subscribe({ ...scope, channelId: 'main' }, (event) => {
            if (event.type === 'message') events.push(event.data as { msgId?: string });
          });
          const post = () =>
            createPostMessage(runtime)(
              new Request('http://localhost/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  ...scope,
                  channelId: 'main',
                  msgId: source.msgId,
                  display: source.display,
                }),
              }),
            );
          try {
            const response = await post();
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(202);
            expect(body).toMatchObject({ accepted: true, published: true });
            const current = await options.control.assertClosed(scope);
            const receipt = current.messages.at(-1);
            expect(receipt?.payload.kind).toBe('workspace_delivery_application');
            if (!receipt) throw Error('missing_application_receipt');
            expect(events.map((e) => e.msgId)).toEqual([source.msgId, receipt.msgId]);
            expect(current.workers).toEqual(after.workers);
            expect(current.localExecution?.delivery).toEqual(after.localExecution?.delivery);
            for (const path of ['agent-created.txt', 'agent-other.txt'])
              expect(readFileSync(join(input.root, path), 'utf8')).toBe(`accepted ${path}`);
            const admitted = await authority.acquire(scope, source);
            expect(admitted.replayed).toBe(true);
            await application.verify(admitted.call, receipt);
            const replay = await post();
            expect(replay.status).toBe(202);
            expect(await replay.json()).toMatchObject({ published: false });
            expect(events).toHaveLength(2);
            expect(await options.control.assertClosed(scope)).toEqual(current);
            writeFileSync(
              join(input.root, 'agent-created.txt'),
              'independent edit after application',
            );
            expect((await post()).status).toBe(202);
            expect(readFileSync(join(input.root, 'agent-created.txt'), 'utf8')).toBe(
              'independent edit after application',
            );
            expect(events).toHaveLength(2);
            await expect(application.verify(admitted.call, receipt)).rejects.toThrow();
            after = current;
          } finally {
            unsubscribe();
          }
        } else {
          await expect(authority.acquire(scope, { ...source, fromRole: 'CODER' })).rejects.toThrow(
            'workspace_control_source_invalid',
          );
          const admitted = await authority.acquire(scope, source);
          expect(admitted.replayed).toBe(false);
          const checkpoint = await authority.assertCall(admitted.call, 'edit');
          expect(checkpoint.claim.kind).toBe('delivery');
          expect(checkpoint.claim).not.toHaveProperty('workerId');
          expect(checkpoint.root.rootId).toBe(compared.source.scope.rootId);
          const current = await options.control.assertClosed(scope);
          expect(current.workers).toEqual(after.workers);
          expect(current.localExecution?.bindings).toEqual(after.localExecution?.bindings);
          expect(current.localExecution?.workspaces.at(-1)?.purpose).toBe('delivery');
          for (const patch of [
            { writerEpoch: admitted.call.writerEpoch + 1 },
            { inputHash: 'f'.repeat(64) },
            { taskId: 'other' },
          ])
            await expect(
              authority.assertCall({ ...admitted.call, ...patch }, 'edit'),
            ).rejects.toThrow();
          expect(await authority.acquire(scope, { ...source, ts: source.ts + 1 })).toEqual({
            call: admitted.call,
            replayed: true,
          });
          expect(await options.control.assertClosed(scope)).toEqual(current);
          await expect(
            proposals.verifyCurrent(scope, proposal.deliveryProposalId, proposal.inputHash),
          ).rejects.toThrow('delivery_direct_source_unavailable');
          if (input.applicationEffects) {
            const batch = await LocalDeliveryTreeBatch.open(
              options.owner,
              options.objects,
              options.versions,
              authority,
              options.filesHelper,
            );
            const plan = {
              scope: proposal.source.scope,
              baseline: proposal.source.baseline,
              artifact: proposal.source.artifact,
              current: proposal.source.current,
            };
            await expect(
              batch.apply(admitted.call, source.msgId, {
                ...plan,
                artifact: proposal.source.baseline,
              }),
            ).rejects.toThrow('delivery_application_plan_changed');
            if (input.applicationEffects === 'missing-completion') {
              const bind = options.objects.bindReference.bind(options.objects);
              options.objects.bindReference = async (key, hash) => {
                const value = (await options.objects.get(hash)) as { schemaVersion?: string };
                if (value.schemaVersion === 'delivery-tree-completion-v1')
                  throw Error('fixture_missing_delivery_completion');
                return bind(key, hash);
              };
              try {
                await expect(batch.apply(admitted.call, source.msgId, plan)).rejects.toThrow(
                  'fixture_missing_delivery_completion',
                );
              } finally {
                options.objects.bindReference = bind;
              }
              for (const path of ['agent-created.txt', 'agent-other.txt'])
                expect(readFileSync(join(input.root, path), 'utf8')).toBe(`accepted ${path}`);
              await expect(batch.readApplied(admitted.call, source.msgId, plan)).rejects.toThrow(
                'tree_batch_recovery_required',
              );
              await expect(batch.closure(checkpoint.claim)).rejects.toThrow(
                'tree_batch_recovery_required',
              );
              await expect(batch.apply(admitted.call, source.msgId, plan)).rejects.toThrow(
                'tree_batch_recovery_required',
              );
            } else {
              faultActive = true;
              const result = await batch.apply(admitted.call, source.msgId, plan);
              faultActive = false;
              expect(result.schemaVersion).toBe('delivery-tree-result-v1');
              expect(readFileSync(join(input.root, 'agent-created.txt'), 'utf8')).toBe(
                'accepted agent-created.txt',
              );
              if (
                ['success', 'receipt', 'receipt-recovery', 'finalize'].includes(
                  input.applicationEffects,
                )
              ) {
                expect(result.stage).toBe('applied');
                expect(result.attempted).toBe(2);
                expect(readFileSync(join(input.root, 'agent-other.txt'), 'utf8')).toBe(
                  'accepted agent-other.txt',
                );
                expect(await batch.readApplied(admitted.call, source.msgId, plan)).toEqual(result);
                expect(await batch.closure(checkpoint.claim)).toMatch(/^closure:/);
              } else {
                expect(result.stage).toBe('partial');
                expect(result.attempted).toBe(1);
                expect(existsSync(join(input.root, 'agent-other.txt'))).toBe(false);
                await expect(batch.readApplied(admitted.call, source.msgId, plan)).rejects.toThrow(
                  'tree_batch_recovery_required',
                );
                await expect(batch.closure(checkpoint.claim)).rejects.toThrow(
                  'tree_batch_recovery_required',
                );
              }
              expect(await batch.apply(admitted.call, source.msgId, plan)).toEqual(result);
              expect(existsSync(join(input.root, 'agent-other.txt'))).toBe(
                ['success', 'receipt', 'receipt-recovery', 'finalize'].includes(
                  input.applicationEffects,
                ),
              );
              if (['receipt', 'receipt-recovery', 'finalize'].includes(input.applicationEffects)) {
                const application = new LocalDeliveryApplication({
                  control: options.control,
                  objects: options.objects,
                  authority,
                  proposals,
                  batch,
                });
                if (input.applicationEffects === 'receipt-recovery') {
                  const commit = runtime.store.compareAndCommit.bind(runtime.store);
                  runtime.store.compareAndCommit = async (s, expected, mutations) => {
                    const result = await commit(s, expected, mutations);
                    if (
                      mutations.some(
                        (m) =>
                          m.op === 'append' &&
                          m.field === 'messages' &&
                          (m.value as Message).payload.kind === 'workspace_delivery_application',
                      )
                    )
                      throw Error('fixture_after_application_state_commit');
                    return result;
                  };
                  try {
                    await expect(application.complete(admitted.call)).rejects.toThrow(
                      'fixture_after_application_state_commit',
                    );
                  } finally {
                    runtime.store.compareAndCommit = commit;
                  }
                  await expect(options.control.assertClosed(scope)).rejects.toThrow(
                    'registry_recovery_required',
                  );
                  expect((await runtime.store.load(scope))?.messages.at(-1)?.payload.kind).toBe(
                    'workspace_delivery_application',
                  );
                }
                const message = await application.complete(admitted.call);
                const saved = await options.control.assertClosed(scope);
                expect(saved.messages.at(-1)).toEqual(message);
                expect(saved.workers).toEqual(current.workers);
                expect(saved.phase).toBe(current.phase);
                expect(saved.testResults).toEqual(current.testResults);
                expect(saved.reviewComments).toEqual(current.reviewComments);
                expect(saved.localExecution?.delivery).toEqual(current.localExecution?.delivery);
                const released = (await options.control.snapshot()).claims.find(
                  (c) => c.claimId === admitted.call.claimId,
                );
                expect(released?.status).toBe('released');
                expect(await application.complete(admitted.call)).toEqual(message);
                await expect(authority.assertCall(admitted.call, 'edit')).rejects.toThrow(
                  'delivery_application_assignment_mismatch',
                );
                const reader = authority.completionReader(
                  String(message.payload.completionActionId),
                  String(message.payload.proofHash),
                  String(message.payload.closureReceiptId),
                );
                await expect(reader.assertCall(admitted.call, 'edit')).rejects.toThrow(
                  'delivery_application_read_only',
                );
                await expect(
                  application.verify(admitted.call, {
                    ...message,
                    payload: { ...message.payload, proofHash: 'f'.repeat(64) },
                  }),
                ).rejects.toThrow();
                let finalized: typeof saved | undefined;
                let finalizer: LocalDeliveryFinalization | undefined;
                if (input.applicationEffects === 'finalize' || input.liveApplication) {
                  let injectDrift = true;
                  finalizer = new LocalDeliveryFinalization(
                    application,
                    async (expected, mutations) => {
                      if (injectDrift) {
                        injectDrift = false;
                        await runtime.commitMutations(scope, [
                          appendMutation('messages', {
                            msgId: 'late-control-note',
                            fromRole: 'COORDINATOR',
                            channelId: 'main',
                            type: 'announce',
                            display: 'Independent control fact',
                            payload: { kind: 'fixture_control_note' },
                            ts: Date.now(),
                          }),
                        ]);
                      }
                      return (await runtime.compareAndCommitControl(scope, expected, mutations))
                        .state;
                    },
                  );
                  await expect(finalizer.finalize(saved)).rejects.toThrow(
                    'delivery_completion_not_ready',
                  );
                  const reviewId = currentApprovedReviewId(saved);
                  const actionId = 'approve-applied-c',
                    gateId = `human-gate:${reviewId}`,
                    ts = Date.now();
                  const approved = buildCompletionResolution(saved, {
                    actionId,
                    reviewId,
                    option: 'approve_completion',
                    ts,
                  });
                  const state = (
                    await runtime.commitMutations(scope, [
                      appendMutation('decisionLedger', approved.decision),
                      appendMutation('messages', {
                        msgId: actionId,
                        fromRole: 'leader',
                        channelId: 'main',
                        type: 'chat',
                        ts,
                        display: `/resolve-gate ${gateId} approve_completion`,
                        payload: {
                          kind: 'leader_intent',
                          intent: {
                            kind: 'resolve_human_gate',
                            gateId,
                            option: 'approve_completion',
                          },
                          action: { status: 'applied' },
                          resolution: {
                            gateId,
                            option: 'approve_completion',
                            safePointRefs: [],
                            resumeSessionId: `human-gate-resume:${actionId}`,
                            completionEvidence: currentCompletionEvidence(saved),
                          },
                          completionResolution: approved.action,
                        },
                      }),
                      appendMutation('messages', {
                        msgId: `human-gate-resumed:${actionId}`,
                        fromRole: 'COORDINATOR',
                        channelId: 'main',
                        type: 'announce',
                        ts,
                        display: 'Synthetic boundary for native finalization only',
                        payload: {
                          kind: 'human_gate_resumed',
                          actionId,
                          gateId,
                          resumeSessionId: `human-gate-resume:${actionId}`,
                        },
                      }),
                    ])
                  ).state;
                  await expect(finalizer.finalize(state)).rejects.toThrow();
                  const drifted = await options.control.assertClosed(scope);
                  expect(drifted.phase).toBe('review');
                  expect(
                    drifted.messages.some(
                      (m) => m.payload.kind === 'workspace_delivery_completion',
                    ),
                  ).toBe(false);
                  finalized = await finalizer.finalize(drifted);
                  expect(finalized.phase).toBe('done');
                  expect(
                    latestCoordinationLedger(finalized)?.progress.isRequestSatisfied.answer,
                  ).toBe(true);
                  expect(finalized.workers).toEqual(saved.workers);
                  expect(finalized.localExecution).toEqual(saved.localExecution);
                  await finalizer.verify(finalized);
                  expect(await finalizer.finalize(finalized)).toEqual(finalized);
                }
                writeFileSync(join(input.root, 'agent-created.txt'), 'independent later edit');
                await expect(application.verify(admitted.call, message)).rejects.toThrow();
                expect(
                  (await options.control.assertClosed(scope)).messages.find(
                    (m) => m.msgId === message.msgId,
                  ),
                ).toEqual(message);
                if (finalizer && finalized)
                  await expect(finalizer.verify(finalized)).rejects.toThrow();
              }
            }
          }
          after = await options.control.assertClosed(scope);
        }
      } else {
        writeFileSync(
          join(input.root, 'second-user-note.txt'),
          'preserve the next independent edit',
        );
        const nextComparisons = createLocalDirectDeliveryComparisons(options, local);
        await expect(
          nextComparisons.verifyCurrent(nextComparison.deliveryComparisonId),
        ).rejects.toThrow('delivery_stale');
        await expect(
          proposals.verifyCurrent(scope, proposal.deliveryProposalId, proposal.inputHash),
        ).rejects.toThrow('delivery_stale');
        const changed = await nextComparisons.prepare(scope);
        expect(changed.source.baseline).toEqual(compared.source.baseline);
        expect(changed.source.artifact).toEqual(candidate.version);
        expect(changed.comparison.status).toBe('requires_validation');
        await expect(proposals.prepare(scope, changed.deliveryComparisonId)).rejects.toThrow(
          'delivery_application_requires_reviewed_candidate',
        );
      }
      expect(await options.control.assertClosed(scope)).toEqual(after);
    }
    mark('reviewer-reader-verified');
  }
  expect(
    after.workers.filter(
      (worker) => worker.workerId !== workerId && worker.workerId !== reviewerId,
    ),
  ).toEqual(before.workers);
  expect(after.iterationCount).toBe(before.iterationCount);
  expect(readFileSync(join(input.root, 'sentinel'), 'utf8')).toBe(original);
  expect(scheduler.activeCount).toBe(0);
  await controller.commit(scope, { ...message, ts: Date.now() });
  expect(await options.control.assertClosed(scope)).toEqual(after);
  if (input.repairOrchestration)
    return (
      await import('./local-delivery-repair-orchestration-fixture')
    ).exerciseDeliveryRepairOrchestration(input, candidates);
  const repairWriter = !input.expectedPass
    ? await (await import('./local-delivery-repair-writer-fixture')).exerciseDeliveryRepairWriter(
        input,
        candidates,
        local,
      )
    : undefined;
  return {
    repairWriter,
    roundId: selected.round.roundId,
    workerId,
    commandReceiptId,
    validationReceiptId,
    reviewerId,
    candidateVersion: candidate.version,
    sourceArtifact: compared.source.artifact,
    userEditPreserved: true,
    oldWorkersPreserved: true,
    leaseReleased: true,
    testsPassed: input.expectedPass,
  };
}
