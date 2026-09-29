// Pure control fixtures; physical baseline evidence is checked by the runtime.
import { expect, it } from 'vitest';
import { readCodingWorkerLineage } from '../src/coding-worker-lineage';
import { createInitialAppState, type Message } from '../src/state';

const base = { branch: 'initial', commit: 'a'.repeat(40) };
const message = (msgId: string, payload: Message['payload']): Message => ({
  msgId,
  payload,
  channelId: 'main',
  fromRole: 'COORDINATOR',
  type: 'announce',
  ts: 1,
  display: 'Control fixture',
});
function fixture() {
  const state = createInitialAppState('task', 'Code', 'project');
  const ids = ['A', 'B'];
  state.subtasks = ids.map((id) => ({
    id,
    title: id,
    ownerRole: 'CODER',
    status: 'in_progress',
    dependsOn: [],
  }));
  const workerIds = ids.map((_, i) => `worker:wave:${i}`);
  state.workers = workerIds.map((workerId, i) => ({
    workerId,
    role: 'CODER',
    executor: 'harness',
    status: 'pending',
    subtaskId: ids[i] as string,
    startedTs: 1,
  }));
  state.messages = [
    message('plan', {
      kind: 'execution_plan',
      plan: {
        version: 1,
        subtasks: ids.map((id) => ({ id, title: id, dependsOn: [] })),
      },
    }),
    message('wave', {
      kind: 'coding_wave',
      planId: 'plan',
      nextRole: 'CODER',
      attempt: 1,
      base,
      subtaskIds: ids,
      workerIds,
    }),
  ];
  const wave = { waveId: 'wave', attempt: 1, base, subtaskIds: ids, coderWorkerIds: workerIds };
  state.parallelExecution = { version: 1, planId: 'plan', initialBase: base, activeWave: wave };
  return { state, wave };
}
function retry(f: ReturnType<typeof fixture>, name = 'retry', indexes = [0]) {
  const oldIds = indexes.map((i) => f.wave.coderWorkerIds[i]);
  const newIds = indexes.map((_, i) => `worker:${name}:${i}`);
  for (const index of indexes.keys()) {
    const old = f.state.workers.find((w) => w.workerId === oldIds[index]);
    if (!old) throw Error('missing fixture worker');
    old.status = 'failed';
    f.state.workers.push({ ...old, status: 'pending', workerId: newIds[index] as string });
  }
  const dispatch = message(name, {
    kind: 'coding_retry',
    nextRole: 'CODER',
    waveId: 'wave',
    attempt: 1,
    base,
    failedWorkerIds: oldIds,
    workerIds: newIds,
  });
  f.state.messages.push(dispatch);
  f.wave.coderWorkerIds = f.wave.coderWorkerIds.map((id) => newIds[oldIds.indexOf(id)] ?? id);
  return dispatch;
}

function acceptedWave() {
  const f = fixture();
  const acceptedBase = { branch: 'validation', commit: 'b'.repeat(40) };
  const first = f.state.subtasks[0];
  if (!first) throw Error('missing first subtask');
  first.status = 'done';
  f.state.workers = [
    {
      workerId: 'worker:previous-dispatch:0',
      role: 'TESTER',
      executor: 'harness',
      status: 'done',
      startedTs: 1,
    },
    {
      workerId: 'worker:wave:0',
      role: 'CODER',
      executor: 'harness',
      status: 'pending',
      subtaskId: 'B',
      startedTs: 2,
    },
  ];
  f.state.messages.splice(
    1,
    0,
    message('previous-dispatch', {
      kind: 'wave_validation_dispatch',
      planId: 'plan',
      waveId: 'previous-wave',
      attempt: 1,
      integrationId: 'previous-integration',
      inputCommit: base.commit,
      subtaskIds: ['A'],
    }),
    message('wave-validation:previous-dispatch', {
      kind: 'wave_validation',
      version: 1,
      planId: 'plan',
      waveId: 'previous-wave',
      attempt: 1,
      dispatchId: 'previous-dispatch',
      workerId: 'worker:previous-dispatch:0',
      integrationId: 'previous-integration',
      inputCommit: base.commit,
      worktree: {
        path: '/owned/validation',
        branch: acceptedBase.branch,
        baseCommit: base.commit,
        headCommit: acceptedBase.commit,
      },
      subtaskIds: ['A'],
      controlFingerprint: 'c'.repeat(64),
      results: { passed: true, total: 1, failed: 0, failures: [] },
      evidence: {
        path: 'validation/previous-dispatch.json',
        sha256: 'd'.repeat(64),
        exitCode: 0,
        timedOut: false,
      },
    }),
  );
  const wave = f.state.messages.at(-1);
  if (wave?.payload.kind !== 'coding_wave') throw Error('missing coding wave');
  wave.payload.base = acceptedBase;
  wave.payload.subtaskIds = ['B'];
  wave.payload.workerIds = ['worker:wave:0'];
  f.state.parallelExecution = {
    version: 1,
    planId: 'plan',
    initialBase: base,
    acceptedReceiptId: 'wave-validation:previous-dispatch',
    activeWave: {
      waveId: 'wave',
      attempt: 1,
      base: acceptedBase,
      subtaskIds: ['B'],
      coderWorkerIds: ['worker:wave:0'],
    },
  };
  return f;
}

it('binds a later coding wave to the preceding accepted validation HEAD', () => {
  const f = acceptedWave();
  expect(readCodingWorkerLineage(f.state).acceptedReceiptId).toBe(
    'wave-validation:previous-dispatch',
  );
  const active = f.state.parallelExecution?.activeWave;
  if (!active) throw Error('missing active wave');
  active.base.commit = base.commit;
  const wave = f.state.messages.at(-1);
  if (wave?.payload.kind !== 'coding_wave') throw Error('missing coding wave');
  wave.payload.base = { branch: 'validation', commit: base.commit };
  expect(() => readCodingWorkerLineage(f.state)).toThrow('coding_lineage_mismatch');
});

it('does not accept a changed initial branch or an accepted branch with the same HEAD', () => {
  const first = fixture();
  const firstWave = first.state.messages.at(-1);
  if (firstWave?.payload.kind !== 'coding_wave') throw Error('missing coding wave');
  firstWave.payload.base = { branch: 'other', commit: base.commit };
  first.wave.base = { branch: 'other', commit: base.commit };
  expect(() => readCodingWorkerLineage(first.state)).toThrow('coding_lineage_mismatch');

  const later = acceptedWave();
  const laterWave = later.state.messages.at(-1);
  const active = later.state.parallelExecution?.activeWave;
  if (laterWave?.payload.kind !== 'coding_wave' || !active) throw Error('missing accepted wave');
  laterWave.payload.base = { branch: 'other', commit: 'b'.repeat(40) };
  active.base = { branch: 'other', commit: 'b'.repeat(40) };
  expect(() => readCodingWorkerLineage(later.state)).toThrow('coding_lineage_mismatch');
});

it('rejects an accepted receipt from another execution plan even at the same HEAD', () => {
  const f = acceptedWave();
  for (const message of f.state.messages) {
    if (
      message.msgId === 'previous-dispatch' ||
      message.msgId === 'wave-validation:previous-dispatch'
    )
      message.payload.planId = 'other';
  }
  expect(() => readCodingWorkerLineage(f.state)).toThrow('coding_lineage_mismatch');
});

it('rejects a future, failed, or rework receipt as an accepted next-wave base', () => {
  const future = acceptedWave();
  future.state.messages.push(...future.state.messages.splice(1, 2));
  expect(() => readCodingWorkerLineage(future.state)).toThrow('coding_lineage_mismatch');
  const failed = acceptedWave();
  const receipt = failed.state.messages[2];
  if (receipt?.payload.kind !== 'wave_validation') throw Error('missing receipt');
  receipt.payload.results = {
    passed: false,
    total: 1,
    failed: 1,
    failures: [{ test: 'A', message: 'failed', file: '', line: 0 }],
  };
  receipt.payload.evidence = {
    path: 'validation/previous-dispatch.json',
    sha256: 'd'.repeat(64),
    exitCode: 1,
    timedOut: false,
  };
  expect(() => readCodingWorkerLineage(failed.state)).toThrow();
  const rework = acceptedWave();
  const wave = rework.state.messages.at(-1);
  if (wave?.payload.kind !== 'coding_wave') throw Error('missing coding wave');
  wave.payload.reworkSourceMsgId = 'review-rework';
  expect(() => readCodingWorkerLineage(rework.state)).toThrow('coding_lineage_unsupported');
});

it('derives initial assignments and repeated partial retries without mutating state', () => {
  const f = fixture();
  expect(readCodingWorkerLineage(f.state).assignments.map((a) => a.dispatchId)).toEqual([
    'wave',
    'wave',
  ]);
  retry(f);
  retry(f, 'retry-again');
  const before = structuredClone(f.state);
  const result = readCodingWorkerLineage(f.state);
  expect(result.assignments).toEqual([
    { workerId: 'worker:retry-again:0', subtaskId: 'A', dispatchId: 'retry-again' },
    { workerId: 'worker:wave:1', subtaskId: 'B', dispatchId: 'wave' },
  ]);
  if (result.assignments[0]) result.assignments[0].workerId = 'mutated';
  expect(f.state).toEqual(before);
});

it('accepts a canonical batch replacing a failed member and an unstarted member', () => {
  const f = fixture();
  retry(f, 'retry', [0, 1]);
  const unstarted = f.state.workers.find((w) => w.workerId === 'worker:wave:1');
  if (!unstarted) throw Error('missing fixture worker');
  unstarted.status = 'pending';
  expect(readCodingWorkerLineage(f.state).assignments.map((a) => a.workerId)).toEqual(
    f.wave.coderWorkerIds,
  );
});

it.each<[string, (f: ReturnType<typeof fixture>, dispatch: Message) => void]>([
  [
    'wrong plan',
    (_f, d) => {
      d.payload.planId = 'other';
    },
  ],
  [
    'wrong channel',
    (_f, d) => {
      d.channelId = 'sub';
    },
  ],
  [
    'wrong role',
    (_f, d) => {
      d.fromRole = 'CODER';
    },
  ],
  [
    'wrong type',
    (_f, d) => {
      d.type = 'handoff';
    },
  ],
  [
    'changed base',
    (_f, d) => {
      d.payload.base = { ...base, branch: 'other' };
    },
  ],
  [
    'unsupported attempt',
    (f) => {
      f.wave.attempt = 2;
    },
  ],
  [
    'test failure retry',
    (_f, d) => {
      d.payload.reason = 'tests_failed';
    },
  ],
  [
    'invented feedback',
    (_f, d) => {
      d.payload.failedReceiptId = 'other';
    },
  ],
  [
    'duplicate message',
    (f, d) => {
      f.state.messages.push(structuredClone(d));
    },
  ],
  [
    'reordered messages',
    (f) => {
      f.state.messages.reverse();
    },
  ],
  [
    'missing predecessor',
    (_f, d) => {
      d.payload.failedWorkerIds = ['foreign'];
    },
  ],
  [
    'duplicate predecessor',
    (_f, d) => {
      d.payload.failedWorkerIds = ['worker:wave:0', 'worker:wave:0'];
    },
  ],
  [
    'missing current dispatch',
    (f) => {
      f.state.messages.pop();
    },
  ],
  [
    'forged worker identity',
    (_f, d) => {
      d.payload.workerIds = ['forged'];
    },
  ],
  [
    'changed assignment',
    (f) => {
      const w = f.state.workers.at(-1);
      if (w) w.subtaskId = 'B';
    },
  ],
  [
    'successful predecessor',
    (f) => {
      const w = f.state.workers[0];
      if (w) w.status = 'done';
    },
  ],
  [
    'active predecessor',
    (f) => {
      const w = f.state.workers[0];
      if (w) w.status = 'running';
    },
  ],
  [
    'duplicate worker',
    (f) => {
      const w = f.state.workers[0];
      if (w) f.state.workers.push({ ...w });
    },
  ],
])('rejects %s', (_name, change) => {
  const f = fixture();
  const dispatch = retry(f);
  change(f, dispatch);
  expect(() => readCodingWorkerLineage(f.state)).toThrow();
});
