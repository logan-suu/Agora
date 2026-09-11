import {
  type AppState,
  createInitialAppState,
  type RoleSpec,
  type WaveValidationReceipt,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { projectForAssignment } from '../src/project';

const coder: RoleSpec = {
  role: 'CODER',
  executor: 'harness',
  systemPrompt: '',
  tools: [],
  projection: ['assignedSubtask', 'architecture', 'coordinationContext', 'failingTests'],
  routeWhen: '',
};
function state(): AppState {
  const initial = createInitialAppState('t', 'g');
  return {
    ...initial,
    phase: 'coding',
    parallelExecution: {
      version: 1,
      planId: 'plan',
      initialBase: { branch: 'base', commit: 'a'.repeat(40) },
      activeWave: {
        waveId: 'wave',
        attempt: 1,
        base: { branch: 'base', commit: 'a'.repeat(40) },
        subtaskIds: ['A', 'B'],
        coderWorkerIds: ['worker:wave:0', 'worker:wave:1'],
      },
    },
    subtasks: ['A', 'B'].map((id) => ({
      id,
      title: `Implement ${id}`,
      dependsOn: [],
      ownerRole: 'CODER',
      status: 'in_progress',
    })),
    workers: ['A', 'B'].map((subtaskId, index) => ({
      workerId: `worker:wave:${index}`,
      role: 'CODER',
      subtaskId,
      status: 'running',
      executor: 'harness',
      startedTs: 1,
    })),
  };
}

// Canonical control and receipt facts isolate assignment slicing from model execution.
function failedReceipt(current: AppState): string {
  const dispatchId = 'validation-old';
  const receipt: WaveValidationReceipt = {
    kind: 'wave_validation',
    version: 1,
    planId: 'plan',
    waveId: 'wave',
    attempt: 1,
    dispatchId,
    workerId: `worker:${dispatchId}:0`,
    integrationId: 'integration-old',
    inputCommit: 'b'.repeat(40),
    worktree: {
      path: '/data/validation-old',
      branch: 'validation-old',
      baseCommit: 'b'.repeat(40),
      headCommit: 'c'.repeat(40),
    },
    subtaskIds: ['A', 'B'],
    controlFingerprint: 'f'.repeat(64),
    results: {
      passed: false,
      total: 2,
      failed: 1,
      failures: [{ test: 'A acceptance', message: 'incorrect A', file: 'a.test.mjs', line: 1 }],
    },
    evidence: {
      path: `validation/${dispatchId}.json`,
      sha256: 'e'.repeat(64),
      exitCode: 1,
      timedOut: false,
    },
  };
  current.workers.push({
    workerId: receipt.workerId,
    role: 'TESTER',
    executor: 'harness',
    status: 'done',
    startedTs: 1,
    worktree: receipt.worktree,
  });
  current.messages.push(
    {
      msgId: dispatchId,
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Validate previous wave',
      ts: 1,
      payload: { ...receipt, kind: 'wave_validation_dispatch' },
    },
    {
      msgId: `wave-validation:${dispatchId}`,
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Previous wave failed',
      ts: 2,
      payload: { ...receipt },
    },
  );
  return `wave-validation:${dispatchId}`;
}

function repairing(): AppState {
  const current = state();
  const failedReceiptId = failedReceipt(current);
  const wave = current.parallelExecution?.activeWave;
  if (wave === undefined) throw new Error('expected wave');
  wave.attempt = 2;
  wave.base = { branch: 'validation-old', commit: 'c'.repeat(40) };
  current.messages.push({
    msgId: 'retry',
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    display: 'Repair failed wave',
    ts: 3,
    payload: {
      kind: 'coding_retry',
      waveId: wave.waveId,
      attempt: wave.attempt,
      workerIds: [...wave.coderWorkerIds],
      failedReceiptId,
    },
  });
  return current;
}

function feedback(current: AppState, subtaskId = 'A') {
  const worker = current.workers.find(
    (candidate) =>
      candidate.subtaskId === subtaskId &&
      current.parallelExecution?.activeWave?.coderWorkerIds.includes(candidate.workerId),
  );
  if (worker === undefined) throw new Error('missing assigned worker');
  return projectForAssignment(current, { workerId: worker.workerId, role: 'CODER', subtaskId }, [
    coder,
  ]).slices.failingTests;
}

describe('assignment projection', () => {
  it('retains bound repair feedback across reproject and D4 worker resume', () => {
    const current = repairing();
    expect(feedback(current)).toMatchObject({ passed: false, failed: 1 });
    const resumed = structuredClone(current);
    const worker = resumed.workers[0];
    if (worker === undefined) throw new Error('missing worker');
    worker.status = 'paused';
    worker.sessionId = 'fork:resumed';
    expect(feedback(resumed)).toEqual(feedback(current));
  });

  it('does not give the next C wave an already repaired A/B failure', () => {
    const current = repairing();
    const wave = current.parallelExecution?.activeWave;
    if (wave === undefined) throw new Error('expected wave');
    wave.waveId = 'next-wave';
    wave.attempt = 1;
    wave.subtaskIds = ['C'];
    wave.coderWorkerIds = ['worker:next-wave:0'];
    current.subtasks.forEach((node) => {
      node.status = 'done';
    });
    current.subtasks.push({
      id: 'C',
      title: 'Compose',
      dependsOn: ['A', 'B'],
      ownerRole: 'CODER',
      status: 'in_progress',
    });
    current.workers.push({
      workerId: 'worker:next-wave:0',
      role: 'CODER',
      subtaskId: 'C',
      executor: 'harness',
      status: 'running',
      startedTs: 4,
    });
    current.testResults = { passed: true, total: 3, failed: 0, failures: [] };
    expect(feedback(current, 'C')).toMatchObject({ failed: 0, failures: [] });
  });

  it('rejects unrelated worker and attempt feedback even inside the same wave', () => {
    for (const override of [{ attempt: 1 }, { workerIds: ['other-worker'] }]) {
      const current = repairing();
      const retry = current.messages.at(-1);
      if (retry === undefined) throw new Error('missing retry');
      Object.assign(retry.payload, override);
      expect(feedback(current)).toMatchObject({ failed: 0, failures: [] });
    }
  });

  it('follows explicit review rework scope without affecting unrelated assignments', () => {
    const current = state();
    const failedReceiptId = failedReceipt(current);
    current.messages.push({
      msgId: 'rework',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Rework A and successors',
      ts: 3,
      payload: { kind: 'review_rework', subtaskIds: ['A', 'C'], failedReceiptId },
    });
    current.messages.push({
      msgId: 'wave',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Repair A',
      ts: 4,
      payload: { kind: 'coding_wave', reworkSourceMsgId: 'rework' },
    });
    expect(feedback(current)).toMatchObject({ passed: false, failed: 1 });
    expect(feedback(current, 'B')).toMatchObject({ failed: 0, failures: [] });
  });

  it('projects retained contributions to TESTER while CODER keeps its narrow repair scope', () => {
    const current = state();
    current.messages.push({
      msgId: 'plan',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Adopt plan',
      ts: 0,
      payload: {
        kind: 'execution_plan',
        plan: {
          version: 1,
          subtasks: current.subtasks.map(({ id, title, dependsOn }) => ({ id, title, dependsOn })),
        },
      },
    });
    const failedReceiptId = failedReceipt(current);
    current.messages.push({
      msgId: 'rework',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Repair A, retain B',
      ts: 3,
      payload: { kind: 'review_rework', subtaskIds: ['A'], failedReceiptId },
    });
    current.messages.push({
      msgId: 'repair-wave',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Repair A',
      ts: 4,
      payload: {
        kind: 'coding_wave',
        planId: 'plan',
        reworkSourceMsgId: 'rework',
        nextRole: 'CODER',
        attempt: 1,
        base: { branch: 'validation-old', commit: 'c'.repeat(40) },
        subtaskIds: ['A'],
        workerIds: ['worker:repair-wave:0'],
      },
    });
    const wave = current.parallelExecution?.activeWave;
    if (wave === undefined) throw new Error('expected wave');
    wave.waveId = 'repair-wave';
    wave.base = { branch: 'validation-old', commit: 'c'.repeat(40) };
    wave.subtaskIds = ['A'];
    wave.coderWorkerIds = ['worker:repair-wave:0'];
    for (const worker of current.workers) worker.status = 'done';
    current.workers.push({
      workerId: 'worker:repair-wave:0',
      role: 'CODER',
      subtaskId: 'A',
      executor: 'harness',
      status: 'running',
      startedTs: 4,
    });
    const coderView = projectForAssignment(
      current,
      { workerId: 'worker:repair-wave:0', role: 'CODER', subtaskId: 'A' },
      [coder],
    );
    expect(coderView.slices.assignment).toMatchObject({ subtaskIds: ['A'], finalWave: false });
    current.phase = 'testing';
    wave.validation = {
      dispatchId: 'validation-new',
      workerId: 'worker:validation-new:0',
      integrationId: 'integration-new',
      inputCommit: 'd'.repeat(40),
    };
    current.workers.push({
      workerId: 'worker:validation-new:0',
      role: 'TESTER',
      executor: 'harness',
      status: 'running',
      startedTs: 5,
    });
    const tester = { ...coder, role: 'TESTER', projection: ['branchOrIntegration'] };
    const testerView = projectForAssignment(
      current,
      { workerId: 'worker:validation-new:0', role: 'TESTER' },
      [tester],
    );
    expect(testerView.slices.assignment).toMatchObject({ subtaskIds: ['A', 'B'], finalWave: true });
  });

  it('fails closed when an explicit review repair source is missing', () => {
    const current = state();
    current.messages.push({
      msgId: 'wave',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: 'Invalid rework',
      ts: 4,
      payload: { kind: 'coding_wave', reworkSourceMsgId: 'missing' },
    });
    expect(() => feedback(current)).toThrow(/canonical source/);
  });

  it('gives two same-role workers only their own active instructions and subtask', () => {
    const current = state();
    const a = projectForAssignment(
      current,
      { workerId: 'worker:wave:0', role: 'CODER', subtaskId: 'A' },
      [coder],
    );
    const b = projectForAssignment(
      current,
      { workerId: 'worker:wave:1', role: 'CODER', subtaskId: 'B' },
      [coder],
    );
    expect(a.slices.assignedSubtask).toEqual([expect.objectContaining({ id: 'A' })]);
    expect(b.slices.assignedSubtask).toEqual([expect.objectContaining({ id: 'B' })]);
    expect(a.slices.coordinationContext).toEqual(
      expect.objectContaining({ instructionOrQuestion: 'Implement A' }),
    );
    expect(JSON.stringify(a.slices.assignedSubtask)).not.toContain('Implement B');
    expect(() =>
      projectForAssignment(current, { workerId: 'worker:wave:0', role: 'CODER', subtaskId: 'B' }, [
        coder,
      ]),
    ).toThrow(/assignment/);
    const wave = current.parallelExecution?.activeWave;
    if (wave === undefined) throw new Error('expected active wave');
    wave.coderWorkerIds[0] = 'worker:new:0';
    expect(() =>
      projectForAssignment(current, { workerId: 'worker:wave:0', role: 'CODER', subtaskId: 'A' }, [
        coder,
      ]),
    ).toThrow(/current wave/);
  });
});

it('projects an explicit verdict continuation instruction from the canonical review dispatch without raw objection text', () => {
  const reviewer = { ...coder, role: 'REVIEWER' };
  const current = state();
  current.phase = 'review';
  const receiptId = failedReceipt(current);
  current.messages.push({
    msgId: 'plan',
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    display: 'Plan',
    ts: 1,
    payload: {
      kind: 'execution_plan',
      plan: {
        version: 1,
        subtasks: [
          { id: 'A', title: 'A', dependsOn: [] },
          { id: 'B', title: 'B', dependsOn: [] },
        ],
      },
    },
  });
  current.messages.push({
    msgId: 'review-next',
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    payload: {
      nextRole: 'REVIEWER',
      workerIds: ['reviewer-next'],
      advisorySourceMsgId: 'advisory',
      reviewBinding: {
        planId: 'plan',
        validationReceiptId: receiptId,
        commit: 'c'.repeat(40),
        controlFingerprint: 'f'.repeat(64),
      },
    },
    display: 'RAW_DISPLAY',
    ts: 2,
  });
  current.objections = [
    {
      id: 'advisory',
      threadId: 'advisory',
      fromRole: 'REVIEWER',
      claim: 'concern',
      track: 'advisory',
      argument: 'RAW_ARGUMENT',
      ts: 1,
    },
  ];
  current.workers.push({
    workerId: 'reviewer-next',
    role: 'REVIEWER',
    executor: 'harness',
    status: 'pending',
    startedTs: 2,
  });
  const view = projectForAssignment(current, { workerId: 'reviewer-next', role: 'REVIEWER' }, [
    reviewer,
  ]);
  expect(view.slices.coordinationContext).toMatchObject({
    instructionOrQuestion:
      'The advisory has been recorded. Continue the bound review and provide its required verdict.',
  });
  expect(JSON.stringify(view)).not.toContain('RAW_');
  current.objections = [];
  expect(() =>
    projectForAssignment(current, { workerId: 'reviewer-next', role: 'REVIEWER' }, [reviewer]),
  ).toThrow(/advisory/);
});
