// Runtime/native/official proof doubles isolate immutable join/replay behavior.
// Actual file/process/catalog/Harness closure is required by separate G5 coverage.
import { createInitialAppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { parseLocalRangeHold } from '../src/local-range-records';
import { localRangeAssignmentHash } from '../src/local-range-targets';
import { LocalRangeWorkerEvidence } from '../src/local-range-worker-evidence';
import { localRecordHash } from '../src/local-registry-records';

function fixture() {
  const scope = { projectId: 'project', taskId: 'task' };
  const state = createInitialAppState('task', 'g', 'project');
  state.workers = [
    {
      workerId: 'worker',
      role: 'PM',
      executor: 'harness',
      status: 'paused',
      sessionId: 'session',
      safePoint: 'opaque',
      startedTs: 1,
    },
  ];
  const values = new Map<string, unknown>(),
    refs = new Map<string, string>();
  const objects = {
    async get(h: string) {
      if (!values.has(h)) throw Error('missing');
      return structuredClone(values.get(h));
    },
    async put(v: unknown) {
      const h = localRecordHash(v);
      values.set(h, structuredClone(v));
      return h;
    },
    async bindReference(k: string, h: string) {
      if (refs.has(k) && refs.get(k) !== h) throw Error('conflict');
      refs.set(k, h);
    },
    async getReference(k: string) {
      return refs.get(k);
    },
  };
  const display =
    '/workspace takeover ' +
    JSON.stringify({
      ...scope,
      actionId: 'take',
      expectedRevision: 0,
      workspaceId: 'workspace',
      paths: ['file.txt'],
    });
  const sourceMessage: Message = {
    msgId: 'take',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    display,
    ts: 1,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  const plan = {
    schemaVersion: 'local-range-plan-v1',
    takeoverId: 'takeover:take',
    ...scope,
    workspaceId: 'workspace',
    rootId: 'root',
    grantId: 'grant',
    grantRevision: 0,
    expectedRevision: 0,
    sourceMessage,
    requestedPaths: ['file.txt'],
    effectiveScope: 'workspace',
    physical: {
      path: '/fixture',
      identity: '1:2',
      chain: [
        { path: '/', identity: '1:1' },
        { path: '/fixture', identity: '1:2' },
      ],
    },
    startVersion: { kind: 'files', manifestId: 'manifest', manifestHash: 'a'.repeat(64) },
    cohort: [
      {
        ...scope,
        workerId: 'worker',
        sessionId: 'session',
        assignmentHash: localRangeAssignmentHash(state, 'worker'),
      },
    ],
  };
  const hold = parseLocalRangeHold({
    plan,
    planHash: localRecordHash(plan),
    controlStage: 'prepared',
    stage: 'requested',
    evidence: [],
    returnMessage: null,
  });
  const identity = localRecordHash({ ...scope, workerId: 'worker' });
  const native = {
    schemaVersion: 'workspace-control-boundary-v1',
    ...scope,
    workerId: 'worker',
    role: 'PM',
    sessionId: 'session',
    grantId: 'grant',
    boundary: 1,
    reason: 'close',
    quiescent: true,
    fileCapabilities: false,
  };
  const nativeKey = localRecordHash({
    kind: 'control-boundary',
    identity,
    sessionId: 'session',
    boundary: 1,
  });
  const official = {
    ...scope,
    role: 'PM',
    sourceSessionId: 'session',
    cwd: '/fixture',
    boundary: 7,
    sessionHash: 'c'.repeat(64),
  };
  let closes = 0;
  const runtime = {
    async holdRangeWorkers() {
      closes++;
      return {
        ...scope,
        actionId: 'take',
        workers: [
          {
            workerId: 'worker',
            sessionId: 'session',
            status: 'paused' as const,
            safePointRef: 'opaque',
            closed: true as const,
            leaseReleased: true as const,
          },
        ],
      };
    },
  };
  const service = new LocalRangeWorkerEvidence({
    objects,
    tasks: {
      async load() {
        return structuredClone(state);
      },
    },
    runtime: () => runtime,
    native: async () => {
      await objects.bindReference(nativeKey, await objects.put(native));
      return `closure:${nativeKey}`;
    },
    official: async () => structuredClone(official),
  });
  return { service, hold, values, refs, state, official, nativeKey, closes: () => closes };
}
it('preserves close-time canonical/native/session evidence and only reads it on replay after a later session starts', async () => {
  const f = fixture();
  const proofs = await f.service.closeWorkers(f.hold, 'd'.repeat(64));
  const proof = proofs[0];
  if (!proof) throw Error('missing proof');
  const worker = f.state.workers[0];
  if (!worker) throw Error('missing worker');
  worker.sessionId = 'child';
  worker.status = 'running';
  await f.service.verify(f.hold.plan, proof);
  expect(f.closes()).toBe(1);
});
it('fails if the original native or official proof has changed, without calling runtime closure again', async () => {
  const f = fixture();
  const proof = (await f.service.closeWorkers(f.hold, 'd'.repeat(64)))[0];
  if (!proof) throw Error('missing proof');
  f.official.sessionHash = 'e'.repeat(64);
  await expect(f.service.verify(f.hold.plan, proof)).rejects.toThrow('range_worker_proof_invalid');
  f.official.sessionHash = 'c'.repeat(64);
  const nativeHash = f.refs.get(f.nativeKey);
  if (!nativeHash) throw Error('missing native');
  f.values.set(nativeHash, { ...(f.values.get(nativeHash) as object), quiescent: false });
  await expect(f.service.verify(f.hold.plan, proof)).rejects.toThrow();
  expect(f.closes()).toBe(1);
});
it('refuses proof identity swapping across sessions or cohort workers', async () => {
  const f = fixture();
  const proof = (await f.service.closeWorkers(f.hold, 'd'.repeat(64)))[0];
  if (!proof) throw Error('missing proof');
  await expect(f.service.verify(f.hold.plan, { ...proof, workerId: 'other' })).rejects.toThrow(
    'range_worker_proof_invalid',
  );
  await expect(f.service.verify(f.hold.plan, { ...proof, sessionId: 'child' })).rejects.toThrow(
    'range_worker_proof_invalid',
  );
  expect(f.closes()).toBe(1);
});

it('refuses a reassigned worker instead of declaring the old fixed cohort closed', async () => {
  const f = fixture(),
    worker = f.state.workers[0];
  if (!worker) throw Error('missing worker');
  worker.subtaskId = 'reassigned';
  await expect(f.service.closeWorkers(f.hold, 'd'.repeat(64))).rejects.toThrow(
    'range_worker_proof_invalid',
  );
});
