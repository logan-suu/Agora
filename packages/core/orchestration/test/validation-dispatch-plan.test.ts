// Pure control planning only; native completion/closure evidence is verified by its runtime port.
// Port fakes below isolate CAS response loss; the real Git/native source is covered by integration tests.
import { applyMutations, type RoleSpec, setMutation } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { localRecordHash } from '../../../runtime/sandbox/src/local-registry-records';
import { planIntegrationAcknowledgement } from '../../domain/src/integration-acknowledgement';
import { planIntegrationCompletion } from '../../domain/src/integration-completion';
import { selectIntegrationBranch } from '../../domain/src/integration-selection';
import { fixture } from '../../domain/test/integration-fixture';
import { decide } from '../src/coordinator';
import {
  commitInitialValidationDispatch,
  publishAndCommitInitialValidationDispatch,
} from '../src/initial-validation-dispatch-service';
import { createInitialValidationRegistrationRequest } from '../src/initial-validation-registration-plan';
import {
  createInitialValidationDispatchPlan,
  createValidationDispatchVerifier,
  initialValidationDispatchChanges,
} from '../src/validation-dispatch-plan';

const seed = { dispatchId: 'validate-1', dispatchTs: 10, ledgerId: 'progress-1', ledgerTs: 11 };
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('missing fixture value');
  return value;
}
const context = {
  initialBase: { branch: 'initial', commit: 'a'.repeat(40) },
  controlFingerprint: 'f'.repeat(64),
};
const roster: RoleSpec[] = [
  {
    role: 'TESTER',
    executor: 'harness',
    systemPrompt: '',
    tools: [],
    projection: [],
    routeWhen: 'always',
  },
];

it('pins first TESTER registration to the completed integration source and current released claim', () => {
  const before = completed();
  const plan = createInitialValidationDispatchPlan(before, seed, context, roster);
  const integration = required(plan.after.integration);
  const sourceWorkspaceId = 'integration-source';
  const registry = {
    revision: 12,
    roots: [{ rootId: 'root', projectId: before.projectId }],
    grants: [{ grantId: 'grant', rootId: 'root', projectId: before.projectId, status: 'active' }],
    workspaces: [
      {
        workspaceId: sourceWorkspaceId,
        projectId: before.projectId,
        taskId: before.taskId,
        rootId: 'root',
        grantId: 'grant',
        purpose: 'integration',
        mode: 'linked-worktree',
      },
    ],
    claims: [{ claimId: 'claim', workspaceId: sourceWorkspaceId, status: 'released' }],
  };
  const input = {
    scope: {
      projectId: before.projectId,
      taskId: before.taskId,
      waveId: integration.waveId,
      attempt: required(plan.after.parallelExecution?.activeWave).attempt,
      integrationId: integration.integrationId,
    },
    planHash: 'a'.repeat(64),
    actionId: 'register-validation',
    validationWorkspaceId: 'validation-new',
    call: {
      projectId: before.projectId,
      taskId: before.taskId,
      integrationId: integration.integrationId,
      workspaceId: sourceWorkspaceId,
      claimId: 'claim',
      writerEpoch: 1,
      grantRevision: 1,
    },
    version: {
      kind: 'git' as const,
      commit: required(integration.resultCommit),
      manifestId: `manifest:${'b'.repeat(64)}`,
      manifestHash: 'b'.repeat(64),
    },
    plan,
    current: plan.after,
    registry,
  };
  const request = createInitialValidationRegistrationRequest(input, context, roster);
  expect(request).toMatchObject({
    actionId: 'register-validation',
    projectId: before.projectId,
    taskId: before.taskId,
    rootId: 'root',
    grantId: 'grant',
    expectedRevision: 12,
    sourceWorkspaceId,
    version: input.version,
    targets: [
      { purpose: 'validation', workspaceId: 'validation-new', workerId: 'worker:validate-1:0' },
    ],
  });
  expect(() =>
    createInitialValidationRegistrationRequest(
      { ...input, current: { ...plan.after, phase: 'review' } },
      context,
      roster,
    ),
  ).toThrow();
  expect(() =>
    createInitialValidationRegistrationRequest(
      { ...input, version: { ...input.version, commit: 'e'.repeat(40) } },
      context,
      roster,
    ),
  ).toThrow();
  expect(() =>
    createInitialValidationRegistrationRequest(
      {
        ...input,
        registry: { ...registry, claims: [{ ...required(registry.claims[0]), status: 'active' }] },
      },
      context,
      roster,
    ),
  ).toThrow();
  expect(() =>
    createInitialValidationRegistrationRequest(
      { ...input, validationWorkspaceId: sourceWorkspaceId },
      context,
      roster,
    ),
  ).toThrow();
});

it('dispatches the next TESTER from the current dedicated Integration after an accepted wave', () => {
  const before = completed();
  const previous = required(before.integration);
  const acceptedCommit = 'e'.repeat(40);
  const nextCommit = 'f'.repeat(40);
  before.workers.push({
    workerId: 'worker:previous-validation:0',
    role: 'TESTER',
    executor: 'harness',
    status: 'done',
    startedTs: 3,
  });
  before.messages.push(
    {
      msgId: 'previous-validation',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 3,
      display: 'Previous validation dispatch',
      payload: {
        kind: 'wave_validation_dispatch',
        planId: 'plan',
        waveId: 'wave',
        attempt: 1,
        integrationId: previous.integrationId,
        inputCommit: required(previous.resultCommit),
        subtaskIds: ['A', 'B'],
      },
    },
    {
      msgId: 'wave-validation:previous-validation',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 4,
      display: 'Previous validation',
      payload: {
        kind: 'wave_validation',
        version: 1,
        planId: 'plan',
        waveId: 'wave',
        attempt: 1,
        dispatchId: 'previous-validation',
        workerId: 'worker:previous-validation:0',
        integrationId: previous.integrationId,
        inputCommit: required(previous.resultCommit),
        worktree: {
          path: '/owned/accepted',
          branch: 'accepted-branch',
          baseCommit: required(previous.resultCommit),
          headCommit: acceptedCommit,
        },
        subtaskIds: ['A', 'B'],
        controlFingerprint: 'f'.repeat(64),
        results: { passed: true, total: 1, failed: 0, failures: [] },
        evidence: {
          path: 'validation/previous-validation.json',
          sha256: 'a'.repeat(64),
          exitCode: 0,
          timedOut: false,
        },
      },
    },
    {
      msgId: 'wave-next',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 5,
      display: 'Next coding wave',
      payload: {
        kind: 'coding_wave',
        planId: 'plan',
        nextRole: 'CODER',
        attempt: 1,
        base: { branch: 'accepted-branch', commit: acceptedCommit },
        subtaskIds: ['B'],
        workerIds: ['worker-B'],
      },
    },
  );
  before.parallelExecution = {
    version: 1,
    planId: 'plan',
    initialBase: context.initialBase,
    acceptedReceiptId: 'wave-validation:previous-validation',
    activeWave: {
      waveId: 'wave-next',
      attempt: 1,
      base: { branch: 'accepted-branch', commit: acceptedCommit },
      subtaskIds: ['B'],
      coderWorkerIds: ['worker-B'],
    },
  };
  before.integration = {
    integrationId: 'integration-next',
    waveId: 'wave-next',
    base: { branch: 'accepted-branch', commit: acceptedCommit },
    integrationWorktree: {
      path: '/owned/integration-next',
      branch: 'integration-next',
      baseCommit: acceptedCommit,
      headCommit: nextCommit,
    },
    pendingBranches: [required(previous.pendingBranches[1])],
    mergedBranches: [
      {
        workerId: 'worker-B',
        subtaskId: 'B',
        branch: 'B',
        headCommit: 'b'.repeat(40),
        mergeCommit: nextCommit,
      },
    ],
    conflicts: [],
    status: 'done',
    resultCommit: nextCommit,
  };
  const next = createInitialValidationDispatchPlan(before, seed, context, roster);
  expect(next.after.parallelExecution?.activeWave?.validation).toMatchObject({
    integrationId: 'integration-next',
    inputCommit: nextCommit,
    workerId: 'worker:validate-1:0',
  });
  expect(next.after.integration).toEqual(before.integration);
  const registration = createInitialValidationRegistrationRequest(
    {
      scope: {
        projectId: before.projectId,
        taskId: before.taskId,
        waveId: 'wave-next',
        attempt: 1,
        integrationId: 'integration-next',
      },
      planHash: 'a'.repeat(64),
      actionId: 'register-next-validation',
      validationWorkspaceId: 'validation-next',
      call: {
        projectId: before.projectId,
        taskId: before.taskId,
        integrationId: 'integration-next',
        workspaceId: 'integration-next',
        claimId: 'claim-next',
        writerEpoch: 2,
        grantRevision: 1,
      },
      version: {
        kind: 'git',
        commit: nextCommit,
        manifestId: `manifest:${'b'.repeat(64)}`,
        manifestHash: 'b'.repeat(64),
      },
      plan: next,
      current: next.after,
      registry: {
        revision: 20,
        roots: [{ rootId: 'root', projectId: before.projectId }],
        grants: [
          { grantId: 'grant', rootId: 'root', projectId: before.projectId, status: 'active' },
        ],
        workspaces: [
          {
            workspaceId: 'integration-next',
            projectId: before.projectId,
            taskId: before.taskId,
            rootId: 'root',
            grantId: 'grant',
            purpose: 'integration',
            mode: 'linked-worktree',
          },
        ],
        claims: [{ claimId: 'claim-next', workspaceId: 'integration-next', status: 'released' }],
      },
    },
    context,
    roster,
  );
  expect(registration.sourceWorkspaceId).toBe('integration-next');
  expect(registration.version).toMatchObject({ kind: 'git', commit: nextCommit });
});

function completed() {
  let state = structuredClone(fixture());
  for (const commit of ['c'.repeat(40), 'd'.repeat(40)]) {
    const integration = state.integration;
    if (!integration) throw Error('missing fixture integration');
    state = applyMutations(
      state,
      planIntegrationAcknowledgement(
        state,
        {
          projectId: state.projectId,
          taskId: state.taskId,
          integration,
          selection: selectIntegrationBranch(state, integration.integrationId),
        },
        { previousCommit: integration.integrationWorktree.headCommit as string, commit },
      ),
    );
  }
  return applyMutations(state, planIntegrationCompletion(state, state));
}

it('preserves the actual Coordinator decision including its progress message and frozen input', () => {
  const before = completed();
  before.testResults = { passed: true, total: 1, failed: 0, failures: [] };
  const copy = structuredClone(before);
  const plan = createInitialValidationDispatchPlan(before, seed, context, roster);
  const ids = [seed.dispatchId, seed.ledgerId],
    times = [seed.dispatchTs, seed.ledgerTs];
  const expected = decide(before, {
    parallel: context,
    roster,
    newId: () => ids.shift() as string,
    now: () => times.shift() as number,
  });
  expect(plan.decision).toEqual(expected);
  expect(plan.after.messages.slice(-2).map((message) => message.msgId)).toEqual([
    seed.dispatchId,
    seed.ledgerId,
  ]);
  expect(ids).toEqual([]);
  expect(times).toEqual([]);
  expect(plan.after.testResults).toBeUndefined();
  expect(plan.after.messages.at(-1)?.payload.kind).toBe('coordination_ledger');
  expect(plan.after.parallelExecution?.activeWave?.validation?.inputCommit).toBe('d'.repeat(40));
  expect(plan.after.workers.at(-1)).toMatchObject({ role: 'TESTER', status: 'pending' });
  expect(plan.after.workers.at(-1)?.subtaskId).toBeUndefined();
  expect(plan.after.workers.at(-1)?.worktree).toBeUndefined();
  expect(plan.after.integration).toEqual(before.integration);
  expect(plan.after.subtasks).toEqual(before.subtasks);
  expect(plan.after.localExecution).toEqual(before.localExecution);
  expect(before).toEqual(copy);
  expect(initialValidationDispatchChanges(before, plan, context, roster)).toEqual(
    expected.mutations,
  );
  expect(
    initialValidationDispatchChanges(
      JSON.parse(JSON.stringify(plan.after)),
      JSON.parse(JSON.stringify(plan)),
      context,
      roster,
    ),
  ).toEqual([]);
});

it('stores the canonical dispatch plan as strict JSON and reconstructs its clear-result mutation', () => {
  const before = completed();
  const plan = createInitialValidationDispatchPlan(before, seed, context, roster);
  const stored = JSON.parse(JSON.stringify(plan)) as typeof plan;
  expect(() => localRecordHash(stored)).not.toThrow();
  expect(initialValidationDispatchChanges(before, stored, context, roster)).toEqual(
    plan.decision.mutations,
  );
  expect(initialValidationDispatchChanges(stored.after, stored, context, roster)).toEqual([]);
});

it.each(['missing-ledger', 'extra-mutation', 'mutated-route', 'wrong-after', 'reused-id'] as const)(
  'rejects a noncanonical persisted plan: %s',
  (kind) => {
    const before = completed(),
      plan = createInitialValidationDispatchPlan(before, seed, context, roster);
    if (kind === 'missing-ledger') plan.decision.mutations.pop();
    if (kind === 'extra-mutation') plan.decision.mutations.push(setMutation('iterationCount', 7));
    if (kind === 'mutated-route') plan.decision.route = { kind: 'integrate' };
    if (kind === 'wrong-after') plan.after.iterationCount++;
    if (kind === 'reused-id') plan.seed.ledgerId = seed.dispatchId;
    expect(() => initialValidationDispatchChanges(before, plan, context, roster)).toThrow();
  },
);

it.each(['message', 'worker', 'integration', 'phase', 'counter'] as const)(
  'does not admit an unrelated later State: %s',
  (kind) => {
    const before = completed(),
      plan = createInitialValidationDispatchPlan(before, seed, context, roster);
    const current = structuredClone(plan.after);
    if (kind === 'message') current.messages.pop();
    if (kind === 'worker') required(current.workers.at(-1)).status = 'running';
    if (kind === 'integration' && current.integration)
      current.integration.resultCommit = 'e'.repeat(40);
    if (kind === 'phase') current.phase = 'review';
    if (kind === 'counter') current.iterationCount++;
    expect(() => initialValidationDispatchChanges(current, plan, context, roster)).toThrow();
  },
);

it('rechecks current control context and roster even for exact replay', () => {
  const before = completed(),
    plan = createInitialValidationDispatchPlan(before, seed, context, roster);
  expect(() =>
    initialValidationDispatchChanges(
      plan.after,
      plan,
      { ...context, controlFingerprint: 'e'.repeat(64) },
      roster,
    ),
  ).toThrow();
  expect(() => initialValidationDispatchChanges(plan.after, plan, context, [])).toThrow();
});

it('preserves the existing blocking-objection gate instead of routing around it', () => {
  const before = completed();
  before.requirements.push({
    id: 'req',
    story: 'Durability',
    acceptance: ['Persist'],
    nonGoals: [],
  });
  before.objections.push({
    id: 'objection',
    threadId: 'objection',
    fromRole: 'PM',
    target: { kind: 'requirement', id: 'req' },
    claim: 'contradiction',
    argument: 'The requirement is unresolved.',
    track: 'blocking',
    ts: 3,
  });
  const original = structuredClone(before);
  expect(decide(before, { parallel: context, roster }).route.kind).toBe('human_gate');
  expect(() => createInitialValidationDispatchPlan(before, seed, context, roster)).toThrow();
  expect(before).toEqual(original);
});

it('refuses a persisted unresolved human gate before planning a validation worker', () => {
  const before = completed();
  before.humanGate = {
    gateId: 'gate',
    reason: 'Leader decision required',
    options: ['continue'],
    phase: 'integrating',
    openedTs: 3,
    safePointRefs: ['safe-point'],
  };
  expect(() => createInitialValidationDispatchPlan(before, seed, context, roster)).toThrow();
});

it.each(['phase', 'head', 'validation', 'busy', 'message-id', 'worker-id', 'base'] as const)(
  'refuses an invalid first dispatch source: %s',
  (kind) => {
    const before = completed();
    if (kind === 'phase') before.phase = 'testing';
    if (kind === 'head' && before.integration) before.integration.resultCommit = 'e'.repeat(40);
    if (kind === 'validation' && before.parallelExecution?.activeWave)
      before.parallelExecution.activeWave.validation = {
        dispatchId: 'old',
        workerId: 'old',
        integrationId: 'integration',
        inputCommit: 'd'.repeat(40),
      };
    if (kind === 'busy') required(before.workers[0]).status = 'running';
    if (kind === 'message-id') required(before.messages[0]).msgId = seed.ledgerId;
    if (kind === 'worker-id') required(before.workers[0]).workerId = `worker:${seed.dispatchId}:0`;
    if (kind === 'base' && before.parallelExecution)
      before.parallelExecution.initialBase.branch = 'foreign';
    expect(() => createInitialValidationDispatchPlan(before, seed, context, roster)).toThrow();
  },
);

it.each(['same-id', 'bad-id', 'negative-time', 'backwards-time', 'nan-time', 'extra-key'] as const)(
  'rejects ambiguous or malformed persisted identity: %s',
  (kind) => {
    const before = completed();
    expect(createInitialValidationDispatchPlan(before, seed, context, roster).after.phase).toBe(
      'testing',
    );
    const identity = { ...seed };
    if (kind === 'same-id') identity.ledgerId = identity.dispatchId;
    if (kind === 'bad-id') identity.dispatchId = 'bad/id';
    if (kind === 'negative-time') identity.dispatchTs = -1;
    if (kind === 'backwards-time') identity.ledgerTs = identity.dispatchTs - 1;
    if (kind === 'nan-time') identity.dispatchTs = Number.NaN;
    if (kind === 'extra-key') Object.assign(identity, { sourceReceiptId: 'old' });
    expect(() => createInitialValidationDispatchPlan(before, identity, context, roster)).toThrow();
  },
);

it('keeps a fresh dispatch source valid after all rejection cases', () => {
  expect(createInitialValidationDispatchPlan(completed(), seed, context, roster).after.phase).toBe(
    'testing',
  );
});

function preparation() {
  const before = completed();
  const plan = createInitialValidationDispatchPlan(before, seed, context, roster);
  return {
    current: structuredClone(before),
    before,
    plan,
    identity: {
      scope: {
        projectId: before.projectId,
        taskId: before.taskId,
        waveId: required(before.parallelExecution?.activeWave).waveId,
        attempt: required(before.parallelExecution?.activeWave).attempt,
        integrationId: required(before.integration).integrationId,
      },
      dispatchId: seed.dispatchId,
      workerId: `worker:${seed.dispatchId}:0`,
    },
  };
}

it('verifies a preparation binding through the actual Coordinator in both exact stages', async () => {
  const input = preparation();
  const original = structuredClone(input);
  let calls = 0;
  const verifier = createValidationDispatchVerifier(async (scope) => {
    expect(scope).toEqual(input.identity.scope);
    calls++;
    return { context, roster };
  });
  expect(await verifier.verify(input)).toBe('released');
  expect(await verifier.verify({ ...input, current: input.plan.after })).toBe('dispatched');
  expect(calls).toBe(2);
  expect(input).toEqual(original);
});

it.each([
  'projectId',
  'taskId',
  'waveId',
  'attempt',
  'integrationId',
  'dispatchId',
  'workerId',
] as const)('rejects a preparation bound to another %s', async (field) => {
  const input = preparation();
  if (field === 'attempt') input.identity.scope.attempt++;
  else if (field === 'dispatchId' || field === 'workerId') input.identity[field] += '-foreign';
  else input.identity.scope[field] += '-foreign';
  const verifier = createValidationDispatchVerifier(async () => ({ context, roster }));
  await expect(verifier.verify(input)).rejects.toThrow('initial_validation_preparation_mismatch');
});

it('rejects an alternate original State even when it can produce a valid dispatch', async () => {
  const input = preparation();
  input.before.iterationCount++;
  const verifier = createValidationDispatchVerifier(async () => ({ context, roster }));
  await expect(verifier.verify(input)).rejects.toThrow();
});

it('reloads current control and roster on every verification without caching approval', async () => {
  const input = preparation();
  let current = { context, roster };
  const verifier = createValidationDispatchVerifier(async () => current);
  expect(await verifier.verify(input)).toBe('released');
  current = { context, roster: [] };
  await expect(verifier.verify(input)).rejects.toThrow();
  current = { context: { ...context, controlFingerprint: '0'.repeat(64) }, roster };
  await expect(verifier.verify(input)).rejects.toThrow();
});

it.each(['missing-ledger', 'partial-after', 'running', 'paused', 'done', 'extra-binding'] as const)(
  'does not admit preparation drift: %s',
  async (kind) => {
    const input = preparation();
    input.current = structuredClone(input.plan.after);
    if (kind === 'missing-ledger') input.plan.decision.mutations.pop();
    else if (kind === 'partial-after') input.current.messages.pop();
    else if (kind === 'extra-binding') Object.assign(input.identity, { allowHistorical: true });
    else required(input.current.workers.at(-1)).status = kind;
    const verifier = createValidationDispatchVerifier(async () => ({ context, roster }));
    await expect(verifier.verify(input)).rejects.toThrow();
  },
);

it('owns its input across the asynchronous current-control read', async () => {
  const input = preparation();
  const verifier = createValidationDispatchVerifier(async (scope) => {
    input.current.iterationCount++;
    input.plan.decision.mutations.pop();
    scope.taskId = 'changed-by-reader';
    return { context, roster };
  });
  expect(await verifier.verify(input)).toBe('released');
});

function durableDispatchFixture() {
  const input = preparation();
  const reference = { scope: input.identity.scope, planHash: 'a'.repeat(64) };
  const storedPlan = JSON.parse(JSON.stringify(input.plan)) as typeof input.plan;
  let current = structuredClone(input.before);
  let reads = 0;
  let fixedReads = 0;
  let commits = 0;
  let loseResponse = false;
  const verifier = createValidationDispatchVerifier(async () => ({ context, roster }));
  const fixed = async () => {
    const stage = await verifier.verify({
      identity: input.identity,
      before: input.before,
      current,
      plan: storedPlan,
    });
    return structuredClone({
      stage,
      before: input.before,
      plan: storedPlan,
      planHash: reference.planHash,
      call: {
        projectId: input.before.projectId,
        taskId: input.before.taskId,
        integrationId: input.identity.scope.integrationId,
        claimId: 'claim',
        workspaceId: 'integration-workspace',
        writerEpoch: 1,
        grantRevision: 1,
      },
      version: {
        kind: 'git' as const,
        commit: 'd'.repeat(40),
        manifestId: 'manifest',
        manifestHash: 'a'.repeat(64),
      },
    });
  };
  const source = {
    async readFixedForCommit() {
      fixedReads++;
      return fixed();
    },
    async readForCommit() {
      reads++;
      return fixed();
    },
  };
  const state = {
    async compareAndCommit(
      _scope: unknown,
      expected: typeof current,
      changes: ReturnType<typeof initialValidationDispatchChanges>,
    ) {
      commits++;
      expect(current).toEqual(expected);
      expect(changes).toEqual(input.plan.decision.mutations);
      current = applyMutations(current, changes);
      if (loseResponse) {
        loseResponse = false;
        throw Error('response_lost_after_commit');
      }
      return { state: structuredClone(current), changed: true };
    },
  };
  return {
    input,
    reference,
    source,
    state,
    get current() {
      return current;
    },
    get reads() {
      return reads;
    },
    get fixedReads() {
      return fixedReads;
    },
    get commits() {
      return commits;
    },
    loseNextResponse() {
      loseResponse = true;
    },
    changeCurrent(value: typeof current) {
      current = value;
    },
    changePlan(value: typeof storedPlan) {
      Object.assign(storedPlan, value);
    },
  };
}

it('commits only L2-rebuilt dispatch mutations under the fixed original State and rechecks source', async () => {
  const f = durableDispatchFixture();
  const options = {
    source: f.source,
    state: f.state,
    readControl: async () => ({ context, roster }),
  };
  const result = await commitInitialValidationDispatch(f.reference, options);
  expect(result.stage).toBe('dispatched');
  expect(f.current).toEqual(f.input.plan.after);
  expect(f.commits).toBe(1);
  expect(f.fixedReads).toBe(1);
  expect(f.reads).toBe(2);
  expect(await commitInitialValidationDispatch(f.reference, options)).toEqual(result);
  expect(f.commits).toBe(1);
  expect(f.fixedReads).toBe(2);
  expect(f.reads).toBe(3);
});

it('requires the physical source proof before the first State commit', async () => {
  const f = durableDispatchFixture();
  f.source.readForCommit = async () => {
    throw Error('native_source_missing');
  };
  await expect(
    commitInitialValidationDispatch(f.reference, {
      source: f.source,
      state: f.state,
      readControl: async () => ({ context, roster }),
    }),
  ).rejects.toThrow('native_source_missing');
  expect(f.fixedReads).toBe(1);
  expect(f.commits).toBe(0);
});

it('recovers a lost CAS response only from the exact persisted post-dispatch State', async () => {
  const f = durableDispatchFixture();
  const options = {
    source: f.source,
    state: f.state,
    readControl: async () => ({ context, roster }),
  };
  f.loseNextResponse();
  await expect(commitInitialValidationDispatch(f.reference, options)).rejects.toThrow(
    'response_lost_after_commit',
  );
  expect(f.commits).toBe(1);
  expect((await commitInitialValidationDispatch(f.reference, options)).stage).toBe('dispatched');
  expect(f.commits).toBe(1);
  const drift = structuredClone(f.current);
  drift.iterationCount++;
  f.changeCurrent(drift);
  await expect(commitInitialValidationDispatch(f.reference, options)).rejects.toThrow();
  expect(f.commits).toBe(1);
});

it('rejects a noncanonical stored plan before any State mutation', async () => {
  const f = durableDispatchFixture();
  const plan = structuredClone(f.input.plan);
  plan.decision.mutations.pop();
  f.changePlan(plan);
  await expect(
    commitInitialValidationDispatch(f.reference, {
      source: f.source,
      state: f.state,
      readControl: async () => ({ context, roster }),
    }),
  ).rejects.toThrow();
  expect(f.commits).toBe(0);
});

it('reuses one original handoff plan after publication and CAS response loss', async () => {
  const f = durableDispatchFixture();
  const call = {
    projectId: f.input.before.projectId,
    taskId: f.input.before.taskId,
    integrationId: required(f.input.before.integration).integrationId,
    claimId: 'claim',
    workspaceId: 'integration-workspace',
    writerEpoch: 1,
    grantRevision: 1,
  };
  const input = {
    scope: f.reference.scope,
    call,
    actionId: 'prepare-first-validation',
    validationWorkspaceId: 'validation-first',
    seed,
  };
  const events: string[] = [];
  let saved:
    | { planHash: string; actionId: string; validationWorkspaceId: string; call: typeof call }
    | undefined;
  let losePublication = true;
  const publication = {
    async load() {
      events.push('load');
      return saved;
    },
    async readHandoff() {
      events.push('handoff');
      return {
        state: structuredClone(f.input.before),
        version: {
          kind: 'git' as const,
          commit: 'd'.repeat(40),
          manifestId: 'manifest',
          manifestHash: 'a'.repeat(64),
        },
        registry: {},
        handoffPlanHash: 'b'.repeat(64),
        handoffConfirmedHash: 'c'.repeat(64),
      };
    },
    async publish() {
      events.push('publish');
      saved = {
        planHash: f.reference.planHash,
        actionId: input.actionId,
        validationWorkspaceId: input.validationWorkspaceId,
        call,
      };
      if (losePublication) {
        losePublication = false;
        throw Error('response_lost_after_publication');
      }
      return { planHash: f.reference.planHash };
    },
  };
  const options = {
    publication,
    source: f.source,
    state: f.state,
    readControl: async () => ({ context, roster }),
  };
  await expect(publishAndCommitInitialValidationDispatch(input, options)).rejects.toThrow(
    'response_lost_after_publication',
  );
  expect(events).toEqual(['load', 'handoff', 'publish']);
  expect(f.commits).toBe(0);
  expect(f.reads).toBe(0);
  f.loseNextResponse();
  await expect(publishAndCommitInitialValidationDispatch(input, options)).rejects.toThrow(
    'response_lost_after_commit',
  );
  expect(events).toEqual(['load', 'handoff', 'publish', 'load']);
  expect(f.commits).toBe(1);
  expect(f.fixedReads).toBe(1);
  expect(f.reads).toBe(1);
  expect(await publishAndCommitInitialValidationDispatch(input, options)).toEqual({
    stage: 'dispatched',
    planHash: f.reference.planHash,
  });
  expect(events).toEqual(['load', 'handoff', 'publish', 'load', 'load']);
  expect(f.commits).toBe(1);
  expect(f.fixedReads).toBe(2);
  expect(f.reads).toBe(2);
  await expect(
    publishAndCommitInitialValidationDispatch({ ...input, actionId: 'competing' }, options),
  ).rejects.toThrow();
  expect(f.commits).toBe(1);
});
