// Private object and proof-port doubles isolate read-only reconciliation.
// These tests never grant file access or stand in for native/Harness G5.

import { parseWorkspaceControl } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { reconcileLocalRangeEvidence } from '../src/local-range-evidence';
import { parseLocalRangeHold } from '../src/local-range-records';
import { localRecordHash } from '../src/local-registry-records';

function fixture() {
  const display =
    '/workspace takeover {"projectId":"project","taskId":"task","actionId":"take","expectedRevision":0,"workspaceId":"workspace","paths":["file.txt"]}';
  const plan = {
    schemaVersion: 'local-range-plan-v1',
    takeoverId: 'takeover:take',
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'workspace',
    rootId: 'root',
    grantId: 'grant',
    grantRevision: 0,
    expectedRevision: 0,
    sourceMessage: {
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
    },
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
        projectId: 'project',
        taskId: 'task',
        workerId: 'worker',
        sessionId: 'session',
        assignmentHash: 'b'.repeat(64),
      },
    ],
  };
  const planHash = localRecordHash(plan);
  const map = new Map<string, unknown>();
  const put = (v: unknown) => {
    const h = localRecordHash(v);
    map.set(h, v);
    return h;
  };
  const sourceRef = put({
    schemaVersion: 'local-range-source-v1',
    planHash,
    registryHash: 'c'.repeat(64),
    taskStateHashes: [{ projectId: 'project', taskId: 'task', hash: 'd'.repeat(64) }],
    manifestHash: plan.startVersion.manifestHash,
    targetFactsHash: 'e'.repeat(64),
  });
  const canonical = put({
    schemaVersion: 'local-range-canonical-v1',
    planHash,
    sourceRef,
    messageHash: localRecordHash(plan.sourceMessage),
  });
  const worker = put({
    schemaVersion: 'local-range-worker-closed-v1',
    planHash,
    sourceRef,
    projectId: 'project',
    taskId: 'task',
    workerId: 'worker',
    sessionId: 'session',
    status: 'paused',
    safePointRef: 'opaque',
    boundaryReceiptId: 'boundary:worker',
    closed: true,
    leaseReleased: true,
  });
  const held = put({
    schemaVersion: 'local-range-held-v1',
    planHash,
    sourceRef,
    workerProofs: [worker],
    writersProofRef: 'f'.repeat(64),
  });
  const hold = parseLocalRangeHold({
    plan,
    planHash,
    controlStage: 'committed',
    stage: 'heldByLeader',
    evidence: [
      { phase: 'canonical', workerKey: null, ref: canonical },
      { phase: 'worker_closed', workerKey: 'project/task/worker', ref: worker },
      { phase: 'held', workerKey: null, ref: held },
    ],
    returnMessage: null,
  });
  const events: string[] = [];
  const ports = {
    objects: {
      async getReference() {
        return sourceRef;
      },
      async get(ref: string) {
        if (!map.has(ref)) throw Error('missing object');
        return structuredClone(map.get(ref));
      },
    },
    async verifySource() {
      events.push('source');
    },
    async verifyCanonical() {
      events.push('canonical');
    },
    async verifyWorker() {
      events.push('worker');
    },
    async verifyWriters() {
      events.push('writers');
    },
    async verifyCurrentRootAndGrant() {
      events.push('current');
    },
  };
  return { hold, map, ports, events, worker, sourceRef };
}

it('only reports editable after every private source, canonical, worker and writer proof passes', async () => {
  const f = fixture();
  const result = await reconcileLocalRangeEvidence(f.hold, f.ports);
  expect(result).toMatchObject({ stage: 'heldByLeader', editable: true, needsAttention: false });
  expect(f.events).toEqual(['source', 'canonical', 'worker', 'writers', 'current']);
});

it.each(['source', 'canonical', 'worker', 'writers', 'current'])(
  'keeps the persistent barrier and returns needsAttention when %s verification fails',
  async (stage) => {
    const f = fixture();
    const reject = async () => {
      throw Error('private diagnostic must not escape');
    };
    if (stage === 'source') f.ports.verifySource = reject;
    if (stage === 'canonical') f.ports.verifyCanonical = reject;
    if (stage === 'worker') f.ports.verifyWorker = reject;
    if (stage === 'writers') f.ports.verifyWriters = reject;
    if (stage === 'current') f.ports.verifyCurrentRootAndGrant = reject;
    const before = localRecordHash(f.hold);
    expect(await reconcileLocalRangeEvidence(f.hold, f.ports)).toMatchObject({
      editable: false,
      needsAttention: true,
      reason: 'range_evidence_unverified',
    });
    expect(localRecordHash(f.hold)).toBe(before);
  },
);

it('rejects swapped or extra private evidence even when the registry reference is syntactically valid', async () => {
  const f = fixture();
  const wrong = { ...(f.map.get(f.worker) as object), workerId: 'other', extra: true };
  const hash = localRecordHash(wrong);
  f.map.set(hash, wrong);
  const held = f.hold.evidence.find((e) => e.phase === 'worker_closed');
  if (!held) throw Error('missing fixture proof');
  held.ref = hash;
  expect(await reconcileLocalRangeEvidence(f.hold, f.ports)).toMatchObject({
    editable: false,
    needsAttention: true,
  });
  expect(f.events).not.toContain('writers');
});

it('keeps a prepared request waiting after a source check and never treats it as editable', async () => {
  const f = fixture();
  const prepared = parseLocalRangeHold({
    ...f.hold,
    controlStage: 'prepared',
    stage: 'requested',
    evidence: [],
  });
  expect(await reconcileLocalRangeEvidence(prepared, f.ports)).toMatchObject({
    stage: 'requested',
    editable: false,
    needsAttention: false,
  });
  expect(f.events).toEqual(['source']);
});

it('does not clear attention that was recorded after the last held proof', async () => {
  const f = fixture();
  f.hold.evidence.push({ phase: 'needs_attention', workerKey: null, ref: 'a'.repeat(64) });
  expect(await reconcileLocalRangeEvidence(f.hold, f.ports)).toMatchObject({
    editable: false,
    needsAttention: true,
  });
  expect(f.events).not.toContain('current');
});

it('cannot use return or release phase labels to replace missing version/invalidation/recovery evidence', async () => {
  const f = fixture();
  const display =
    '/workspace return {"projectId":"project","taskId":"task","actionId":"return","expectedRevision":3,"takeoverReceiptId":"takeover:take"}';
  const returnMessage = {
    msgId: 'return',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    display,
    ts: 2,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  const returning = parseLocalRangeHold({
    ...f.hold,
    stage: 'returnRequested',
    returnMessage,
    evidence: [
      ...f.hold.evidence,
      { phase: 'return_requested', workerKey: null, ref: 'a'.repeat(64) },
    ],
  });
  expect(await reconcileLocalRangeEvidence(returning, f.ports)).toMatchObject({
    stage: 'returnRequested',
    editable: false,
    needsAttention: true,
  });
});

it.each(['prepared', 'committed'] as const)(
  'keeps an unresolved requested-stage attention fact visible in %s control',
  async (controlStage) => {
    const f = fixture();
    const requested = {
      ...f.hold,
      controlStage,
      stage: 'requested',
      evidence: [
        ...(controlStage === 'committed' ? f.hold.evidence.slice(0, 1) : []),
        { phase: 'needs_attention', workerKey: null, ref: 'a'.repeat(64) },
      ],
    };
    expect(() => parseLocalRangeHold(requested)).not.toThrow();
    expect(await reconcileLocalRangeEvidence(requested, f.ports)).toMatchObject({
      stage: 'requested',
      editable: false,
      needsAttention: true,
    });
  },
);
