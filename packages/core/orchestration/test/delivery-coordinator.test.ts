import {
  type AppState,
  appendMutation,
  applyMutations,
  assertCurrentDeliveryApplication,
  buildCompletionResolution,
  createInitialAppState,
  currentCompletionEvidence,
  deliveryReaderAssignment,
  deliveryRepairAssignment,
  deliveryValidationDispatch,
  deriveCompletionFeedback,
  type LocalDeliveryApplicationReceipt,
  type LocalValidationReceipt,
  localDeliveryAwaitsApplication,
  localValidationReceipt,
  parseWorkspaceControl,
} from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { projectForAssignment } from '@agora/runtime-executor';
import { expect, it } from 'vitest';
import type { LocalDeliveryRepairTransition } from '../../../runtime/sandbox/src/local-delivery-repair-transition';
import { deliveryStartMutations } from '../../../runtime/sandbox/src/local-delivery-transition';
import { localRecordHash } from '../../../runtime/sandbox/src/local-registry-records';
import { decide } from '../src/coordinator';
import { planDeliveryFinalization } from '../src/delivery-finalization';
import { deliveryRepairSource } from '../src/delivery-repair-source';
import { runOrchestration } from '../src/orchestrator';
import { buildCoordinationLedger, latestCoordinationLedger } from '../src/progress-ledger';
import { WorkerRuntime } from '../src/worker-runtime';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('missing fixture value');
  return value;
}
function fixture() {
  const state = createInitialAppState('t', 'fixed', 'p');
  const version = {
    kind: 'files' as const,
    manifestId: 'manifest:c',
    manifestHash: 'a'.repeat(64),
  };
  const display = `/workspace revalidate ${JSON.stringify({ projectId: 'p', taskId: 't', actionId: 'action', expectedRevision: 1, deliveryComparisonId: 'comparison:c', inputHash: 'b'.repeat(64) })}`;
  state.phase = 'testing';
  state.nextRole = 'TESTER';
  state.iterationCount = 3;
  state.messages = [
    {
      msgId: 'action',
      fromRole: 'leader',
      channelId: 'main',
      type: 'chat',
      ts: 0,
      display,
      payload: {
        kind: 'leader_intent',
        intent: parseWorkspaceControl(display),
        action: { status: 'applied' },
      },
    },
    {
      msgId: 'test',
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: 1,
      display: 'Test C',
      payload: {
        kind: 'delivery_validation_dispatch',
        nextRole: 'TESTER',
        roundId: 'round',
        workerIds: ['worker:test:0'],
        workspaceVersion: version,
      },
    },
  ];
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    workspaces: [],
    bindings: [],
    receipts: [
      {
        actionId: 'action',
        receiptId: 'binding:action',
        inputHash: 'd'.repeat(64),
        registryRevision: 2,
      },
    ],
    delivery: {
      schemaVersion: 'local-delivery-v1',
      goal: 'artifact_only',
      rootId: 'root',
      currentRoundId: 'round',
      rounds: [
        {
          roundId: 'round',
          actionId: 'action',
          deliveryComparisonId: 'comparison:c',
          inputHash: 'b'.repeat(64),
          grantId: 'grant',
          grantRevision: 0,
          sourceReceiptId: 'old-receipt',
          sourceVersion: version,
          candidateVersion: version,
          targetVersion: version,
          targetIndexHash: null,
          controlFingerprint: 'c'.repeat(64),
        },
      ],
    },
  };
  state.workers = [
    { workerId: 'old', role: 'CODER', status: 'done', executor: 'harness', startedTs: 0 },
  ];
  return { state, version };
}
it('dispatches only the fresh persisted delivery TESTER without resetting historical work', () => {
  const { state } = fixture();
  state.parallelExecution = {
    version: 1,
    planId: 'historical-plan',
    initialBase: { branch: 'base', commit: 'f'.repeat(40) },
  };
  const local = state.localExecution;
  if (!local) throw Error('missing fixture');
  local.workspaces.push({
    schemaVersion: 'workspace-v1',
    projectId: 'p',
    taskId: 't',
    workspaceId: 'initial',
    rootId: 'root',
    grantId: 'grant',
    purpose: 'integration',
    mode: 'linked-worktree',
    commonDirId: 'common',
    branch: 'base',
    baseCommit: 'f'.repeat(40),
  });
  local.git = {
    version: 1,
    initialWorkspaceId: 'initial',
    worktrees: [{ workspaceId: 'initial', path: '/owned/initial', receiptId: 'binding:action' }],
  };
  const snapshot = structuredClone(state);
  expect(decide(state).route).toEqual({
    kind: 'worker',
    parallel: false,
    batch: [{ role: 'TESTER', workerId: 'worker:test:0' }],
  });
  expect(state).toEqual(snapshot);
  state.workers.push({
    workerId: 'worker:test:0',
    role: 'TESTER',
    status: 'done',
    executor: 'harness',
    startedTs: 2,
  });
  expect(() => decide(state)).toThrow();
});
function reviewedCandidate() {
  const { state, version } = fixture();
  const local = state.localExecution;
  if (!local) throw Error('missing fixture');
  local.workspaces.push({
    schemaVersion: 'workspace-v1',
    workspaceId: 'validation',
    projectId: 'p',
    taskId: 't',
    rootId: 'root',
    grantId: 'grant',
    purpose: 'validation',
    mode: 'direct',
    baselineManifestId: version.manifestId,
  });
  local.bindings.push({
    workerId: 'worker:test:0',
    workspaceId: 'validation',
    receiptId: 'binding:action',
  });
  state.workers.push({
    workerId: 'worker:test:0',
    role: 'TESTER',
    status: 'done',
    executor: 'harness',
    startedTs: 2,
  });
  const receipt: LocalValidationReceipt = {
    kind: 'workspace_validation',
    version: 1,
    roundId: 'round',
    projectId: 'p',
    taskId: 't',
    dispatchId: 'test',
    workerId: 'worker:test:0',
    sourceWorkspaceId: 'validation',
    validationWorkspaceId: 'validation',
    workspaceVersion: version,
    controlFingerprint: 'c'.repeat(64),
    toolchainHash: 'd'.repeat(64),
    policyHash: 'e'.repeat(64),
    dependenciesHash: 'f'.repeat(64),
    commandReceiptId: 'command:1',
    commandInputHash: '1'.repeat(64),
    testPaths: ['candidate.test.cjs'],
    results: { passed: true, total: 1, failed: 0, failures: [], workspaceVersion: version },
    execution: { exitCode: 0, timedOut: false, quiescent: true },
  };
  state.messages.push({
    msgId: 'workspace-validation:test',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    ts: 3,
    display: 'Passed',
    payload: { ...receipt },
  });
  state.testResults = receipt.results;
  let id = 0;
  const decision = decide(state, { newId: () => `new-${++id}`, now: () => 4 });
  const next = applyMutations(state, decision.mutations);
  expect(decision.route.kind).toBe('worker');
  if (decision.route.kind !== 'worker') throw Error('missing review');
  const assignment = decision.route.batch[0];
  expect(assignment.role).toBe('REVIEWER');
  expect(deliveryReaderAssignment(next, assignment.workerId)?.role).toBe('REVIEWER');
  expect(next.subtasks).toEqual(state.subtasks);
  expect(next.iterationCount).toBe(3);
  expect(next.workers.filter((w) => w.workerId !== assignment.workerId)).toEqual(state.workers);
  const reviewer = next.workers.find((worker) => worker.workerId === assignment.workerId);
  if (!reviewer) throw Error('missing reviewer');
  reviewer.status = 'done';
  next.reviewComments.push({ id: 'verdict', kind: 'verdict', verdict: 'approved' });
  return next;
}
it('dispatches a new Reviewer without reopening historical subtasks', reviewedCandidate);

it.each(['apply_to_directory', 'artifact_only'] as const)(
  'requires the declared delivery goal after canonical approval: %s',
  async (goal) => {
    const state = reviewedCandidate();
    if (!state.localExecution?.delivery) throw Error('missing delivery');
    state.localExecution.delivery.goal = goal;
    const approved = approvedCompletion(state);
    expect(localDeliveryAwaitsApplication(approved)).toBe(goal === 'apply_to_directory');
    const decision = decide(approved, { newId: () => 'after-approval', now: () => 7 });
    expect(decision.route.kind).toBe(goal === 'artifact_only' ? 'finalize' : 'await_application');
    const next = applyMutations(approved, decision.mutations);
    expect(latestCoordinationLedger(next)?.progress.isRequestSatisfied.answer).toBe(
      goal === 'artifact_only',
    );
    expect(next.workers).toEqual(approved.workers);
    expect(next.localExecution).toEqual(approved.localExecution);
    expect(next.humanGate).toBeUndefined();
    const result = await runOrchestration(approved, {
      workerRuntime: new WorkerRuntime({
        roster: [],
        buildExecutor: () => {
          throw Error('unexpected worker');
        },
      }),
    });
    expect(result.phase).toBe(goal === 'artifact_only' ? 'done' : 'review');
    expect(result.workers).toEqual(approved.workers);
    expect(result.localExecution).toEqual(approved.localExecution);
  },
);

function applicationReceiptFixture() {
  const state = reviewedCandidate();
  const local = state.localExecution;
  if (!local) throw Error('missing fixture');
  const evidence = currentCompletionEvidence(state);
  const display = `/workspace apply ${JSON.stringify({ projectId: 'p', taskId: 't', actionId: 'apply', expectedRevision: 4, deliveryProposalId: 'proposal:fixed', inputHash: 'a'.repeat(64) })}`;
  state.messages.push({
    msgId: 'apply',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    ts: 5,
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  });
  local.workspaces.push({
    schemaVersion: 'workspace-v1',
    workspaceId: 'delivery',
    projectId: 'p',
    taskId: 't',
    rootId: 'root',
    grantId: 'grant',
    purpose: 'delivery',
    mode: 'direct',
    baselineManifestId: 'manifest:u',
  });
  const receipt: LocalDeliveryApplicationReceipt = {
    kind: 'workspace_delivery_application',
    version: 1,
    projectId: 'p',
    taskId: 't',
    applyActionId: 'apply',
    completionActionId: 'finish',
    claimId: 'claim',
    workspaceId: 'delivery',
    deliveryProposalId: 'proposal:fixed',
    inputHash: 'a'.repeat(64),
    roundId: 'round',
    reviewId: 'verdict',
    validationReceiptId: evidence.validationReceiptId,
    candidateVersion: { kind: 'files', manifestId: 'manifest:c', manifestHash: 'a'.repeat(64) },
    targetVersion: { kind: 'files', manifestId: 'manifest:target', manifestHash: 'b'.repeat(64) },
    grantId: 'grant',
    grantRevision: 0,
    controlFingerprint: 'c'.repeat(64),
    treeReceiptId: 'tree:fixed',
    treeInputHash: 'd'.repeat(64),
    closureReceiptId: 'closure:fixed',
    proofHash: 'e'.repeat(64),
  };
  const message = {
    msgId: 'delivery-applied:finish',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce' as const,
    ts: 6,
    display: 'Applied',
    payload: { ...receipt },
  };
  return { state, message };
}
it('requires committed application lineage while preserving approval and historical work', () => {
  const { state, message } = applicationReceiptFixture();
  expect(assertCurrentDeliveryApplication(state, message, false)).toEqual(message.payload);
  expect(() => assertCurrentDeliveryApplication(state, message)).toThrow(
    'delivery_application_receipt_uncommitted',
  );
  if (!state.localExecution) throw Error('fixture');
  state.localExecution.receipts.push({
    receiptId: 'binding:finish',
    actionId: 'finish',
    inputHash: 'f'.repeat(64),
    registryRevision: 6,
  });
  const next = applyMutations(state, [appendMutation('messages', message)]);
  expect(assertCurrentDeliveryApplication(next, message)).toEqual(message.payload);
  expect(() =>
    applyMutations(next, [
      appendMutation('messages', {
        ...message,
        payload: { ...message.payload, proofHash: 'f'.repeat(64) },
      }),
    ]),
  ).toThrow('immutable delivery application receipt');
  expect(next.workers).toEqual(state.workers);
});
it.each([
  'roundId',
  'reviewId',
  'validationReceiptId',
  'workspaceId',
  'grantId',
  'applyActionId',
] as const)('refuses an application receipt from another current binding: %s', (key) => {
  const { state, message } = applicationReceiptFixture();
  expect(() =>
    assertCurrentDeliveryApplication(
      state,
      { ...message, payload: { ...message.payload, [key]: 'other' } },
      false,
    ),
  ).toThrow();
});
it('refuses an application source whose canonical intent differs from the displayed action', () => {
  const { state, message } = applicationReceiptFixture();
  const source = state.messages.find((m) => m.msgId === 'apply');
  if (!source) throw Error('fixture');
  source.payload.intent = { kind: 'other' };
  expect(() => assertCurrentDeliveryApplication(state, message, false)).toThrow(
    'delivery_application_binding_changed',
  );
});

function approvedCompletion(
  state: AppState,
  option: 'approve_completion' | 'request_changes' = 'approve_completion',
) {
  const argument = option === 'request_changes' ? 'Fix the current candidate' : undefined;
  const built = buildCompletionResolution(state, {
    actionId: 'approve',
    reviewId: 'verdict',
    option,
    ...(argument ? { rationale: argument } : {}),
    ts: 5,
  });
  const approved = applyMutations(state, [
    appendMutation('decisionLedger', built.decision),
    appendMutation('messages', {
      msgId: 'approve',
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat',
      ts: 5,
      display: 'Approve',
      payload: {
        kind: 'leader_intent',
        intent: {
          kind: 'resolve_human_gate',
          gateId: 'human-gate:verdict',
          option,
          ...(argument ? { argument } : {}),
        },
        action: { status: 'applied' },
        resolution: {
          completionEvidence: currentCompletionEvidence(state),
          gateId: 'human-gate:verdict',
          option,
          ...(argument ? { argument } : {}),
          safePointRefs: [],
          resumeSessionId: 'human-gate-resume:approve',
        },
        completionResolution: built.action,
      },
    }),
    appendMutation('messages', {
      msgId: 'human-gate-resumed:approve',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 6,
      display: 'Resumed',
      payload: {
        kind: 'human_gate_resumed',
        actionId: 'approve',
        gateId: 'human-gate:verdict',
        resumeSessionId: 'human-gate-resume:approve',
      },
    }),
  ]);

  return approved;
}

function appliedCandidate() {
  const { state, message } = applicationReceiptFixture();
  if (!state.localExecution?.delivery) throw Error('fixture');
  state.localExecution.delivery.goal = 'apply_to_directory';
  state.localExecution.receipts.push({
    receiptId: 'binding:finish',
    actionId: 'finish',
    inputHash: 'f'.repeat(64),
    registryRevision: 6,
  });
  return { state: applyMutations(state, [appendMutation('messages', message)]), message };
}
it('atomically plans the approved applied version without changing historical work', () => {
  const f = appliedCandidate();
  const state = approvedCompletion(f.state);
  const mutations = planDeliveryFinalization(state, f.message, 10);
  const next = applyMutations(state, mutations);
  expect(next.phase).toBe('done');
  expect(latestCoordinationLedger(next)?.progress.isRequestSatisfied.answer).toBe(true);
  expect(next.messages.some((m) => m.payload.kind === 'workspace_delivery_completion')).toBe(true);
  expect(next.workers).toEqual(state.workers);
  expect(next.testResults).toEqual(state.testResults);
  expect(next.localExecution).toEqual(state.localExecution);
  expect(planDeliveryFinalization(next, f.message, 11)).toEqual([]);
});
it('refuses completion when an applied candidate lacks canonical Leader approval', () => {
  const f = appliedCandidate();
  expect(() => planDeliveryFinalization(f.state, f.message, 10)).toThrow();
});
it('refuses completion with an uncommitted application or unfinished worker', () => {
  const f = appliedCandidate();
  const state = approvedCompletion(f.state);
  state.messages = state.messages.filter((m) => m.msgId !== f.message.msgId);
  expect(() => planDeliveryFinalization(state, f.message, 10)).toThrow();
  state.messages.push(f.message);
  state.workers.push({
    workerId: 'unfinished',
    role: 'CODER',
    executor: 'harness',
    startedTs: 0,
    status: 'running',
  });
  expect(() => planDeliveryFinalization(state, f.message, 10)).toThrow();
});

it('keeps completion false until the trusted proof hook succeeds', async () => {
  const f = appliedCandidate();
  let canonical = approvedCompletion(f.state);
  const runtime = new WorkerRuntime({
    roster: [],
    buildExecutor: () => {
      throw Error('unexpected worker');
    },
  });
  await expect(
    runOrchestration(canonical, {
      workerRuntime: runtime,
      deliveryFinalizationOnly: true,
      transition: async (_old, mutations) => {
        canonical = applyMutations(canonical, mutations);
        return canonical;
      },
      finalizeLocalDelivery: async (state) => {
        expect(state.phase).toBe('review');
        expect(latestCoordinationLedger(state)?.progress.isRequestSatisfied.answer).toBe(false);
        throw Error('target_changed');
      },
    }),
  ).rejects.toThrow('target_changed');
  expect(canonical.phase).toBe('review');
  expect(latestCoordinationLedger(canonical)?.progress.isRequestSatisfied.answer).toBe(false);
  const result = await runOrchestration(canonical, {
    workerRuntime: runtime,
    deliveryFinalizationOnly: true,
    finalizeLocalDelivery: async (state) =>
      applyMutations(state, planDeliveryFinalization(state, f.message, Date.now())),
  });
  expect(result.phase).toBe('done');
  expect(result.workers).toEqual(canonical.workers);
  const completion = result.messages.find(
    (m) => m.payload.kind === 'workspace_delivery_completion',
  );
  if (!completion) throw Error('fixture');
  expect(() =>
    applyMutations(result, [
      appendMutation('messages', {
        ...completion,
        payload: { ...completion.payload, approvalActionId: 'other' },
      }),
    ]),
  ).toThrow('immutable delivery application receipt');
});
it('refuses to dispatch work through a completion-only run', async () => {
  const state = createInitialAppState('t', 'fixed', 'p');
  await expect(
    runOrchestration(state, {
      deliveryFinalizationOnly: true,
      workerRuntime: new WorkerRuntime({
        roster: [],
        buildExecutor: () => {
          throw Error('unexpected worker');
        },
      }),
      finalizeLocalDelivery: async (s) => s,
    }),
  ).rejects.toThrow('delivery_finalization_only');
});

// Pure repair eligibility; native command and workspace proofs remain host-owned.
it('selects only canonical same-round repair causes without mutating historical work', () => {
  const state = reviewedCandidate();
  expect(deliveryRepairSource(state)).toBeUndefined();
  const verdict = state.reviewComments.at(-1);
  if (!verdict) throw Error('fixture');
  verdict.verdict = 'changes_requested';
  const retained = structuredClone(state);
  expect(deliveryRepairSource(state)).toMatchObject({
    reason: 'review_changes_requested',
    roundId: 'round',
    triggerId: 'verdict',
    validationReceiptId: 'workspace-validation:test',
  });
  expect(state).toEqual(retained);
  verdict.issueScope = 'architecture';
  expect(() => deliveryRepairSource(state)).toThrow('delivery_repair_scope_requires_decision');
  delete verdict.issueScope;
  required(state.workers[0]).status = 'running';
  expect(() => deliveryRepairSource(state)).toThrow('delivery_repair_run_not_closed');
  const rejected = approvedCompletion(reviewedCandidate(), 'request_changes');
  expect(deliveryRepairSource(rejected)).toMatchObject({
    reason: 'leader_completion_changes_requested',
    triggerId: 'approve',
    reviewId: 'verdict',
  });
  rejected.messages = rejected.messages.filter((m) => m.msgId !== 'human-gate-resumed:approve');
  expect(() => deliveryRepairSource(rejected)).toThrow('delivery_repair_resolution_not_resumed');
});
it('requires an actual failed current validation receipt for a tester repair', () => {
  const state = reviewedCandidate();
  const receipt = state.messages.find((m) => m.msgId === 'workspace-validation:test');
  if (!receipt) throw Error('fixture');
  state.messages = state.messages.slice(0, state.messages.indexOf(receipt) + 1);
  state.workers = state.workers.filter((w) => w.role !== 'REVIEWER');
  state.reviewComments = [];
  state.phase = 'testing';
  state.nextRole = 'TESTER';
  const result = {
    ...required(state.testResults),
    passed: false,
    failed: 1,
    failures: [{ test: 'arithmetic', message: 'failed', file: 'arithmetic.test.cjs', line: 1 }],
  };
  state.testResults = result;
  receipt.payload.results = result;
  receipt.payload.execution = { exitCode: 1, timedOut: false, quiescent: true };
  expect(deliveryRepairSource(state)).toMatchObject({
    reason: 'tests_failed',
    triggerId: receipt.msgId,
    roundId: 'round',
  });
  const snapshot = structuredClone(state);
  state.testResults = { ...result, passed: true, failed: 0, failures: [] };
  expect(() => deliveryRepairSource(state)).toThrow();
  expect(deliveryRepairSource(snapshot)).toBeDefined();
  receipt.payload.controlFingerprint = '0'.repeat(64);
  expect(() => deliveryRepairSource(state)).toThrow();
});

it('routes delivery repair through a trusted host without reopening accepted subtasks', async () => {
  const state = reviewedCandidate();
  required(state.reviewComments.at(-1)).verdict = 'changes_requested';
  const snapshot = structuredClone(state);
  const decision = decide(state);
  expect(decision.route.kind).toBe('repair_delivery');
  expect(decision.mutations).toEqual([]);
  expect(state).toEqual(snapshot);
  const runtime = new WorkerRuntime({
    roster: [],
    buildExecutor: () => {
      throw Error('unexpected worker');
    },
  });
  await expect(runOrchestration(state, { workerRuntime: runtime })).rejects.toThrow(
    'local_delivery_repair_required',
  );
  expect(state).toEqual(snapshot);
  state.iterationCount = 8;
  expect(decide(state).route.kind).toBe('human_gate');
});

function repairRegistration(retainedGit = false, rejected?: AppState) {
  const state = rejected ?? reviewedCandidate();
  if (!rejected) required(state.reviewComments.at(-1)).verdict = 'changes_requested';
  if (retainedGit && state.localExecution) {
    const node = { id: 'original', title: 'Original task', dependsOn: [] };
    state.subtasks.push({ ...node, ownerRole: 'CODER', status: 'done' });
    state.messages.push({
      msgId: 'old-plan',
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: 0,
      display: 'Original plan',
      payload: { kind: 'execution_plan', plan: { version: 1, subtasks: [node] } },
    });

    state.parallelExecution = {
      version: 1,
      planId: 'old-plan',
      initialBase: { branch: 'base', commit: 'a'.repeat(40) },
    };
    state.localExecution.workspaces.push({
      schemaVersion: 'workspace-v1',
      projectId: state.projectId,
      taskId: state.taskId,
      workspaceId: 'initial',
      rootId: 'root',
      grantId: 'grant',
      purpose: 'integration',
      mode: 'linked-worktree',
      commonDirId: 'common',
      branch: 'base',
      baseCommit: 'a'.repeat(40),
    });
    state.localExecution.git = {
      version: 1,
      initialWorkspaceId: 'initial',
      worktrees: [{ workspaceId: 'initial', path: '/owned/initial', receiptId: 'binding:action' }],
    };
  }
  const source = deliveryRepairSource(state);
  if (!source || !state.localExecution) throw Error('fixture');
  const local = structuredClone(state.localExecution);
  local.workspaces.push({
    schemaVersion: 'workspace-v1',
    projectId: state.projectId,
    taskId: state.taskId,
    workspaceId: 'repair-workspace',
    rootId: 'root',
    grantId: 'grant',
    purpose: 'coding',
    mode: 'direct',
    baselineManifestId: source.workspaceVersion.manifestId,
  });
  local.bindings.push({
    workerId: 'worker:repair:0',
    workspaceId: 'repair-workspace',
    receiptId: 'binding:repair',
  });
  local.receipts.push({
    actionId: 'repair',
    receiptId: 'binding:repair',
    inputHash: 'f'.repeat(64),
    registryRevision: 4,
  });
  const recipe: LocalDeliveryRepairTransition = {
    kind: 'delivery-repair-start-v1',
    beforeStateHash: localRecordHash(state),
    workspaceId: 'repair-workspace',
    dispatch: {
      msgId: 'repair',
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: 10,
      display: 'Repair C',
      payload: {
        kind: 'delivery_repair_dispatch',
        nextRole: 'CODER',
        source,
        workerIds: ['worker:repair:0'],
      },
    },
    ledger: {
      msgId: 'repair-ledger',
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'chat',
      ts: 10,
      display: 'Repair current candidate',
      payload: buildCoordinationLedger(state, {
        nextSpeaker: 'CODER',
        instruction: 'Repair only the current candidate',
        completionCandidate: false,
        requestSatisfied: false,
      }),
    },
  };
  return { state, local, recipe };
}
it.each([false, true])(
  'registers one repair worker while preserving history, retained Git=%s',
  (retainedGit) => {
    const { state, local, recipe } = repairRegistration(retainedGit);
    const mutations = deliveryStartMutations(state, local, recipe, undefined);
    const next = applyMutations(state, [
      { op: 'set', field: 'localExecution', value: local },
      ...mutations,
    ]);
    expect(next.phase).toBe('coding');
    expect(deliveryRepairAssignment(next, 'worker:repair:0')?.workspace.workspaceId).toBe(
      'repair-workspace',
    );
    expect(deliveryRepairAssignment(next, 'old')).toBeUndefined();
    expect(next.iterationCount).toBe(state.iterationCount + 1);
    expect(next.workers.slice(0, -1)).toEqual(state.workers);
    expect(next.workers.at(-1)).toMatchObject({
      workerId: 'worker:repair:0',
      role: 'CODER',
      status: 'pending',
    });
    expect(next.subtasks).toEqual(state.subtasks);
    expect(next.parallelExecution).toEqual(state.parallelExecution);
    expect(next.localExecution?.delivery).toEqual(state.localExecution?.delivery);
    const unbound = structuredClone(next);
    unbound.messages = unbound.messages.filter((m) => m.msgId !== recipe.dispatch.msgId);
    expect(() => applyMutations(unbound, [])).toThrow('invalid_local_worker_binding');
    const wrongBinding = structuredClone(next);
    required(wrongBinding.localExecution?.bindings.at(-1)).receiptId = 'binding:action';
    expect(() => applyMutations(wrongBinding, [])).toThrow('delivery_repair_assignment_changed');

    expect(latestCoordinationLedger(next)?.progress.isRequestSatisfied.answer).toBe(false);
    expect(() => deliveryStartMutations(next, local, recipe, undefined)).toThrow();
  },
);
it('rejects repair recipes that change the source, prior binding or retained candidate', () => {
  for (const damage of ['source', 'binding', 'round', 'budget', 'program']) {
    const { state, local, recipe } = repairRegistration();
    if (damage === 'source')
      (recipe.dispatch.payload.source as { triggerId: string }).triggerId = 'other';
    if (damage === 'binding') required(local.bindings[0]).workspaceId = 'repair-workspace';
    if (damage === 'round')
      required(required(local.delivery).rounds[0]).controlFingerprint = '0'.repeat(64);
    if (damage === 'budget') state.iterationCount = 8;
    const input = damage === 'program' ? { ...recipe, mutations: [] } : recipe;
    expect(() => deliveryStartMutations(state, local, input, undefined)).toThrow();
  }
});

it('keeps historical Leader rejection verifiable during a new repair assignment', () => {
  const rejected = approvedCompletion(reviewedCandidate(), 'request_changes');
  const before = deriveCompletionFeedback(rejected);
  expect(before?.option).toBe('request_changes');
  const { state, local, recipe } = repairRegistration(false, rejected);
  const next = applyMutations(state, [
    { op: 'set', field: 'localExecution', value: local },
    ...deliveryStartMutations(state, local, recipe, undefined),
  ]);
  expect(deriveCompletionFeedback(next)).toEqual(before);
  expect(latestCoordinationLedger(next)?.progress.isRequestSatisfied.answer).toBe(false);
  const bad = structuredClone(next);
  required(bad.messages.find((m) => m.msgId === recipe.dispatch.msgId)).payload.workerIds = [
    'other',
  ];
  expect(() => deriveCompletionFeedback(bad)).toThrow('delivery_repair_assignment_changed');
});

function repairedCandidate() {
  const { state, local, recipe } = repairRegistration();
  const next = applyMutations(state, [
    { op: 'set', field: 'localExecution', value: local },
    ...deliveryStartMutations(state, local, recipe, undefined),
  ]);
  required(next.workers.at(-1)).status = 'done';
  const version = {
    kind: 'files' as const,
    manifestId: 'manifest:repaired',
    manifestHash: '9'.repeat(64),
  };
  next.messages.push({
    msgId: 'repair-candidate:repair',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    ts: 11,
    display: 'Fixed repair candidate',
    payload: {
      kind: 'workspace_delivery_repair_candidate',
      version: 1,
      projectId: next.projectId,
      taskId: next.taskId,
      roundId: 'round',
      dispatchId: 'repair',
      workerId: 'worker:repair:0',
      workspaceId: 'repair-workspace',
      workspaceVersion: version,
      controlFingerprint: 'c'.repeat(64),
      closureReceiptId: `closure:${'8'.repeat(64)}`,
      proofHash: '7'.repeat(64),
    },
  });
  next.messages.push({
    msgId: 'test-repaired',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    ts: 12,
    display: 'Validate repaired candidate',
    payload: {
      kind: 'delivery_validation_dispatch',
      nextRole: 'TESTER',
      roundId: 'round',
      workerIds: ['worker:test-repaired:0'],
      workspaceVersion: version,
      repairCandidateReceiptId: 'repair-candidate:repair',
    },
  });
  next.phase = 'testing';
  next.nextRole = 'TESTER';
  return { next, version };
}
it('selects the closed C2 successor while preserving the original validation receipt', () => {
  const { next, version } = repairedCandidate();
  expect(deliveryValidationDispatch(next)).toMatchObject({
    workerId: 'worker:test-repaired:0',
    workspaceVersion: version,
  });
  expect(localValidationReceipt(next, 'workspace-validation:test').workspaceVersion).toEqual(
    next.localExecution?.delivery?.rounds[0]?.candidateVersion,
  );
  expect(next.localExecution?.delivery?.rounds[0]?.candidateVersion).not.toEqual(version);
});
it.each(['missing', 'duplicate', 'version', 'worker', 'authority'] as const)(
  'rejects a broken successor chain: %s',
  (damage) => {
    const { next } = repairedCandidate();
    const candidate = required(next.messages.find((m) => m.msgId === 'repair-candidate:repair'));
    const dispatch = required(next.messages.at(-1));
    if (damage === 'missing') next.messages = next.messages.filter((m) => m !== candidate);
    if (damage === 'duplicate')
      next.messages.push({
        ...dispatch,
        msgId: 'duplicate-test',
        payload: { ...dispatch.payload, workerIds: ['worker:duplicate-test:0'] },
      });
    if (damage === 'version')
      candidate.payload.workspaceVersion =
        next.localExecution?.delivery?.rounds[0]?.candidateVersion;
    if (damage === 'worker')
      required(next.workers.find((w) => w.workerId === 'worker:repair:0')).status = 'running';
    if (damage === 'authority') candidate.fromRole = 'CODER';
    expect(() => deliveryValidationDispatch(next)).toThrow();
  },
);

it('routes only the registered repair Coder and then requires trusted C2 closure', async () => {
  const { state, local, recipe } = repairRegistration();
  const next = applyMutations(state, [
    { op: 'set', field: 'localExecution', value: local },
    ...deliveryStartMutations(state, local, recipe, undefined),
  ]);
  const before = structuredClone(next);
  expect(decide(next)).toEqual({
    route: {
      kind: 'worker',
      parallel: false,
      batch: [{ role: 'CODER', workerId: 'worker:repair:0' }],
    },
    mutations: [],
  });
  expect(next).toEqual(before);
  const projection = projectForAssignment(
    next,
    { role: 'CODER', workerId: 'worker:repair:0' },
    DEFAULT_ROSTER,
  );
  expect(projection.slices.deliveryRepair).toEqual(recipe.dispatch.payload.source);
  expect(projection.slices.assignedSubtask).toEqual([]);
  required(next.workers.at(-1)).status = 'done';
  expect(decide(next)).toEqual({
    route: { kind: 'validate_delivery_repair', workerId: 'worker:repair:0' },
    mutations: [],
  });
  await expect(
    runOrchestration(next, {
      workerRuntime: new WorkerRuntime({
        roster: [],
        buildExecutor: () => {
          throw Error('unexpected worker');
        },
      }),
    }),
  ).rejects.toThrow('local_delivery_repair_completion_required');
  required(next.workers.at(-1)).status = 'failed';
  expect(() => decide(next)).toThrow('delivery_repair_not_closed');
});

it('rejects a repair host that rewrites historical workers before any execution', async () => {
  const { state, local, recipe } = repairRegistration();
  const prepared = applyMutations(structuredClone(state), [
    { op: 'set', field: 'localExecution', value: local },
    ...deliveryStartMutations(state, local, recipe, undefined),
  ]);
  required(prepared.workers[0]).status = 'failed';
  await expect(
    runOrchestration(state, {
      workerRuntime: new WorkerRuntime({
        roster: [],
        buildExecutor: () => {
          throw Error('unexpected worker');
        },
      }),
      prepareLocalDeliveryRepair: async () => prepared,
    }),
  ).rejects.toThrow('local_delivery_repair_registration_changed');
});
it.each(['budget', 'workers', 'round'] as const)(
  'rejects a C2 completion host that rewrites %s',
  async (damage) => {
    const { state, local, recipe } = repairRegistration();
    const closed = applyMutations(state, [
      { op: 'set', field: 'localExecution', value: local },
      ...deliveryStartMutations(state, local, recipe, undefined),
    ]);
    required(closed.workers.at(-1)).status = 'done';
    const completed = repairedCandidate().next;
    delete completed.testResults;
    if (damage === 'budget') completed.iterationCount++;
    if (damage === 'workers') required(completed.workers[0]).status = 'failed';
    if (damage === 'round')
      required(required(completed.localExecution?.delivery).rounds[0]).targetIndexHash = 'f'.repeat(
        64,
      );
    await expect(
      runOrchestration(closed, {
        workerRuntime: new WorkerRuntime({
          roster: [],
          buildExecutor: () => {
            throw Error('unexpected worker');
          },
        }),
        completeLocalDeliveryRepair: async () => completed,
      }),
    ).rejects.toThrow('local_delivery_repair_completion_changed');
  },
);
