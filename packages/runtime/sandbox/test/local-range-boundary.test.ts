// Private object/TaskState doubles isolate closure-proof validation. They cannot
// demonstrate native quiescence, catalog closure, lease release or Harness G5.
import { createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { readLocalRangeBoundary } from '../src/local-range-boundary';
import { localRecordHash } from '../src/local-registry-records';

function fixture() {
  const scope = {
    projectId: 'project',
    taskId: 'task',
    workerId: 'worker',
    sessionId: 'session',
    safePointRef: 'opaque',
  };
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
  const identity = localRecordHash({ projectId: 'project', taskId: 'task', workerId: 'worker' });
  const boundary = {
    schemaVersion: 'workspace-control-boundary-v1',
    projectId: 'project',
    taskId: 'task',
    workerId: 'worker',
    role: 'PM',
    sessionId: 'session',
    grantId: 'grant',
    boundary: 2,
    reason: 'close',
    quiescent: true,
    fileCapabilities: false,
  };
  const k = localRecordHash({
    kind: 'control-boundary',
    identity,
    sessionId: 'session',
    boundary: 2,
  });

  let active = false;
  const objects = {
    async references() {
      return [{ key: k, valueHash: localRecordHash(boundary) }];
    },
    async get(hash: string) {
      if (hash !== localRecordHash(boundary)) throw Error('missing');
      return structuredClone(boundary);
    },
  };
  const tasks = {
    async load() {
      return structuredClone(state);
    },
  };
  return {
    scope,
    state,
    boundary,
    objects,
    tasks,
    k,
    isActive: () => active,
    setActive(v: boolean) {
      active = v;
    },
  };
}
it('binds a paused control closure to the exact canonical session, safe point and private reference', async () => {
  const f = fixture();
  expect(await readLocalRangeBoundary(f.scope, f)).toBe(`closure:${f.k}`);
});
it.each(['active', 'wrong-session', 'missing-safe-point', 'not-close', 'unsafe', 'extra-field'])(
  'refuses %s evidence instead of inferring closure from a paused status',
  async (reason) => {
    const f = fixture();
    if (reason === 'active') f.setActive(true);
    const worker = f.state.workers[0];
    if (!worker) throw Error('missing fixture worker');
    if (reason === 'wrong-session') worker.sessionId = 'other';
    if (reason === 'missing-safe-point') delete worker.safePoint;
    if (reason === 'not-close') f.boundary.reason = 'step';
    if (reason === 'unsafe') f.boundary.quiescent = false;
    if (reason === 'extra-field') Object.assign(f.boundary, { untrusted: true });
    await expect(readLocalRangeBoundary(f.scope, f)).rejects.toThrow(
      'range_worker_boundary_unverified',
    );
  },
);
