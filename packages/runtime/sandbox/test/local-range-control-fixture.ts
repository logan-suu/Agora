// Task/control/object doubles isolate saga order and crash boundaries. They do
// not prove native writers, official Harness closure, or G5.
import {
  type AppState,
  applyMutations,
  createInitialAppState,
  parseWorkspaceControl,
} from '@agora/core-domain';
import { serializeLocalRangeAdmission } from '../src/local-range-activation';
import { LocalRangeController } from '../src/local-range-controller';
import type { LocalRangeWorkerProof } from '../src/local-range-evidence';
import { type LocalRangeHold, parseLocalRangeHold } from '../src/local-range-records';
import { type LocalRegistryRecords, localRecordHash } from '../src/local-registry-records';

export function fixture() {
  const scope = { projectId: 'project', taskId: 'task' };
  const display =
    '/workspace takeover ' +
    JSON.stringify({
      ...scope,
      actionId: 'take',
      expectedRevision: 0,
      workspaceId: 'workspace',
      paths: ['file.txt'],
    });
  const message: import('@agora/core-domain').Message = {
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
    sourceMessage: message,
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
      { ...scope, workerId: 'worker', sessionId: 'session', assignmentHash: 'b'.repeat(64) },
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
  let state = createInitialAppState('task', 'test', 'project');
  let registry = {
    schemaVersion: 'local-workspaces-v2',
    revision: 0,
    rangeHolds: [],
    operations: [],
  } as unknown as LocalRegistryRecords;
  const values = new Map<string, unknown>(),
    refs = new Map<string, string>(),
    events: string[] = [];
  const objects = {
    async put(value: unknown) {
      const hash = localRecordHash(value);
      values.set(hash, structuredClone(value));
      return hash;
    },
    async get(hash: string) {
      if (!values.has(hash)) throw Error('missing');
      return structuredClone(values.get(hash));
    },
    async bindReference(k: string, h: string) {
      if (refs.has(k) && refs.get(k) !== h) throw Error('conflict');
      refs.set(k, h);
    },
    async getReference(k: string) {
      return refs.get(k);
    },
  };
  const control = {
    serializeRangeAdmission<T>(work: () => Promise<T>) {
      return serializeLocalRangeAdmission(control, work);
    },
    async snapshot() {
      return structuredClone(registry);
    },
    async updateRangeHold(rev: number, next: LocalRangeHold) {
      if (rev !== registry.revision) throw Error('registry_revision_conflict');
      events.push(`${next.controlStage}:${next.stage}`);
      registry = { ...registry, revision: rev + 1, rangeHolds: [structuredClone(next)] };
      return structuredClone(next);
    },
  };
  const tasks = {
    async load() {
      return structuredClone(state);
    },
    async compareAndCommit(
      _scope: unknown,
      expected: AppState,
      mutations: Parameters<typeof applyMutations>[1],
    ) {
      if (localRecordHash(expected) !== localRecordHash(state)) throw Error('stale');
      events.push('canonical-message');
      state = applyMutations(state, mutations);
      return { state: structuredClone(state), changed: true };
    },
  };
  const source = { ...hold.plan, sourceMessage: message };
  const lifecycle = {
    async closeWorkers(h: LocalRangeHold, sourceRef: string): Promise<LocalRangeWorkerProof[]> {
      events.push('close-workers');
      return [
        {
          schemaVersion: 'local-range-worker-closed-v1',
          planHash: h.planHash,
          sourceRef,
          ...scope,
          workerId: 'worker',
          sessionId: 'session',
          status: 'paused',
          safePointRef: 'opaque',
          boundaryReceiptId: 'boundary:worker',
          closed: true,
          leaseReleased: true,
        },
      ];
    },
    async proveWriters() {
      events.push('prove-writers');
      return objects.put({ native: 'unit-double' });
    },
  };
  const sources = {
    async prepare() {
      events.push('prepare');
      return {
        plan: source,
        proof: {
          schemaVersion: 'local-range-source-v1' as const,
          planHash: hold.planHash,
          registryHash: localRecordHash(registry),
          taskStateHashes: [{ ...scope, hash: 'd'.repeat(64) }],
          manifestHash: 'a'.repeat(64),
          targetFactsHash: 'e'.repeat(64),
        },
      };
    },
    async verifySource() {
      events.push('verify-source');
    },
    async verifyCanonical() {
      events.push('verify-canonical');
    },
    async verifyWorker() {
      events.push('verify-worker');
    },
    async verifyWriters() {
      events.push('verify-writers');
    },
    async verifyCurrentRootAndGrant() {
      events.push('verify-current');
    },
  };
  const controller = new LocalRangeController({ control, objects, tasks, sources, lifecycle });
  return {
    scope,
    message,
    hold,
    events,
    controller,
    control,
    tasks,
    lifecycle,
    sources,
    objects,
    values,
    refs,
    setState(v: AppState) {
      state = v;
    },
  };
}
