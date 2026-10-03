// Readiness and physical evidence are port doubles here. These tests verify
// registration/CAS/replay policy, not native writer admission or G5.
import {
  applyMutations,
  createInitialAppState,
  deliveryRepairSource,
  type LocalValidationReceipt,
  parseWorkspaceControl,
  setMutation,
} from '@agora/core-domain';
import type {
  WorkspaceCommandResult,
  WorkspaceValidationEvidencePort,
} from '@agora/runtime-sandbox';
import { expect, it, vi } from 'vitest';
import type { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { repairStartMutations } from '../../../packages/runtime/sandbox/src/local-delivery-repair-transition';
import type { LocalDeliveryRepairs } from '../../../packages/runtime/sandbox/src/local-delivery-repairs';
import {
  type LocalBindingOperation,
  type LocalRegistryRecords,
  localRecordHash,
} from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalDeliveryRepairControl } from '../src/server/local-delivery-repair-control';
import { LocalValidationService, localControlFingerprint } from '../src/server/local-validation';
import {
  localValidationCommand,
  parseLocalValidationResult,
} from '../src/server/local-validation-command';

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
function failedCandidate() {
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
    results: {
      passed: false,
      total: 1,
      failed: 1,
      failures: [{ test: 'candidate', message: 'failed', file: 'candidate.test.cjs', line: 1 }],
      workspaceVersion: version,
    },
    execution: { exitCode: 1, timedOut: false, quiescent: true },
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
  return state;
}

function harness() {
  const state = failedCandidate();
  const source = deliveryRepairSource(state);
  if (!source || !state.localExecution) throw Error('fixture');
  const registry: LocalRegistryRecords = {
    schemaVersion: 'local-workspaces-v1',
    revision: 2,
    roots: [],
    operations: [],
    workspaces: structuredClone(state.localExecution.workspaces),
    claims: [],
    grants: [
      {
        grantId: 'grant',
        projectId: 'p',
        rootId: 'root',
        revision: 0,
        policyVersion: 'v1',
        actions: ['read', 'edit'],
        toolchainHash: 'd'.repeat(64),
        networkHash: 'f'.repeat(64),
        policyHash: 'e'.repeat(64),
        createdActionId: 'grant',
        leaderMessageId: 'grant',
        status: 'active',
        revocationActionId: null,
      },
    ],
  };
  const control = {
    snapshot: vi.fn(async () => registry),
    assertClosed: vi.fn(async () => state),
    recover: vi.fn<LocalBindingCoordinator['recover']>(),
    commitBinding: vi.fn<LocalBindingCoordinator['commitBinding']>(
      async () => ({}) as LocalBindingOperation,
    ),
  };
  const repairs = {
    prepare: vi.fn<LocalDeliveryRepairs['prepare']>(async () => {
      throw Error('unconfigured');
    }),
  };
  repairs.prepare.mockImplementation(async (_request, authorize) => {
    if (!(await authorize())) throw Error('authorization_closed');
    return {} as Awaited<ReturnType<LocalDeliveryRepairs['prepare']>>;
  });
  const evidence = {
    assertReady: vi.fn(async () => {}),
    verifySource: vi.fn(async () => {}),
    verifyGrant: vi.fn(async () => {}),
    verifyClosedClaim: vi.fn(async () => 'close:old'),
    loadState: vi.fn(async () => state),
  };
  const service = new LocalDeliveryRepairControl(control, repairs, evidence);
  return { state, source, registry, control, repairs, evidence, service };
}
it('registers a private repair without rewriting history or resetting budgets', async () => {
  const f = harness();
  const before = structuredClone(f.state);
  await f.service.prepare(f.state, f.source);
  const request = f.control.commitBinding.mock.calls[0]?.[0];
  if (!request) throw Error('missing commit');
  expect(f.state).toEqual(before);
  expect(request.sourceMessageId).toBe('action');
  expect(request.sourceMessage).toBeUndefined();
  expect(request.deliveryTransition).toMatchObject({
    kind: 'delivery-repair-start-v1',
    beforeStateHash: localRecordHash(before),
  });
  expect(request.nextLocalExecution.delivery).toEqual(before.localExecution?.delivery);
  expect(request.nextLocalExecution.workspaces.slice(0, -1)).toEqual(
    before.localExecution?.workspaces,
  );
  expect(request.records.claims.at(-1)).toMatchObject({
    status: 'active',
    writerEpoch: 1,
    workerId: `worker:${request.actionId}:0`,
  });
  expect(f.evidence.verifySource).toHaveBeenCalledTimes(2);
});
it('requires genuine closure before releasing a prior direct worker claim', async () => {
  const f = harness();
  f.registry.claims.push({
    claimId: 'old',
    projectId: 'p',
    taskId: 't',
    workspaceId: 'validation',
    workerId: 'worker:test:0',
    writerEpoch: 4,
    createdActionId: 'action',
    status: 'active',
    closureReceiptId: null,
  });
  f.evidence.verifyClosedClaim.mockRejectedValueOnce(Error('not_closed'));
  await expect(f.service.prepare(f.state, f.source)).rejects.toThrow('not_closed');
  expect(f.repairs.prepare).not.toHaveBeenCalled();
  expect(f.registry.claims[0]?.status).toBe('active');
  await f.service.prepare(f.state, f.source);
  expect(f.control.commitBinding.mock.calls[0]?.[0].records.claims).toMatchObject([
    { status: 'released', closureReceiptId: 'close:old' },
    { status: 'active', writerEpoch: 5 },
  ]);
});
it('preserves a retained linked worker claim when registering a private direct repair', async () => {
  const f = harness();
  f.registry.workspaces.push({
    schemaVersion: 'workspace-v1',
    projectId: 'p',
    taskId: 't',
    workspaceId: 'retained-linked',
    rootId: 'root',
    grantId: 'grant',
    purpose: 'coding',
    mode: 'linked-worktree',
    commonDirId: 'retained-common',
    branch: 'retained',
    baseCommit: 'a'.repeat(40),
  });
  f.registry.claims.push({
    claimId: 'retained-claim',
    projectId: 'p',
    taskId: 't',
    workspaceId: 'retained-linked',
    workerId: 'old-coder',
    writerEpoch: 4,
    createdActionId: 'old-action',
    status: 'active',
    closureReceiptId: null,
  });
  const retained = structuredClone(f.registry.claims[0]);
  await f.service.prepare(f.state, f.source);
  expect(f.control.commitBinding.mock.calls[0]?.[0].records.claims[0]).toEqual(retained);
  expect(f.evidence.verifyClosedClaim).not.toHaveBeenCalled();
});
it.each(['budget', 'grant', 'state', 'source'] as const)(
  'rejects changed %s before registration',
  async (kind) => {
    const f = harness();
    if (kind === 'budget') f.state.iterationCount = 8;
    if (kind === 'grant') {
      const g = f.registry.grants[0];
      if (g) g.revision++;
    }
    if (kind === 'state') f.control.assertClosed.mockResolvedValue({ ...f.state, goal: 'changed' });
    if (kind === 'source') f.evidence.verifySource.mockRejectedValue(Error('source_changed'));
    await expect(f.service.prepare(f.state, f.source)).rejects.toThrow();
    expect(f.repairs.prepare).not.toHaveBeenCalled();
    expect(f.control.commitBinding).not.toHaveBeenCalled();
  },
);
it('rejects a concurrent control change after copying the private input', async () => {
  const f = harness();
  f.repairs.prepare.mockImplementationOnce(async () => {
    f.state.goal = 'changed';
    return {} as Awaited<ReturnType<LocalDeliveryRepairs['prepare']>>;
  });
  await expect(f.service.prepare(f.state, f.source)).rejects.toThrow(
    'delivery_transition_state_changed',
  );
  expect(f.control.commitBinding).not.toHaveBeenCalled();
});
it('replays a recorded action without copying, running, or gaining another claim', async () => {
  const f = harness();
  await f.service.prepare(f.state, f.source);
  const request = f.control.commitBinding.mock.calls[0]?.[0];
  if (!request?.deliveryTransition) throw Error('missing commit');
  const op: LocalBindingOperation = {
    actionId: request.actionId,
    projectId: 'p',
    taskId: 't',
    inputHash: 'a'.repeat(64),
    receiptId: `binding:${request.actionId}`,
    preparedRevision: 3,
    stage: 'prepared',
    previousLocalHash: 'b'.repeat(64),
    nextLocalExecution: request.nextLocalExecution,
    sourceMessageId: 'action',
    deliveryTransition: request.deliveryTransition,
  };
  f.registry.operations.push(op);
  await expect(f.service.prepare(f.state, f.source)).rejects.toThrow(
    'delivery_repair_recovery_required',
  );
  f.state.localExecution?.receipts.push({
    receiptId: op.receiptId,
    actionId: op.actionId,
    registryRevision: 3,
    inputHash: op.inputHash,
  });
  await f.service.prepare(f.state, f.source);
  expect(f.control.recover).toHaveBeenCalledWith(op.actionId, op.inputHash);
  expect(f.repairs.prepare).toHaveBeenCalledTimes(1);
  expect(f.control.commitBinding).toHaveBeenCalledTimes(1);
});

async function repairValidationFixture() {
  const f = harness();
  const fact = f.state.messages.find((m) => m.msgId === f.source.validationReceiptId);
  const round = f.state.localExecution?.delivery?.rounds[0];
  if (!fact || !round) throw Error('fixture');
  const command = {
    workerId: 'worker:test:0',
    inputHash: '1'.repeat(64),
    policyHash: 'e'.repeat(64),
    inputVersion: f.source.workspaceVersion,
    stage: 'exited',
    exitCode: 1,
    timedOut: false,
    quiescent: true,
    reason: 'none',
    stdout:
      'TAP version 13\n# Subtest: candidate\nnot ok 1 - candidate\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n',
  } as WorkspaceCommandResult;
  fact.payload.results = parseLocalValidationResult(command);
  f.state.testResults = parseLocalValidationResult(command);
  round.controlFingerprint = localControlFingerprint(f.state);
  fact.payload.controlFingerprint = round.controlFingerprint;
  const source = deliveryRepairSource(f.state);
  if (!source) throw Error('fixture');
  await f.service.prepare(f.state, source);
  const request = f.control.commitBinding.mock.calls[0]?.[0];
  if (request?.deliveryTransition?.kind !== 'delivery-repair-start-v1') throw Error('fixture');
  const local = request.nextLocalExecution;
  local.receipts.push({
    actionId: request.actionId,
    receiptId: `binding:${request.actionId}`,
    inputHash: 'a'.repeat(64),
    registryRevision: 3,
  });
  const active = applyMutations(f.state, [
    setMutation('localExecution', local),
    ...repairStartMutations(f.state, local, request.deliveryTransition),
  ]);
  const workerId = `worker:${request.actionId}:0`;
  const inspection = {
    version: source.workspaceVersion,
    excludedPaths: [],
    files: [
      {
        path: 'candidate.test.cjs',
        version: {
          kind: 'regular' as const,
          identity: '1:2',
          sha256: 'a'.repeat(64),
          size: 1,
          executable: false,
          metadataHash: 'b'.repeat(64),
        },
      },
    ],
  };
  const evidence: WorkspaceValidationEvidencePort = {
    verifyCurrentVersion: vi.fn(async () => ({
      inspection,
      policyHash: 'e'.repeat(64),
      toolchainHash: 'd'.repeat(64),
    })),
    verifyCommand: vi.fn(async () => ({
      command,
      request: localValidationCommand(inspection),
      toolchainHash: 'd'.repeat(64),
      dependenciesHash: 'f'.repeat(64),
    })),
  };
  const service = new LocalValidationService(evidence, async () => active);
  return { active, source, workerId, command, inspection, evidence, service };
}

it('reproves the immutable source while only its registered repair Coder is active', async () => {
  const { active, source, workerId, command, evidence, service } = await repairValidationFixture();
  await expect(service.verify(active, source.validationReceiptId)).rejects.toThrow(
    'local_validation_source_not_ready',
  );
  await service.verifyRepairSource(active, workerId);
  expect(evidence.verifyCurrentVersion).toHaveBeenCalledWith(
    { projectId: 'p', taskId: 't', workspaceId: 'validation' },
    source.workspaceVersion,
  );
  command.inputHash = '0'.repeat(64);
  await expect(service.verifyRepairSource(active, workerId)).rejects.toThrow(
    'local_validation_execution_changed',
  );
  command.inputHash = '1'.repeat(64);
  active.workers.push({
    workerId: 'intruder',
    role: 'CODER',
    executor: 'harness',
    status: 'running',
    startedTs: 1,
  });
  await expect(service.verifyRepairSource(active, workerId)).rejects.toThrow(
    'local_validation_source_not_ready',
  );
});

it('reproves an immutable ancestor for a canonical second repair but rejects unrelated writers', async () => {
  const f = await repairValidationFixture();
  const state = structuredClone(f.active);
  const local = state.localExecution;
  const first = state.workers.find((w) => w.workerId === f.workerId);
  const firstBinding = local?.bindings.find((b) => b.workerId === f.workerId);
  const firstWorkspace = local?.workspaces.find((w) => w.workspaceId === firstBinding?.workspaceId);
  const firstDispatch = state.messages.find((m) => `worker:${m.msgId}:0` === f.workerId);
  const originalReceipt = state.messages.find((m) => m.msgId === f.source.validationReceiptId);
  if (!local || !first || !firstWorkspace || !firstDispatch || !originalReceipt)
    throw Error('fixture');
  first.status = 'done';
  let ts = Math.max(...state.messages.map((m) => m.ts)) + 1;
  state.messages.push(
    {
      msgId: `repair-candidate:${firstDispatch.msgId}`,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: ts++,
      display: 'Closed C2',
      payload: {
        kind: 'workspace_delivery_repair_candidate',
        version: 1,
        projectId: 'p',
        taskId: 't',
        roundId: 'round',
        dispatchId: firstDispatch.msgId,
        workerId: f.workerId,
        workspaceId: firstWorkspace.workspaceId,
        workspaceVersion: f.source.workspaceVersion,
        controlFingerprint: f.source.controlFingerprint,
        closureReceiptId: `closure:${'6'.repeat(64)}`,
        proofHash: '7'.repeat(64),
      },
    },
    {
      msgId: 'test2',
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: ts++,
      display: 'Test C2',
      payload: {
        kind: 'delivery_validation_dispatch',
        nextRole: 'TESTER',
        roundId: 'round',
        workerIds: ['worker:test2:0'],
        workspaceVersion: f.source.workspaceVersion,
        repairCandidateReceiptId: `repair-candidate:${firstDispatch.msgId}`,
      },
    },
    {
      ...structuredClone(originalReceipt),
      msgId: 'workspace-validation:test2',
      ts: ts++,
      payload: {
        ...structuredClone(originalReceipt.payload),
        dispatchId: 'test2',
        workerId: 'worker:test2:0',
        sourceWorkspaceId: 'validation2',
        validationWorkspaceId: 'validation2',
        commandReceiptId: 'command:2',
      },
    },
  );
  local.workspaces.push({ ...firstWorkspace, workspaceId: 'validation2', purpose: 'validation' });
  local.bindings.push({
    workerId: 'worker:test2:0',
    workspaceId: 'validation2',
    receiptId: 'binding:test2',
  });
  local.receipts.push({
    actionId: 'test2',
    receiptId: 'binding:test2',
    registryRevision: 4,
    inputHash: '9'.repeat(64),
  });
  state.workers.push({
    workerId: 'worker:test2:0',
    role: 'TESTER',
    status: 'done',
    executor: 'harness',
    startedTs: ts++,
  });
  const secondId = 'worker:repair-second:0';
  state.messages.push({
    msgId: 'repair-second',
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    ts: ts++,
    display: 'Repair C2',
    payload: {
      kind: 'delivery_repair_dispatch',
      nextRole: 'CODER',
      workerIds: [secondId],
      source: {
        ...f.source,
        validationReceiptId: 'workspace-validation:test2',
        sourceWorkspaceId: 'validation2',
        triggerId: 'workspace-validation:test2',
      },
    },
  });
  local.workspaces.push({ ...firstWorkspace, workspaceId: 'repair-second-workspace' });
  local.bindings.push({
    workerId: secondId,
    workspaceId: 'repair-second-workspace',
    receiptId: 'binding:repair-second',
  });
  local.receipts.push({
    actionId: 'repair-second',
    receiptId: 'binding:repair-second',
    registryRevision: 4,
    inputHash: '8'.repeat(64),
  });
  state.workers.push({
    workerId: secondId,
    role: 'CODER',
    status: 'running',
    executor: 'harness',
    startedTs: ts++,
  });
  let service: LocalValidationService;
  const evidence: WorkspaceValidationEvidencePort = {
    verifyCurrentVersion: vi.fn(async (scope) => {
      if (scope.workspaceId === 'validation2') await service.verifyRepairSource(state, f.workerId);
      return {
        inspection: f.inspection,
        policyHash: 'e'.repeat(64),
        toolchainHash: 'd'.repeat(64),
      };
    }),
    verifyCommand: vi.fn(async (_scope, receiptId) => ({
      command: {
        ...f.command,
        workerId: receiptId === 'command:2' ? 'worker:test2:0' : 'worker:test:0',
      },
      request: localValidationCommand(f.inspection),
      toolchainHash: 'd'.repeat(64),
      dependenciesHash: 'f'.repeat(64),
    })),
  };
  service = new LocalValidationService(evidence, async () => state);
  await service.verifyRepairSource(state, secondId);
  await expect(service.verify(state, f.source.validationReceiptId)).rejects.toThrow(
    'local_validation_source_not_ready',
  );
  state.workers.push({
    workerId: 'unrelated',
    role: 'CODER',
    status: 'running',
    executor: 'harness',
    startedTs: ts++,
  });
  await expect(service.verifyRepairSource(state, secondId)).rejects.toThrow(
    'local_validation_source_not_ready',
  );
  state.workers.pop();
  const successor = state.messages.find((m) => m.msgId === 'test2');
  if (!successor) throw Error('fixture');
  successor.payload.repairCandidateReceiptId = 'missing';
  await expect(service.verifyRepairSource(state, secondId)).rejects.toThrow(
    'delivery_dispatch_invalid',
  );
});

it('publishes C2 and its successor atomically, with effect-free completion replay', async () => {
  const { LocalDeliveryRepairCompletion } = await import(
    '../src/server/local-delivery-repair-completion'
  );
  const f = harness();
  await f.service.prepare(f.state, f.source);
  const request = f.control.commitBinding.mock.calls[0]?.[0];
  if (request?.deliveryTransition?.kind !== 'delivery-repair-start-v1') throw Error('fixture');
  const local = request.nextLocalExecution;
  local.receipts.push({
    actionId: request.actionId,
    receiptId: `binding:${request.actionId}`,
    inputHash: 'a'.repeat(64),
    registryRevision: 3,
  });
  let state = applyMutations(f.state, [
    setMutation('localExecution', local),
    ...repairStartMutations(f.state, local, request.deliveryTransition),
  ]);
  const worker = state.workers.at(-1);
  if (!worker) throw Error('fixture');
  worker.status = 'done';
  f.registry.claims = request.records.claims;
  f.control.assertClosed.mockImplementation(async () => state);
  const { seal } = {
    seal: vi.fn<LocalDeliveryRepairs['seal']>(async (_state, id, _grant, closure) => ({
      kind: 'workspace_delivery_repair_candidate',
      version: 1,
      projectId: 'p',
      taskId: 't',
      roundId: 'round',
      dispatchId: request.actionId,
      workerId: id,
      workspaceId:
        request.deliveryTransition?.kind === 'delivery-repair-start-v1'
          ? request.deliveryTransition.workspaceId
          : 'missing',
      workspaceVersion: {
        kind: 'files',
        manifestId: 'manifest:repaired',
        manifestHash: '9'.repeat(64),
      },
      controlFingerprint: f.source.controlFingerprint,
      closureReceiptId: closure,
      proofHash: '7'.repeat(64),
    })),
  };
  const commit = vi.fn(async (_before, mutations) => {
    state = applyMutations(state, mutations);
    return state;
  });
  const service = new LocalDeliveryRepairCompletion(
    f.control,
    { seal },
    {
      assertReady: f.evidence.assertReady,
      verifyGrant: f.evidence.verifyGrant,
      verifySource: vi.fn(async () => {}),
      verifyClosedClaim: async () => `closure:${'8'.repeat(64)}`,
      compareAndCommit: commit,
    },
  );
  const retained = structuredClone(state.localExecution?.delivery);
  const result = await service.complete({ projectId: 'p', taskId: 't' }, worker.workerId);
  expect(result.phase).toBe('testing');
  expect(result.testResults).toBeUndefined();
  expect(result.iterationCount).toBe(4);
  expect(result.localExecution?.delivery).toEqual(retained);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(await service.complete({ projectId: 'p', taskId: 't' }, worker.workerId)).toEqual(result);
  expect(seal).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledTimes(1);
});
