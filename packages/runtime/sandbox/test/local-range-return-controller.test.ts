// Control/task/evidence doubles exercise saga ordering and readonly recovery.
// They never qualify native file capture, writers, official Fork or G5.
import { type Message, parseWorkspaceControl } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { LocalRangeReturnController } from '../src/local-range-return-controller';
import { localRecordHash } from '../src/local-registry-records';
import { fixture } from './local-range-control-fixture';

async function setup() {
  const f = fixture();
  await f.controller.commit(f.scope, f.message);
  const held = await f.controller.hold('takeover:take');
  const snapshot = await f.control.snapshot();
  const display =
    '/workspace return ' +
    JSON.stringify({
      ...f.scope,
      actionId: 'return',
      expectedRevision: snapshot.revision,
      takeoverReceiptId: held.plan.takeoverId,
    });
  const message: Message = {
    msgId: 'return',
    fromRole: 'leader',
    channelId: 'main',
    type: 'chat',
    ts: 2,
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  let captures = 0;
  const evidence = {
    async verifyHeld() {
      f.events.push('verify-held-history');
    },
    async capture(hold: typeof held, requestRef: string) {
      captures++;
      f.events.push('capture');
      const state = await f.tasks.load();
      const taskHash = await f.objects.put(state);
      return {
        schemaVersion: 'local-range-return-capture-v1' as const,
        planHash: hold.planHash,
        sourceRef: 'a'.repeat(64),
        requestRef,
        heldProofRef: hold.evidence.find((e) => e.phase === 'held')?.ref as string,
        registryHash: await f.objects.put(await f.control.snapshot()),
        targetsHash: 'b'.repeat(64),
        heldVersion: hold.plan.startVersion,
        returnedVersion: hold.plan.startVersion,
        taskStateHashes: [{ ...f.scope, hash: taskHash }],
        tasks: [
          { ...f.scope, stateHash: taskHash, workspaceIds: ['workspace'], affectedWorkerIds: [] },
        ],
      };
    },
    async verifyCapture(_hold: unknown, _proof: unknown, current: boolean) {
      f.events.push(current ? 'verify-current-capture' : 'verify-history-capture');
    },
    async verifyReleased() {
      f.events.push('verify-released');
    },
  };
  // This fixture has no native workspace; no version messages may be synthesized
  // from it. Empty impacts are rejected separately; only request paths use it.
  const controller = new LocalRangeReturnController({ ...f, evidence });
  return { ...f, held, message, evidence, returns: controller, captures: () => captures };
}
it('commits the return intent without capturing files or releasing its existing barrier inside the task queue', async () => {
  const f = await setup();
  const state = await f.returns.commit(f.scope, f.message);
  expect(state.messages.map((m) => m.msgId)).toEqual(['take', 'return']);
  expect(f.captures()).toBe(0);
  expect((await f.control.snapshot()).rangeHolds?.[0]).toMatchObject({
    stage: 'returnRequested',
    returnMessage: f.message,
  });
  expect(f.events).not.toContain('capture');
});
it('replays a saved request with its original timestamp and no capture, release or resume', async () => {
  const f = await setup();
  await f.returns.commit(f.scope, f.message);
  const before = await f.control.snapshot();
  const cold = new LocalRangeReturnController({ ...f, evidence: f.evidence });
  await cold.commit(f.scope, { ...f.message, ts: 999 });
  expect(await f.control.snapshot()).toEqual(before);
  expect(f.captures()).toBe(0);
  await expect(cold.release(f.held.plan.takeoverId)).rejects.toThrow('range_return_not_live');
});
it('keeps the barrier when the canonical request commit fails', async () => {
  const f = await setup();
  f.tasks.compareAndCommit = async () => {
    throw Error('disk failure');
  };
  await expect(f.returns.commit(f.scope, f.message)).rejects.toThrow(
    'range_return_needs_attention',
  );
  expect((await f.control.snapshot()).rangeHolds?.[0]?.stage).toBe('heldByLeader');
  expect(f.captures()).toBe(0);
});
it('rejects another action ID or changed intent for a persisted request', async () => {
  const f = await setup();
  await f.returns.commit(f.scope, f.message);
  const display = f.message.display.replace('"return"', '"another"');
  const changed = {
    ...f.message,
    msgId: 'another',
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  await expect(f.returns.commit(f.scope, changed as Message)).rejects.toThrow(
    'range_return_conflict',
  );
  expect(f.captures()).toBe(0);
});
it('rejects a stale revision before saving any return message', async () => {
  const f = await setup();
  const display = f.message.display.replace(
    `"expectedRevision":${(await f.control.snapshot()).revision}`,
    '"expectedRevision":0',
  );
  const changed = {
    ...f.message,
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  await expect(f.returns.commit(f.scope, changed as Message)).rejects.toThrow(
    'registry_revision_conflict',
  );
  expect((await f.tasks.load()).messages).toEqual([f.held.plan.sourceMessage]);
});
it('rejects unverified capture or malformed affected states before releasing', async () => {
  const f = await setup();
  await f.returns.commit(f.scope, f.message);
  await expect(f.returns.release(f.held.plan.takeoverId)).rejects.toThrow(
    'range_return_needs_attention',
  );
  expect((await f.control.snapshot()).rangeHolds?.[0]?.stage).toBe('returnRequested');
  expect(f.captures()).toBe(1);
  const before = localRecordHash(await f.control.snapshot());
  const cold = new LocalRangeReturnController({ ...f, evidence: f.evidence });
  expect(await cold.view(f.held.plan.takeoverId)).toMatchObject({
    released: false,
    needsAttention: true,
  });
  expect(localRecordHash(await f.control.snapshot())).toBe(before);
  expect(f.captures()).toBe(1);
});

async function multiTask(failSecond: boolean) {
  const f = await setup();
  const states = new Map<string, import('@agora/core-domain').AppState>();
  const { createInitialAppState, applyMutations } = await import('@agora/core-domain');
  const own = await f.tasks.load();
  for (const taskId of ['task', 'other']) {
    const state =
      taskId === 'task' ? own : createInitialAppState(taskId, 'other', f.scope.projectId);
    state.localExecution = {
      schemaVersion: 'local-execution-v1',
      rootIds: ['root'],
      bindings: [],
      receipts: [],
      workspaces: [
        {
          schemaVersion: 'workspace-v1',
          projectId: state.projectId,
          taskId: state.taskId,
          workspaceId: 'workspace',
          rootId: 'root',
          grantId: 'grant',
          purpose: 'coding',
          mode: 'direct',
          baselineManifestId: 'manifest:1',
        },
      ],
    };
    states.set(taskId, state);
  }
  const commits: string[] = [];
  const tasks = {
    async load(s: { taskId: string }) {
      return structuredClone(states.get(s.taskId));
    },
    async compareAndCommit(
      s: { taskId: string },
      expected: import('@agora/core-domain').AppState,
      mutations: Parameters<typeof applyMutations>[1],
    ) {
      if (failSecond && s.taskId === 'other') throw Error('second-task-disk-failure');
      if (localRecordHash(states.get(s.taskId)) !== localRecordHash(expected)) throw Error('stale');
      const state = applyMutations(expected, mutations);
      states.set(s.taskId, state);
      commits.push(s.taskId);
      return { state: structuredClone(state), changed: true };
    },
  };
  const capture = f.evidence.capture.bind(f.evidence);
  const evidence = {
    ...f.evidence,
    async capture(h: typeof f.held, r: string) {
      const base = await capture(h, r);
      const snapshots = await Promise.all(
        [...states.values()].map(async (s) => ({ state: s, hash: await f.objects.put(s) })),
      );
      return {
        ...base,
        taskStateHashes: snapshots.map(({ state: s, hash }) => ({
          projectId: s.projectId,
          taskId: s.taskId,
          hash,
        })),
        tasks: snapshots.map(({ state: s, hash }) => ({
          projectId: s.projectId,
          taskId: s.taskId,
          stateHash: hash,
          workspaceIds: ['workspace'],
          affectedWorkerIds: [],
        })),
      };
    },
    async verifyReleased() {
      expect(
        [...states.values()].every((s) =>
          s.messages.some((m) => m.payload.kind === 'workspace_version_change'),
        ),
      ).toBe(true);
      expect((await f.control.snapshot()).rangeHolds?.[0]?.stage).toBe('returnRequested');
    },
  };
  const controller = new LocalRangeReturnController({ ...f, tasks, evidence });
  await controller.commit(f.scope, f.message);
  return { ...f, states, commits, controller };
}
it('releases only after both affected tasks durably contain their scoped version facts', async () => {
  const f = await multiTask(false);
  await f.controller.release(f.held.plan.takeoverId);
  expect(f.commits).toEqual(['task', 'task', 'other']);
  expect((await f.control.snapshot()).rangeHolds?.[0]?.stage).toBe('released');
  for (const [taskId, state] of f.states) {
    const fact = state.messages.find((m) => m.payload.kind === 'workspace_version_change');
    expect(fact?.payload).toMatchObject({ taskId, source: { taskId: 'task', msgId: 'return' } });
  }
});
it('retains the first task fact and the global barrier when a later task commit fails, without replay repair', async () => {
  const f = await multiTask(true);
  await expect(f.controller.release(f.held.plan.takeoverId)).rejects.toThrow(
    'range_return_needs_attention',
  );
  expect(
    f.states.get('task')?.messages.filter((m) => m.payload.kind === 'workspace_version_change'),
  ).toHaveLength(1);
  expect(
    f.states.get('other')?.messages.filter((m) => m.payload.kind === 'workspace_version_change'),
  ).toHaveLength(0);
  const hold = (await f.control.snapshot()).rangeHolds?.[0];
  expect(hold?.stage).toBe('returnRequested');
  expect(hold?.evidence.some((e) => e.phase === 'invalidated' || e.phase === 'released')).toBe(
    false,
  );
  const before = localRecordHash(await f.control.snapshot());
  await f.controller.commit(f.scope, { ...f.message, ts: 999 });
  expect(localRecordHash(await f.control.snapshot())).toBe(before);
  expect(f.captures()).toBe(1);
});
