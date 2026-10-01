// Real native files, Git, claims and reducer control; the fixed Leader input and worker lifecycle are fixture-owned.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AppState,
  appendMutation,
  type HumanGateRequest,
  mergeByIdMutation,
  readCodingWorkerLineage,
  setMutation,
} from '@agora/core-domain';
import {
  GlobalScheduler,
  IntegrationService,
  materializeHumanGate,
  planHumanGateResolution,
  planIntegrationWave,
} from '@agora/core-orchestration';
import { expect } from 'vitest';
import { LocalCodingPreparation } from '../../../apps/web/src/server/local-coding-preparation';
import { LocalConflictCodingSource } from '../../../packages/runtime/sandbox/src/local-conflict-coding-source';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { LocalIntegrationCandidates } from '../../../packages/runtime/sandbox/src/local-integration-candidates';
import { LocalIntegrationCompletion } from '../../../packages/runtime/sandbox/src/local-integration-completion';
import { LocalIntegrationPreparation } from '../../../packages/runtime/sandbox/src/local-integration-preparation';
import { LocalIntegrationProgress } from '../../../packages/runtime/sandbox/src/local-integration-progress';
import { LocalIntegrationPublication } from '../../../packages/runtime/sandbox/src/local-integration-publication';
import { LocalIntegrationSources } from '../../../packages/runtime/sandbox/src/local-integration-sources';
import type { LocalIntegrationTreeBatch } from '../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { LocalMergeCandidates } from '../../../packages/runtime/sandbox/src/local-merge-candidates';
import { serializeWorkspaceOperation } from '../../../packages/runtime/sandbox/src/local-workspace-operation';
import { type fixture, hash } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import type { completedIntegration } from './local-completed-integration-fixture';
import type { registrationContext } from './local-linked-workspace-fixture';

export async function exerciseConflictRework(input: {
  ctx: Awaited<ReturnType<typeof registrationContext>>;
  setup: Awaited<ReturnType<typeof completedIntegration>>;
  candidates: LocalIntegrationCandidates;
  batches: LocalIntegrationTreeBatch;
  result: { state: AppState; gateRequest?: HumanGateRequest };
  f: Parameters<Parameters<typeof fixture>[0]>[0];
}) {
  const { ctx, setup, candidates, batches, result, f } = input;
  const started = performance.now();
  const mark = (stage: string) =>
    writeFileSync(
      join(f.privateRoot, 'conflict-rework-stage.json'),
      JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started) }),
    );
  mark('gate');
  if (!result.gateRequest || !result.state.integration) throw Error('missing real conflict');
  const original = result.state.integration;
  const gate = materializeHumanGate(result.gateRequest, []);
  await ctx.store.commit(ctx.scope, [setMutation('humanGate', gate)]);
  const gated = await ctx.control.assertClosed(ctx.scope);
  expect(gated.humanGate).toEqual(gate);
  const failedWorker = original.conflicts[0]?.workerId;
  if (!failedWorker) throw Error('missing contributor');
  const actionId = 'fix-native-conflict';
  const resolution = planHumanGateResolution(gated, {
    actionId,
    gateId: gate.gateId,
    option: 'request_rework',
    argument: failedWorker,
    enabledRoles: ['COORDINATOR', 'CODER', 'TESTER', 'REVIEWER'],
    ts: 101,
  });
  await ctx.store.commit(ctx.scope, [
    appendMutation('messages', {
      msgId: actionId,
      fromRole: 'leader',
      type: 'chat',
      channelId: 'main',
      ts: 101,
      display: `/resolve-gate ${gate.gateId} request_rework ${failedWorker}`,
      payload: {
        kind: 'leader_intent',
        intent: {
          kind: 'resolve_human_gate',
          gateId: gate.gateId,
          option: 'request_rework',
          argument: failedWorker,
        },
        action: { status: 'applied' },
        resolution: resolution.receipt,
      },
    }),
    ...resolution.mutations,
  ]);
  const resolved = await ctx.control.assertClosed(ctx.scope),
    lineage = readCodingWorkerLineage(resolved);
  expect(lineage.base).toEqual(original.base);
  expect(lineage.attempt).toBe(2);
  expect(resolved.workers.filter((w) => w.status === 'pending')).toHaveLength(1);
  const workerId = `worker:integration-rework:${actionId}:0`;
  let source: LocalConflictCodingSource;
  const workspaces = new LocalGitWorkspaces({
    ...ctx,
    readConflictBase: (state) => source.read(state),
  });
  source = new LocalConflictCodingSource({ ...ctx, ...setup, candidates, workspaces });
  const coding = new LocalCodingPreparation({
    ...ctx,
    workspaces,
    readConflictBase: (state) => source.read(state),
    verifyReceipt: async () => {
      throw Error('unexpected validation base');
    },
    runTaskSerial: (scope, operation) =>
      serializeWorkspaceOperation({ ...scope, workspaceId: 'conflict-coding-control' }, operation),
  });
  mark('register-replacement');
  const registered = await coding.prepare(resolved);
  mark('replacement-registered');
  expect(registered.localExecution?.bindings.filter((b) => b.workerId === workerId)).toHaveLength(
    1,
  );
  expect(registered.workers.filter((w) => w.workerId !== workerId)).toEqual(
    original.pendingBranches.map((b) => resolved.workers.find((w) => w.workerId === b.workerId)),
  );
  const worker = registered.workers.find((w) => w.workerId === workerId);
  if (!worker?.subtaskId) throw Error('missing replacement');
  const scheduler = new GlobalScheduler(),
    lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, workerId);
  try {
    const worktree = await workspaces.resolveAssignment({ ...ctx.scope, workerId });
    expect(worktree.baseCommit).toBe(original.base.commit);
    const sessionId = 'native-conflict-rework-session';
    await ctx.store.commit(ctx.scope, [
      mergeByIdMutation('workers', workerId, { status: 'running', sessionId, worktree }),
    ]);
    const session = await setup.sessions.open({
      ...ctx.scope,
      workerId,
      role: 'CODER',
      subtaskId: worker.subtaskId,
      sessionId,
      assertLease: () => scheduler.assertActive(lease),
    });
    for (const [i, path] of ['shared-result.txt', 'rework-proof.txt'].entries()) {
      const read = await session.tools.read(`tool:${hash(`conflict-read-${i}`)}`, path);
      expect(read.version.kind).toBe('absent');
      await session.tools.apply(
        `tool:${hash(`conflict-write-${i}`)}`,
        [
          {
            path,
            expected: read.version,
            readReceiptId: read.readReceiptId,
            content: i === 0 ? 'worker 0\n' : 'replacement from original base\n',
            encoding: 'utf8',
          },
        ],
        [],
      );
    }
    await session.checkpoint('complete');
    if (!session.completeWorktree) throw Error('missing native completion');
    const completed = await session.completeWorktree();
    await ctx.store.commit(ctx.scope, [
      mergeByIdMutation('workers', workerId, { worktree: completed }),
      mergeByIdMutation('subtasks', worker.subtaskId, { worktree: completed }),
    ]);
    await session.close();
    await ctx.store.commit(ctx.scope, [mergeByIdMutation('workers', workerId, { status: 'done' })]);
  } finally {
    await scheduler.release(lease);
  }
  mark('replacement-completed');
  const completed = await ctx.control.assertClosed(ctx.scope),
    baseline = await source.read(completed);
  const plan = planIntegrationWave(completed, {
    waveId: lineage.waveId,
    workerIds: lineage.assignments.map((a) => a.workerId),
    baseBranch: lineage.base.branch,
  });
  expect(plan.integrationId).not.toBe(original.integrationId);
  mark('prepare-reintegration');
  const registration: Parameters<LocalGitWorkspaces['registerIntegrationWave']>[0] = {
    ...ctx.scope,
    actionId: 'register-rework-integration',
    rootId: ctx.root.rootId,
    grantId: ctx.grant.grantId,
    expectedRevision: (await ctx.control.snapshot()).revision,
    version: baseline.version,
    sourceWorkspaceId: baseline.sourceWorkspaceId,
    waveId: lineage.waveId,
    attempt: lineage.attempt,
    targets: [{ workspaceId: 'rework-integration', purpose: 'integration' }],
  };
  const targets = await workspaces.registerIntegrationWave(registration);
  expect(targets).toHaveLength(1);
  expect(targets[0]?.mode === 'linked-worktree' && targets[0].baseCommit).toBe(
    original.base.commit,
  );
  const physical = (await ctx.control.snapshot()).linkedRoots?.find(
    (r) => r.workspaceId === 'rework-integration',
  );
  if (!physical) throw Error('missing registered integration');
  expect(existsSync(join(physical.path, 'shared-result.txt'))).toBe(false);
  expect(existsSync(join(physical.path, 'rework-proof.txt'))).toBe(false);
  const ready = await ctx.control.assertClosed(ctx.scope);
  const prepared = await new LocalIntegrationPreparation({
    ...ctx,
    state: ctx.store,
    workspaces,
    authority: setup.authority,
    assertControl: async () => {
      await ctx.control.assertClosed(ctx.scope);
    },
    request: {
      ...ctx.scope,
      actionId: 'prepare-conflict-rework',
      workspaceId: 'rework-integration',
      registration,
    },
  }).prepare(ready, plan);
  mark('reintegrate');
  // Reuse the same canonical readers with the new wave's already registered claim.
  const nextSources = new LocalIntegrationSources({
    authority: setup.authority,
    sessions: setup.sessions,
    workspaces,
  });
  const nextCandidates = new LocalIntegrationCandidates({
    ...ctx,
    ...setup,
    sources: nextSources,
    historyBatches: batches,
    candidates: await LocalMergeCandidates.open(
      ctx.owner,
      ctx.objects,
      ctx.versions,
      resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
    ),
  });
  const publication = new LocalIntegrationPublication({
    ...ctx,
    ...setup,
    candidates: nextCandidates,
    batches,
    state: ctx.store,
  });
  const completion = new LocalIntegrationCompletion({
    ...ctx,
    ...setup,
    candidates: nextCandidates,
    state: ctx.store,
  });
  const final = await IntegrationService.withProgress(
    new LocalIntegrationProgress({
      ...ctx,
      ...setup,
      call: prepared.call,
      publication,
      completion,
    }),
  ).integrateWave(prepared.state, {
    waveId: lineage.waveId,
    workerIds: lineage.assignments.map((a) => a.workerId),
    baseBranch: lineage.base.branch,
  });
  mark('reintegrated');
  expect(final.gateRequest).toBeUndefined();
  expect(final.state.integration?.status).toBe('done');
  expect(final.state.integration?.base).toEqual(original.base);
  const target = final.state.integration?.integrationWorktree;
  if (!target) throw Error('missing result');
  expect(target.path).not.toBe(original.integrationWorktree.path);
  expect(readFileSync(join(target.path, 'shared-result.txt'), 'utf8')).toBe('worker 0\n');
  expect(readFileSync(join(target.path, 'rework-proof.txt'), 'utf8')).toBe(
    'replacement from original base\n',
  );
  expect(readFileSync(join(original.integrationWorktree.path, 'shared-result.txt'), 'utf8')).toBe(
    'worker 0\n',
  );
  expect(final.state.workers.find((w) => w.workerId === failedWorker)).toEqual(
    resolved.workers.find((w) => w.workerId === failedWorker),
  );
  writeFileSync(
    join(f.privateRoot, 'native-conflict-rework-proof.json'),
    JSON.stringify({
      original,
      gate,
      resolution,
      baseline,
      final: final.state,
      retainedWorkerId: failedWorker,
      newTarget: target.path,
    }),
  );
}
