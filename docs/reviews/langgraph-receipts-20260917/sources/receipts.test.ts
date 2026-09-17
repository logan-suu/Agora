// Fixed counter effects are protocol fixtures, not Harness/model doubles for G5.
// Experimental control receipts use a private message payload only in this fixture.
// Production migration requires its own trusted schema and write authorization.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { appendMutation, createInitialAppState, mergeByIdMutation, type AppState, type Mutation } from '@agora/core-domain';
import { JsonTaskStateStore } from '@agora/runtime-state';
import { expect, it } from 'vitest';

const require = createRequire(resolve('test-outputs/langgraph-receipts/runtime/package.json'));
const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite');
const root = process.env.LG_RECEIPT_ROOT!;
const mode = process.env.LG_RECEIPT_MODE!;
const fault = process.env.LG_RECEIPT_FAULT ?? '';
const scope = { projectId: 'receipt-project', taskId: 'receipt-task' };
const key = 'dispatch-1';
const workerId = 'worker-1';
const input = 'fixed-input-v1';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fingerprint = digest(JSON.stringify({ ...scope, key, workerId, input }));
const statePath = join(root, 'business/projects/receipt-project/tasks/receipt-task/state.json');
const effectPath = join(root, 'fixture-effect.json');
const store = new JsonTaskStateStore(join(root, 'business'));
const id = (stage: string) => `fixture:${key}:${stage}`;
type Stage = 'dispatched' | 'started' | 'completed';

function durable(path: string, value: unknown) {
  const fd = openSync(path, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
function effect() {
  return existsSync(effectPath) ? JSON.parse(readFileSync(effectPath, 'utf8')) : undefined;
}
function crash(window: string) {
  if (fault !== window) return;
  durable(join(root, 'fault.json'), { window, pid: process.pid, modelCalls: 0, toolCalls: 0, effect: effect() ?? null });
  process.kill(process.pid, 'SIGKILL');
}
function receipt(stage: Stage, extra: Record<string, unknown> = {}): Mutation {
  return appendMutation('messages', {
    msgId: id(stage), channelId: 'main', fromRole: 'COORDINATOR', type: 'announce',
    payload: { kind: 'experimental_dispatch_receipt', schemaVersion: 1, ...scope, key, workerId, fingerprint, stage, ...extra },
    display: 'Protocol fixture receipt', ts: 1,
  });
}
function readReceipt(state: AppState, stage: Stage) {
  const matches = state.messages.filter((m) => m.msgId === id(stage));
  if (!matches.length) return undefined;
  const message = matches[0]!;
  const r = message.payload;
  if (matches.length !== 1 || message.fromRole !== 'COORDINATOR' || message.channelId !== 'main' ||
      message.type !== 'announce' || r.kind !== 'experimental_dispatch_receipt' || r.schemaVersion !== 1 ||
      r.projectId !== scope.projectId || r.taskId !== scope.taskId || r.key !== key || r.workerId !== workerId ||
      r.stage !== stage || r.fingerprint !== fingerprint) throw Error('RECEIPT_CONFLICT');
  const allowed = ['kind','schemaVersion','projectId','taskId','key','workerId','fingerprint','stage', ...(stage === 'completed' ? ['effectHash'] : [])];
  if (Object.keys(r).length !== allowed.length || Object.keys(r).some((k) => !allowed.includes(k))) throw Error('RECEIPT_SHAPE');
  return r;
}
async function state() {
  const value = await store.load(scope);
  if (!value) throw Error('STATE_MISSING');
  return value;
}
function validate(value: AppState) {
  const dispatched = readReceipt(value, 'dispatched');
  const started = readReceipt(value, 'started');
  const completed = readReceipt(value, 'completed');
  const workers = value.workers.filter((w) => w.workerId === workerId);
  if (dispatched && (workers.length !== 1 || workers[0]?.role !== 'CODER' || workers[0]?.executor !== 'harness')) throw Error('WORKER_CONFLICT');
  if (!dispatched && (started || completed || workers.length)) throw Error('BROKEN_RECEIPT_CHAIN');
  if (completed) {
    if (!started || workers[0]?.status !== 'done' || !existsSync(effectPath) ||
        completed.effectHash !== digest(readFileSync(effectPath)) || effect()?.count !== 1 || effect()?.fingerprint !== fingerprint) throw Error('EFFECT_CONFLICT');
    return 'completed';
  }
  if (started) return 'needs_attention';
  if (existsSync(effectPath)) throw Error('UNRECEIPTED_EFFECT');
  return dispatched ? 'dispatched' : 'not_dispatched';
}

it('runs a single isolated protocol phase', async () => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (mode === 'start') await store.initialize(scope, createInitialAppState(scope.taskId, 'Receipt protocol fixture', scope.projectId));
  if (mode.startsWith('corrupt-')) {
    // Deliberately corrupt only this synthetic fixture; no production path does this.
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as AppState;
    if (mode === 'corrupt-missing') value.messages = value.messages.filter((m) => m.msgId !== id('completed'));
    if (mode === 'corrupt-input') value.messages.find((m) => m.msgId === id('completed'))!.payload.fingerprint = 'wrong';
    if (mode === 'corrupt-effect') durable(effectPath, { count: 2, fingerprint });
    if (mode !== 'corrupt-effect') durable(statePath, value);
    return;
  }
  const saver = SqliteSaver.fromConnString(join(root, 'graph.sqlite'));
  const putWrites = saver.putWrites.bind(saver);
  saver.putWrites = async (...args: any[]) => {
    await putWrites(...args);
    if (args[1].some(([channel]: [string]) => channel === 'result')) crash('pending-writes');
  };
  const GraphState = Annotation.Root({ dispatch: Annotation(), result: Annotation() });
  const graph = new StateGraph(GraphState)
    .addNode('dispatchNode', async () => {
      const status = validate(await state());
      if (status === 'not_dispatched') {
        crash('before-dispatch');
        await store.commit(scope, [
          mergeByIdMutation('workers', workerId, { workerId, role: 'CODER', executor: 'harness', status: 'pending', startedTs: 1 }),
          receipt('dispatched'),
        ]);
        crash('dispatch-committed');
      }
      return { dispatch: id('dispatched') };
    })
    .addNode('effectNode', async () => {
      const status = validate(await state());
      if (status === 'completed') return { result: id('completed') };
      if (status !== 'dispatched') throw Error('NEEDS_ATTENTION_UNPROVEN_EFFECT');
      await store.commit(scope, [receipt('started'), mergeByIdMutation('workers', workerId, { status: 'running' })]);
      crash('started');
      durable(effectPath, { count: (effect()?.count ?? 0) + 1, fingerprint });
      crash('effect-without-receipt');
      await store.commit(scope, [
        receipt('completed', { effectHash: digest(readFileSync(effectPath)) }),
        mergeByIdMutation('workers', workerId, { status: 'done' }),
      ]);
      crash('business-committed');
      return { result: id('completed') };
    })
    .addEdge(START, 'dispatchNode').addEdge('dispatchNode', 'effectNode').addEdge('effectNode', END)
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'receipt-thread' }, durability: 'sync' };
  const beforeHash = digest(readFileSync(statePath));
  let error: string | null = null;
  let status: string | undefined;
  try {
    // This guard runs even when a completed graph would execute no nodes.
    const current = await state();
    const requestedFingerprint = digest(JSON.stringify({ ...scope, key, workerId, input: process.env.LG_RECEIPT_INPUT ?? input }));
    const dispatched = readReceipt(current, 'dispatched');
    if (dispatched && dispatched.fingerprint !== requestedFingerprint) throw Error('INPUT_CONFLICT');
    status = validate(current);
    const snapshot = await graph.getState(config);
    if (snapshot.values.result && status !== 'completed') throw Error('GRAPH_BUSINESS_CONFLICT');
    if (mode !== 'inspect') {
      if (status === 'needs_attention') throw Error('NEEDS_ATTENTION_UNPROVEN_EFFECT');
      await graph.invoke(mode === 'start' ? {} : null, config);
      expect(validate(await state())).toBe('completed');
    }
  } catch (caught) { error = (caught as Error).message; }
  const snapshot = await graph.getState(config);
  const tuple = await saver.getTuple(config);
  const afterHash = digest(readFileSync(statePath));
  const result = { mode, fault, error, status, next: snapshot.next, graphValues: snapshot.values,
    pendingWrites: (tuple?.pendingWrites ?? []).map((entry: unknown[]) => entry[1]),
    stateUnchanged: beforeHash === afterHash, stateHash: afterHash, effect: effect() ?? null,
    worker: (await state()).workers[0] ?? null, receiptStages: (await state()).messages.map((m) => m.payload.stage),
    modelCalls: 0, toolCalls: 0 };
  durable(join(root, `${mode}.json`), result);
  saver.db.close();
  if (mode === 'inspect') expect(beforeHash).toBe(afterHash);
  const expected = process.env.LG_RECEIPT_EXPECT_ERROR;
  expect(error).toBe(expected ?? null);
});
