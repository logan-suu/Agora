// Mock reason (R11): lifecycle callbacks and encoded source refs isolate replay validation.
// HTTP parsing, canonical commits, JSON persistence and restarts are real; G5 runs separately.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppState,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
  type WorkerState,
} from '@agora/core-domain';
import type { HumanGateResolutionReceipt } from '@agora/core-orchestration';
import { afterEach, expect, it } from 'vitest';
import { ChannelStream } from '../src/server/channel-stream';
import { createPostMessage } from '../src/server/message-handlers';
import { createMessageRuntime } from '../src/server/message-runtime';

const roots: string[] = [];
const scope = { projectId: 'replay-project', taskId: 'replay-task' };
const ref = (id: string, session = `source:${id}`, taskId = scope.taskId) =>
  `agora-safe-point:v1:${Buffer.from(JSON.stringify({ version: 1, ...scope, taskId, role: 'CODER', sourceSessionId: session, boundary: 10, cwd: '/fixture/task', agentPreset: 'agora-role:CODER' })).toString('base64url')}`;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agora-gate-replay-'));
  roots.push(root);
  let runtime = createMessageRuntime(root, new ChannelStream());
  let calls = 0;
  let receipt: HumanGateResolutionReceipt | undefined;
  const bind = () =>
    runtime.bindHumanGateLifecyclePort({
      suspend: async () => {
        throw Error('unexpected suspend');
      },
      resume: async (_scope, _id, value) => {
        calls++;
        receipt = value;
      },
    });
  bind();
  await runtime.initializeState(
    scope,
    applyMutations(createInitialAppState(scope.taskId, 'Replay gate', scope.projectId), [
      ...['a', 'b'].map((id) =>
        mergeByIdMutation('workers', id, {
          workerId: id,
          role: 'CODER',
          executor: 'harness',
          status: 'paused',
          sessionId: `source:${id}`,
          safePoint: ref(id),
          startedTs: 1,
        }),
      ),
      setMutation('humanGate', {
        gateId: 'human-gate:first',
        reason: 'iteration_limit',
        options: ['continue'],
        phase: 'coding',
        openedTs: 1,
        safePointRefs: [ref('a'), ref('b')],
      }),
    ]),
  );
  const request = (action = 'resolve-first', gate = 'first') =>
    createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: action,
          display: `/resolve-gate human-gate:${gate} continue`,
        }),
      }),
    );
  await request();
  const get = async () => {
    const state = await runtime.store.load(scope);
    if (!state) throw Error('missing state');
    return state;
  };
  const mark = async (action = 'resolve-first') => {
    if (!receipt) throw Error('missing receipt');
    await runtime.commitMessage(scope, {
      msgId: `human-gate-resumed:${action}`,
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      payload: {
        kind: 'human_gate_resumed',
        actionId: action,
        gateId: receipt.gateId,
        resumeSessionId: receipt.resumeSessionId,
        workerResumes: receipt.workerResumes,
      },
      display: 'Resumed',
      ts: 2,
    });
  };
  const progress = async (status: WorkerState['status'], id = 'a', action = 'resolve-first') =>
    runtime.commitMutations(scope, [
      mergeByIdMutation('workers', id, { status, sessionId: `human-gate-resume:${action}:${id}` }),
    ]);
  const corrupt = async (edit: (state: AppState) => void) => {
    const p = join(root, 'projects', scope.projectId, 'tasks', scope.taskId, 'state.json');
    const state = JSON.parse(await readFile(p, 'utf8')) as AppState;
    edit(state);
    await writeFile(p, JSON.stringify(state));
  };
  return {
    get,
    mark,
    progress,
    request,
    corrupt,
    get runtime() {
      return runtime;
    },
    get calls() {
      return calls;
    },
    restart() {
      runtime = createMessageRuntime(root, new ChannelStream());
      bind();
    },
  };
}
it.each(['running', 'done', 'failed'] as const)(
  'acknowledges a completed resume after worker %s without invoking lifecycle again',
  async (status) => {
    const f = await fixture();
    await f.mark();
    await f.progress(status);
    await f.progress('done', 'b');
    f.restart();
    const before = await f.get();
    expect((await f.request()).status).toBe(202);
    expect(f.calls).toBe(1);
    expect(await f.get()).toEqual(before);
  },
);
it('retains strict pre-resume admission and permits retry before the marker', async () => {
  const f = await fixture();
  expect((await f.request()).status).toBe(202);
  expect(f.calls).toBe(2);
  await f.progress('done');
  await expect(f.request()).rejects.toThrow(/conflicts/);
  expect(f.calls).toBe(2);
});
it('acknowledges a marker before any queued worker starts without starting another composition', async () => {
  const f = await fixture();
  await f.mark();
  expect((await f.request()).status).toBe(202);
  expect(f.calls).toBe(1);
});
it('preserves a later active gate when an older resolution is retried', async () => {
  const f = await fixture();
  await f.mark();
  await f.progress('paused');
  await f.progress('done', 'b');
  await f.runtime.commitMutations(scope, [
    mergeByIdMutation('workers', 'a', { safePoint: ref('a', 'human-gate-resume:resolve-first:a') }),
    setMutation('humanGate', {
      gateId: 'human-gate:second',
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'coding',
      openedTs: 3,
      safePointRefs: [ref('a', 'human-gate-resume:resolve-first:a')],
    }),
  ]);
  const before = await f.get();
  expect((await f.request()).status).toBe(202);
  expect(await f.get()).toEqual(before);
  expect(f.calls).toBe(1);
});
it('validates a later lineage child while replaying an older resolution', async () => {
  const f = await fixture();
  await f.mark();
  await f.progress('paused');
  await f.progress('done', 'b');
  const safe = ref('a', 'human-gate-resume:resolve-first:a');
  await f.runtime.commitMutations(scope, [
    mergeByIdMutation('workers', 'a', { safePoint: safe }),
    setMutation('humanGate', {
      gateId: 'human-gate:second',
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'coding',
      openedTs: 3,
      safePointRefs: [safe],
    }),
  ]);
  await f.request('resolve-second', 'second');
  await f.mark('resolve-second');
  await f.progress('done', 'a', 'resolve-second');
  f.restart();
  const before = await f.get();
  expect((await f.request()).status).toBe(202);
  expect(f.calls).toBe(2);
  expect(await f.get()).toEqual(before);
});
it.each([
  'marker-role',
  'marker-ref',
  'receipt-ref',
  'session',
  'missing-worker',
  'cross-task',
  'missing-plans',
] as const)('rejects corrupted %s before another lifecycle call', async (corruption) => {
  const f = await fixture();
  await f.mark();
  await f.progress('done');
  await f.progress('done', 'b');
  await f.corrupt((state) => {
    const marker = state.messages.find((m) => m.msgId === 'human-gate-resumed:resolve-first');
    const leader = state.messages.find((m) => m.msgId === 'resolve-first');
    if (!marker || !leader) throw Error('missing fixture messages');
    const receipt = leader.payload.resolution as HumanGateResolutionReceipt;
    const markerPlan = (
      marker.payload.workerResumes as HumanGateResolutionReceipt['workerResumes']
    )?.[0];
    const receiptPlan = receipt.workerResumes?.[0];
    const worker = state.workers[0];
    if (!markerPlan || !receiptPlan || !worker) throw Error('missing fixture worker');
    if (corruption === 'missing-plans') {
      delete receipt.workerResumes;
      delete marker.payload.workerResumes;
    }
    if (corruption === 'marker-role') marker.fromRole = 'CODER';
    if (corruption === 'marker-ref') markerPlan.sourceSafePointRef = 'wrong';
    if (corruption === 'receipt-ref') receipt.safePointRefs = ['wrong', ref('b')];
    if (corruption === 'session') worker.sessionId = 'unproven-child';
    if (corruption === 'missing-worker')
      state.workers = state.workers.filter((w) => w.workerId !== 'a');
    if (corruption === 'cross-task') {
      const bad = ref('a', 'source:a', 'foreign-task');
      receipt.safePointRefs[0] = bad;
      receiptPlan.sourceSafePointRef = bad;
      markerPlan.sourceSafePointRef = bad;
    }
  });
  await expect(f.request()).rejects.toThrow(/conflicts/);
  expect(f.calls).toBe(1);
});

it('rejects a forged later source session despite matching scope and marker', async () => {
  const f = await fixture();
  await f.mark();
  await f.progress('paused');
  await f.progress('done', 'b');
  const safe = ref('a', 'human-gate-resume:resolve-first:a');
  await f.runtime.commitMutations(scope, [
    mergeByIdMutation('workers', 'a', { safePoint: safe }),
    setMutation('humanGate', {
      gateId: 'human-gate:second',
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'coding',
      openedTs: 3,
      safePointRefs: [safe],
    }),
  ]);
  await f.request('resolve-second', 'second');
  await f.mark('resolve-second');
  // An older replay also remains valid before the new child has started.
  expect((await f.request()).status).toBe(202);
  expect(f.calls).toBe(2);
  await f.progress('done', 'a', 'resolve-second');
  await f.corrupt((state) => {
    const leader = state.messages.find((m) => m.msgId === 'resolve-second');
    const marker = state.messages.find((m) => m.msgId === 'human-gate-resumed:resolve-second');
    if (!leader || !marker) throw Error('missing second resolution');
    const receipt = leader.payload.resolution as HumanGateResolutionReceipt;
    const plan = receipt.workerResumes?.[0];
    const markerPlan = (
      marker.payload.workerResumes as HumanGateResolutionReceipt['workerResumes']
    )?.[0];
    if (!plan || !markerPlan) throw Error('missing second worker plan');
    const bad = ref('a', 'unrelated-session');
    receipt.safePointRefs = [bad];
    plan.sourceSafePointRef = bad;
    markerPlan.sourceSafePointRef = bad;
  });
  await expect(f.request()).rejects.toThrow(/conflicts/);
  expect(f.calls).toBe(2);
});

it('rejects a restored original gate instead of claiming its clear effect still holds', async () => {
  const f = await fixture();
  await f.mark();
  await f.progress('done');
  await f.progress('done', 'b');
  await f.runtime.commitMutations(scope, [
    setMutation('humanGate', {
      gateId: 'human-gate:first',
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'coding',
      openedTs: 1,
      safePointRefs: [ref('a'), ref('b')],
    }),
  ]);
  await expect(f.request()).rejects.toThrow(/conflicts/);
  expect(f.calls).toBe(1);
});
