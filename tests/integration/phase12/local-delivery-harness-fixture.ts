// Real model, official Harness, Coordinator, WorkerRuntime and native candidate
// sessions. The earlier completed source task is an owned acceptance fixture.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  type AppState,
  deliveryReaderAssignment,
  deliveryValidationDispatch,
  latestCoordinationLedger,
} from '@agora/core-domain';
import { type GlobalScheduler, ParallelBatchError } from '@agora/core-orchestration';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { expect } from 'vitest';
import { LocalDeliveryApplication } from '../../../apps/web/src/server/local-delivery-application';
import { LocalDeliveryApplicationProposals } from '../../../apps/web/src/server/local-delivery-application-proposals';
import { LocalDeliveryApplyControl } from '../../../apps/web/src/server/local-delivery-apply-control';
import { LocalDeliveryFinalization } from '../../../apps/web/src/server/local-delivery-finalization';
import { createLocalDeliveryRepairServices } from '../../../apps/web/src/server/local-delivery-repair-services';
import { LocalDeliveryRevalidationControl } from '../../../apps/web/src/server/local-delivery-revalidation-control';
import { createLocalDirectDeliveryComparisons } from '../../../apps/web/src/server/local-direct-delivery-composition';
import { createLocalTaskCompositionFactory } from '../../../apps/web/src/server/local-task-composition';
import { LocalValidationService } from '../../../apps/web/src/server/local-validation';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import type {
  MessageRuntime,
  WorkspaceControlPort,
} from '../../../apps/web/src/server/message-runtime';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';
import { LocalDeliveryAuthority } from '../../../packages/runtime/sandbox/src/local-delivery-authority';
import type { LocalDeliveryCandidates } from '../../../packages/runtime/sandbox/src/local-delivery-candidates';
import type { LocalDeliveryComparisonStore } from '../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import { LocalDeliveryRepairs } from '../../../packages/runtime/sandbox/src/local-delivery-repairs';
import { LocalDeliveryTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { resolveLiveTestModel } from '../../helpers/live-model';

export async function exerciseDeliveryHarness(input: {
  options: Parameters<typeof LocalWorkspaceSessions.create>[0];
  candidates: LocalDeliveryCandidates;
  runtime: MessageRuntime;
  scheduler: GlobalScheduler;
  root: string;
  started: AppState;
  applyOrder?: 'before_approval' | 'after_approval' | undefined;
  registration?: WorkspaceControlPort;
  register?: (tasks: TaskOrchestrationRuntime) => Promise<AppState>;
  applicationSources?: (local: LocalWorkspaceSessions) => LocalDeliveryComparisonStore;
  verifyTargetMetadata?: ConstructorParameters<
    typeof LocalDeliveryAuthority
  >[0]['verifyTargetMetadata'];
  repair?: boolean;
  rejectCompletion?: boolean;
  reviewRepair?: boolean;
  expectedTests?: number;
  expectedFiles?: Record<string, string>;
}) {
  const { options, runtime, scheduler, candidates } = input;
  let started = input.started;
  const repairReasons: string[] = [];
  const scope = { projectId: started.projectId, taskId: started.taskId };
  const live = await resolveLiveTestModel();
  let local: LocalWorkspaceSessions | undefined;
  let repairServices: ReturnType<typeof createLocalDeliveryRepairServices> | undefined;
  const load = async () => {
    const state = await runtime.store.load(scope);
    if (!state) throw Error('missing_delivery_state');
    return state;
  };
  async function applicationServices() {
    if (!local) throw Error('missing_local_composition');
    const comparisons =
      input.applicationSources?.(local) ?? createLocalDirectDeliveryComparisons(options, local);
    const proposals = new LocalDeliveryApplicationProposals(options.objects, comparisons, (s) =>
      runtime.store.load(s),
    );
    const sessions = local;
    const authority = new LocalDeliveryAuthority({
      control: options.control,
      verifyCurrent: (scope, id, hash) => proposals.verifyCurrent(scope, id, hash),
      verifyBinding: (scope, id, hash) => proposals.verifyBinding(scope, id, hash),
      verifyGrant: options.verifyGrant,
      ...(input.verifyTargetMetadata ? { verifyTargetMetadata: input.verifyTargetMetadata } : {}),
      verifyClosedClaim: (scope, claim) => sessions.verifyClosedClaim(scope, claim),
      assertControl: async (state) => {
        if (
          scheduler.activeCount !== 0 ||
          state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
        )
          throw Error('delivery_application_busy');
      },
    });
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
      proposals,
      authority,
      batch,
    });
    const finalizer = new LocalDeliveryFinalization(
      application,
      async (expected, mutations) =>
        (await runtime.compareAndCommitControl(scope, expected, mutations)).state,
    );
    return { comparisons, proposals, authority, batch, application, finalizer };
  }
  const factory = createLocalTaskCompositionFactory({
    loadState: (s) => runtime.store.load(s),
    bindCompletionVerifier: (verify) => runtime.bindLocalCompletionVerifier(verify),
    scheduler,
    ...(input.repair
      ? {
          deliveryRepair: {
            prepare: (state, source) =>
              runtime.runTaskSerial(scope, async () => {
                if (!repairServices) throw Error('missing_repair_services');
                repairReasons.push(source.reason);
                return repairServices.prepare(state, source);
              }),
            complete: (state, workerId) =>
              runtime.runTaskSerial(scope, async () => {
                if (!repairServices) throw Error('missing_repair_services');
                return repairServices.complete(state, workerId);
              }),
          },
        }
      : {}),
    ...(input.applyOrder
      ? {
          deliveryFinalization: {
            finalize: (state: AppState) =>
              runtime.runTaskSerial(scope, async () =>
                (await applicationServices()).finalizer.finalize(state),
              ),
            verify: (state: AppState) =>
              runtime.runTaskSerial(scope, async () =>
                (await applicationServices()).finalizer.verify(state),
              ),
          },
        }
      : {}),
    model: live.model,
    executorOptions: { ...live.options, maxToolCallsPerTurn: 20 },
    prepare: async (_scope, versionForAssignment) => {
      const repairs = input.repair
        ? await LocalDeliveryRepairs.open(options.owner, options.objects, options.versions)
        : undefined;
      local = await LocalWorkspaceSessions.create({
        ...options,
        deliveryCandidates: candidates,
        versionForAssignment,
        ...(repairs
          ? {
              deliveryRepairs: repairs,
              verifyRepairSource: (state: AppState, workerId: string) => {
                if (!repairServices) throw Error('missing_repair_services');
                return repairServices.verifySource(state, workerId);
              },
            }
          : {}),
      });
      if (repairs)
        repairServices = createLocalDeliveryRepairServices({
          control: options.control,
          repairs,
          local,
          loadState: (s) => runtime.store.load(s),
          verifyGrant: options.verifyGrant,
          assertReady: async (state) => {
            if (
              scheduler.activeCount ||
              state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
            )
              throw Error('fixture_run_not_closed');
          },
          compareAndCommit: async (state, mutations) =>
            (await runtime.compareAndCommitControl(scope, state, mutations)).state,
        });
      return {
        local,
        cwd: input.root,
        sessionRoot: join(
          options.owner.root,
          'projects',
          scope.projectId,
          'tasks',
          scope.taskId,
          'harness-sessions',
        ),
      };
    },
  });
  const workerFailures: { name: string; message: string; stack?: string }[] = [];
  const capture = (failure: unknown): void => {
    if (failure instanceof Error) {
      workerFailures.push({
        name: failure.name,
        message: failure.message,
        ...(failure.stack ? { stack: failure.stack } : {}),
      });
      if (failure instanceof AggregateError) failure.errors.forEach(capture);
      if (failure instanceof ParallelBatchError)
        failure.failures.forEach((worker) => {
          capture(worker.cause);
        });
      if (failure.cause) capture(failure.cause);
    }
  };
  const tasks = new TaskOrchestrationRuntime(runtime, async (request) => {
    const composition = await factory(request);
    const runOne = composition.workerRuntime.runOne.bind(composition.workerRuntime);
    composition.workerRuntime.runOne = async (...args) => {
      try {
        return await runOne(...args);
      } catch (error) {
        capture(error);
        throw error;
      }
    };
    const runParallel = composition.workerRuntime.runParallel.bind(composition.workerRuntime);
    composition.workerRuntime.runParallel = async (...args) => {
      try {
        return await runParallel(...args);
      } catch (error) {
        capture(error);
        throw error;
      }
    };
    return composition;
  });
  const originalArtifacts = await options.objects.references();
  if (input.register) started = await input.register(tasks);
  else await tasks.startDeliveryRound(started);
  const selected = deliveryValidationDispatch(started);
  if (!selected) throw Error('missing_delivery_dispatch');
  try {
    await tasks.waitForIdle(scope);
    const summary = await tasks.summary(scope);
    expect(summary, JSON.stringify(summary)).toMatchObject({
      runStatus: 'needs_attention',
      phase: 'review',
    });
    if (input.rejectCompletion) {
      const rejected = await load();
      const oldGate = rejected.humanGate;
      expect(oldGate?.reason).toMatch(/^completion_confirmation:/);
      const response = await createPostMessage(runtime)(
        new Request('http://localhost/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...scope,
            channelId: 'main',
            msgId: 'request-delivery-repair',
            display: `/resolve-gate ${oldGate?.gateId} request_changes Recheck the exact required file bytes and preserve the original tests and independent user edits before proposing completion.`,
          }),
        }),
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(202);
      expect(
        (await load()).messages.find((message) => message.msgId === 'request-delivery-repair')
          ?.payload.action,
        JSON.stringify(body),
      ).toMatchObject({ status: 'applied' });
      await tasks.waitForIdle(scope);
      const repaired = await load();
      expect(await tasks.summary(scope)).toMatchObject({
        runStatus: 'needs_attention',
        phase: 'review',
      });
      expect(repaired.humanGate?.gateId).not.toBe(oldGate?.gateId);
      expect(
        repaired.workers.filter((w) => rejected.workers.some((old) => old.workerId === w.workerId)),
      ).toEqual(rejected.workers);
      for (const review of rejected.reviewComments)
        expect(repaired.reviewComments).toContainEqual(review);
    }
    if (!local) throw Error('missing_local_composition');
    const validator = new LocalValidationService(local, load);
    const validated = deliveryValidationDispatch(await load());
    if (!validated) throw Error('missing_delivery_dispatch');
    if (input.repair) expect(validated.repairCandidate).toBeDefined();
    const receipt = await validator.verify(
      await load(),
      `workspace-validation:${validated.message.msgId}`,
    );
    expect(receipt.roundId).toBe(selected.round.roundId);
    expect(receipt.results).toMatchObject({
      passed: true,
      total: input.expectedTests ?? 2,
      failed: 0,
    });
    const current = await load();
    const gate = current.humanGate;
    expect(gate?.reason).toMatch(/^completion_confirmation:/);
    const reviewer = current.workers
      .filter(
        (w) => w.role === 'REVIEWER' && !started.workers.some((old) => old.workerId === w.workerId),
      )
      .at(-1);
    if (!reviewer) throw Error('missing_new_reviewer');
    expect(deliveryReaderAssignment(current, reviewer.workerId)?.role).toBe('REVIEWER');
    expect(scheduler.activeCount).toBe(0);
    const applyCandidate = async () => {
      const services = await applicationServices();
      const compared = await services.comparisons.prepare(scope);
      const proposal = await services.proposals.prepare(scope, compared.deliveryComparisonId);
      const fallback = input.registration
        ? new LocalDeliveryRevalidationControl(
            input.registration,
            (s) => runtime.store.load(s),
            (state) => tasks.startDeliveryRound(state),
            {
              commit: async () => {
                throw Error('fixture_control_not_selected');
              },
            },
          )
        : {
            commit: async () => {
              throw Error('fixture_control_not_selected');
            },
          };
      runtime.bindWorkspaceControlPort(
        new LocalDeliveryApplyControl({
          control: options.control,
          ...services,
          fallback,
          startFinalization: (state) => tasks.startDeliveryFinalization(state),
        }),
      );
      const action = {
        ...scope,
        actionId: 'apply-live-delivery',
        expectedRevision: (await options.control.snapshot()).revision,
        deliveryProposalId: proposal.deliveryProposalId,
        inputHash: proposal.inputHash,
      };
      const post = () =>
        createPostMessage(runtime)(
          new Request('http://localhost/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...scope,
              channelId: 'main',
              msgId: action.actionId,
              display: `/workspace apply ${JSON.stringify(action)}`,
            }),
          }),
        );
      const response = await post();
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(202);
      const state = await load();
      expect(state.messages.some((m) => m.payload.kind === 'workspace_delivery_application')).toBe(
        true,
      );
      expect(readFileSync(join(input.root, 'delivery-user-note.txt'), 'utf8')).toBe(
        'preserve this independent edit',
      );
      const replay = await post();
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ published: false });
    };
    if (input.applyOrder === 'before_approval') {
      await applyCandidate();
      expect((await load()).phase).toBe('review');
      expect(latestCoordinationLedger(await load())?.progress.isRequestSatisfied.answer).toBe(
        false,
      );
    }
    const approval = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: 'approve-delivery-round',
          display: `/resolve-gate ${gate?.gateId} approve_completion`,
        }),
      }),
    );
    const approvalBody = await approval.json();
    expect(approval.status, JSON.stringify(approvalBody)).toBe(202);
    await tasks.waitForIdle(scope);
    if (input.applyOrder === 'after_approval') {
      expect(await tasks.summary(scope)).toMatchObject({
        phase: 'review',
        runStatus: 'needs_attention',
        deliveryStatus: 'approved_awaiting_application',
      });
      expect(latestCoordinationLedger(await load())?.progress.isRequestSatisfied.answer).toBe(
        false,
      );
      await applyCandidate();
      await tasks.waitForIdle(scope);
    }
    const finished = await tasks.summary(scope);
    expect(finished, JSON.stringify(finished)).toMatchObject({
      runStatus: 'completed',
      phase: 'done',
    });
    if (!finished?.artifactPath) throw Error('missing_delivery_artifact');
    for (const [path, contents] of Object.entries(
      input.expectedFiles ?? {
        'delivery-user-note.txt': 'preserve this independent edit',
        sentinel: 'fixed user content',
      },
    ))
      expect(readFileSync(join(finished.artifactPath, path), 'utf8')).toBe(contents);
    if (input.applyOrder && input.reviewRepair)
      expect(readFileSync(join(input.root, 'review-note.txt'), 'utf8')).toBe('reviewed delivery');
    const currentArtifacts = await options.objects.references();
    for (const previous of originalArtifacts) expect(currentArtifacts).toContainEqual(previous);
    await tasks.startDeliveryRound(started);
    expect(await tasks.summary(scope)).toEqual(finished);
    const trace = await new HarnessTraceReader(options.owner.root).read(scope);
    const sessions = trace.sessions.filter((s) => ['CODER', 'TESTER', 'REVIEWER'].includes(s.role));
    const sessionCount = input.rejectCompletion || input.reviewRepair ? 5 : input.repair ? 4 : 2;
    expect(sessions).toHaveLength(sessionCount);
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(sessionCount);
    if (input.repair)
      expect(sessions.map((s) => s.role).sort()).toEqual(
        input.rejectCompletion || input.reviewRepair
          ? ['CODER', 'REVIEWER', 'REVIEWER', 'TESTER', 'TESTER']
          : ['CODER', 'REVIEWER', 'TESTER', 'TESTER'],
      );
    expect(sessions.every((s) => s.parentSessionId === undefined)).toBe(true);
    expect(
      current.workers.filter((w) => started.workers.some((old) => old.workerId === w.workerId)),
    ).toEqual(started.workers);
    expect(current.workers.length).toBe(started.workers.length + sessionCount);
    expect(current.iterationCount).toBe(started.iterationCount + (input.repair ? 1 : 0));
    expect(repairReasons).toEqual(
      input.repair
        ? [
            input.rejectCompletion
              ? 'leader_completion_changes_requested'
              : input.reviewRepair
                ? 'review_changes_requested'
                : 'tests_failed',
          ]
        : [],
    );
    return {
      repairReasons,
      provider: 'opencode-go',
      model: live.model,
      testerWorkerId: validated.workerId,
      reviewerWorkerId: reviewer.workerId,
      roundId: selected.round.roundId,
      validationReceiptId: `workspace-validation:${validated.message.msgId}`,
      commandReceiptId: receipt.commandReceiptId,
      candidateVersion: receipt.workspaceVersion,
      trace,
      completionCandidate: true,
      leaderApproval: true,
      archived: true,
      ...(input.applyOrder
        ? { applicationOrder: input.applyOrder, applied: true, completionAtomic: true }
        : {}),
      artifactPath: finished.artifactPath,
    };
  } catch (error) {
    // Preserve canonical fixture facts and the safe Trace projection before
    // ownership-checked cleanup removes the test-only workspace.
    const state = await load();
    const trace = await new HarnessTraceReader(options.owner.root)
      .read(scope)
      .catch((failure: unknown) => ({ error: String(failure) }));
    const folder = resolve('test-outputs/task124/delivery-harness-failures');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, `${basename(dirname(options.owner.root))}.json`),
      JSON.stringify(
        {
          schemaVersion: 'delivery-harness-failure-v1',
          base: dirname(options.owner.root),
          provider: 'opencode-go',
          model: live.model,
          failure: error instanceof Error ? error.message : String(error),
          workerFailures,
          summary: await tasks.summary(scope),
          phase: state.phase,
          humanGate: state.humanGate,
          workers: state.workers,
          reviewComments: state.reviewComments,
          testResults: state.testResults,
          ledger: latestCoordinationLedger(state),
          trace,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await tasks.drain();
    await tasks.disposeAll();
  }
}
