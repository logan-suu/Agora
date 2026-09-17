// Real Go model, official Harness loop, WorkerRuntime, MCP, APFS transactions
// and managed Node under Seatbelt. Only fixed fictional LRU inputs leave host.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createInitialAppState, mergeByIdMutation, setMutation } from '@agora/core-domain';
import { GlobalScheduler, materializeHumanGate, type HumanGateResolutionReceipt } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { LocalGrantController } from '../../../packages/runtime/sandbox/src/local-grant-controller';
import { LocalRootCoordinator } from '../../../packages/runtime/sandbox/src/local-root-coordinator';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { localRootBinding } from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import type {
  WorkspaceCommandReceipt,
  WorkspaceCommandRequest,
} from '../../../packages/runtime/sandbox/src/workspace-port';
import { resolveLiveTestModel } from '../../../tests/helpers/live-model';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const tests = `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LRUCache } = require('./lru-cache.cjs');
test('missing keys return undefined', () => { const c = new LRUCache(2); assert.equal(c.get('missing'), undefined); });
test('get refreshes recency and capacity evicts oldest', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); assert.equal(c.get('a'), 1); c.set('c', 3); assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 1); assert.equal(c.get('c'), 3); });
test('updating a key preserves capacity', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); c.set('a', 7); assert.equal(c.get('a'), 7); assert.equal(c.get('b'), 2); });
test('delete removes only the chosen key', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); assert.equal(c.delete('a'), true); assert.equal(c.delete('a'), false); assert.equal(c.get('a'), undefined); assert.equal(c.get('b'), 2); });
test('optional TTL expires entries', async () => { const c = new LRUCache(2, 20); c.set('a', 1); assert.equal(c.get('a'), 1); await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(c.get('a'), undefined); });
`;
const task =
  'Implement only lru-cache.cjs as CommonJS exporting LRUCache. Constructor(capacity, ttlMs = Infinity); get(key) returns value or undefined and refreshes recency; set(key,value) inserts/updates and evicts least recently used when capacity is exceeded; delete(key) returns whether it existed. Optional TTL expires entries from their last set time. Read the existing files first; preserve lru-cache.test.cjs unchanged. Use workspace_apply with the original expected/readReceiptId. Capture the resulting file manifest with workspace_read with no path, then run managed Node using workspace_run argv ["--test","--test-reporter=tap","@input/lru-cache.test.cjs"] against that inputVersion. All five tests must pass. End with actual file and test evidence; do not invent a receipt or modify tests.';

import { createRequire } from 'node:module';
import { createLocalTaskCompositionFactory } from '../../../apps/web/src/server/local-task-composition';
import type { TaskComposition } from '../../../apps/web/src/server/task-orchestration-runtime';
const require = createRequire(resolve('test-outputs/langgraph-spike-round2/runtime/package.json'));
const { StateGraph, Annotation, START, END, interrupt, Command } = require('@langchain/langgraph');
const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite');
const mode = process.env.LG_ROUND2_MODE ?? 'initial';
const output = resolve('test-outputs/langgraph-spike-round2/results');
mkdirSync(output, { recursive: true });
const location = join(output, 'fixture.json');
const scope = { projectId: 'graph-native-project', taskId: 'graph-native-task' };
const actionId = 'graph-native-continue';
const gateId = 'human-gate:graph-native-pause';
const cfg = { configurable: { thread_id: 'native-graph' }, durability: 'sync' };
const log = (event: string, data: Record<string, unknown> = {}) => appendFileSync(join(output, 'events.jsonl'), JSON.stringify({event, mode, pid: process.pid, at: Date.now(), ...data}) + '\n');
const allEvents = () => readFileSync(join(output, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

// Only lifecycle/graph wiring and a timing barrier are test-owned. All model,
// state, D9 resolution, pause, Fork and workspace implementations are production.
it('joins a graph to production local WorkerRuntime and durable Leader resolution', async () => {
  const base = mode === 'initial' ? mkdtempSync('/private/tmp/agora-langgraph-round2-') : JSON.parse(readFileSync(location, 'utf8')).base;
  if (mode === 'initial') writeFileSync(location, JSON.stringify({base}));
  const root = join(base, 'project');
  const evidence: Record<string, unknown> = { mode, base, startedAt: new Date().toISOString(), provider: 'opencode-go', model: 'deepseek-v4-flash' };
  log('process-start');
  let composition: TaskComposition | undefined;
  let releaseTool: () => void = () => {};
  const toolBarrier = new Promise<void>(r => { releaseTool = r; });
  let announceTool: () => void = () => {};
  const firstTool = new Promise<void>(r => { announceTool = r; });
  const scheduler = new GlobalScheduler({ cap: 1 });
  let graphCall: Promise<unknown> | undefined;
  const saver = SqliteSaver.fromConnString(join(base, 'graph.sqlite'));
  if (mode === 'initial') {
    mkdirSync(root);
    writeFileSync(join(root, 'lru-cache.cjs'), '// Fixed incomplete LRU fixture.\nmodule.exports = {};\n');
    writeFileSync(join(root, 'lru-cache.test.cjs'), tests);
    writeFileSync(join(root, '.env'), 'FIXED_FAKE_SECRET=not-a-real-credential\n');
  }
  const owner = await acquireState(join(base, 'state'));
  try {
    const helpers: Record<string, string> = {};
    for (const name of [
      'local-root-inspection',
      'local-root-initialization',
      'local-file-transaction',
      'local-command-bootstrap',
      'local-process-control',
    ]) {
      const target = join(base, name);
      if (mode === 'initial') execFileSync('/usr/bin/clang', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-mmacosx-version-min=15.0',
        resolve(`packages/runtime/sandbox/native/${name}.c`),
        '-o',
        target,
      ]);
      helpers[name] = target;
    }
    const helper = (name: string) => {
      const path = helpers[name];
      if (!path) throw Error('missing fixture helper');
      return path;
    };
    const toolsRoot = '/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64';
    const manifestBytes = readFileSync(join(toolsRoot, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const nodePath = join(toolsRoot, 'node/bin/node');
    const nodeHash = manifest.files.find(
      (file: { path: string; sha256: string }) => file.path === 'node/bin/node',
    )?.sha256;
    expect(manifest.versions.node).toBe('24.20.0');
    expect(hash(readFileSync(nodePath))).toBe(nodeHash);
    evidence.toolchain = {
      manifestHash: hash(manifestBytes),
      nodeHash,
      nodeVersion: manifest.versions.node,
    };
    const runtime = new MessageRuntime(
      join(owner.root, 'tasks'),
      new ChannelStream(),
      DEFAULT_ROSTER,
    );
    if (mode === 'initial') await runtime.initializeState(
      scope,
      createInitialAppState(scope.taskId, task, scope.projectId),
    );
    const control = await LocalBindingCoordinator.open(owner, runtime.store, true);
    const controller = await LocalGrantController.open(
      owner,
      control,
      runtime.store,
      helper('local-root-inspection'),
      async () => ({
        version: 'seatbelt-apfs-v1',
        actions: ['read', 'edit', 'run'],
        toolchain: { manifestHash: hash(manifestBytes) },
        network: { mode: 'disabled' },
        outputs: { kind: 'private-per-operation' },
      }),
    );
    runtime.bindWorkspaceControlPort(controller);
    if (mode === 'initial') {
    const proposal = await controller.prepareGrant(scope, {
      selectionRef: 'graph-native-selection',
      path: root,
    });
    const body = {
      ...scope,
      actionId: 'graph-native-grant',
      expectedRevision: proposal.proposal.expectedRevision,
      selectionRef: 'graph-native-selection',
      policyProposalId: proposal.policyProposalId,
      inputHash: proposal.inputHash,
    };
    const response = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: body.actionId,
          display: `/workspace grant ${JSON.stringify(body)}`,
        }),
      }),
    );
    expect(response.status).toBe(202);
    }
    const grant = (await control.snapshot()).grants[0];
    if (!grant) throw Error('missing canonical grant');
    const roots = await LocalRootCoordinator.open(owner, control, {
      inspector: helper('local-root-inspection'),
      initializer: helper('local-root-initialization'),
    });
    if (mode === 'initial') await roots.initialize({
      ...scope,
      actionId: 'graph-native-initialize',
      rootId: grant.rootId,
      grantId: grant.grantId,
      expectedRevision: (await control.snapshot()).revision,
    });
    const objects = await LocalControlObjects.open(owner);
    const versions = new LocalVersionStore(objects, helper('local-file-transaction'));
    const local = await LocalWorkspaceSessions.create({
      owner,
      control,
      roots,
      objects,
      versions,
      filesHelper: helper('local-file-transaction'),
      tools: {
        manifestHash: hash(manifestBytes),
        node: { path: nodePath, sha256: nodeHash, version: manifest.versions.node },
        bootstrap: {
          path: helper('local-command-bootstrap'),
          sha256: hash(readFileSync(helper('local-command-bootstrap'))),
        },
        processControl: {
          path: helper('local-process-control'),
          sha256: hash(readFileSync(helper('local-process-control'))),
        },
      },
      verifyGrant: (s, id) => controller.assertGrant(s, id),
      grantForAssignment: async () => grant.grantId,
    });
    if (mode === 'initial') await runtime.commitMutations(scope, [
      setMutation('phase', 'coding'),
      mergeByIdMutation('subtasks', 'lru', { title: task, ownerRole: 'CODER', status: 'in_progress', dependsOn: [] }),
    ]);
    let canonicalReceipt: HumanGateResolutionReceipt | undefined;
    runtime.bindHumanGateLifecyclePort({
      suspend: async () => { throw Error('use the explicit graph pause barrier'); },
      resume: async (_scope, id, receipt) => {
        expect(id).toBe(actionId);
        canonicalReceipt = receipt;
        log('canonical-resolution-delivered', { workers: receipt.workerResumes?.length ?? 0 });
        // Resolving records intent only; explicit graph continue owns execution.
      },
    });
    const get = async () => {
      const state = await runtime.store.load(scope);
      if (!state) throw Error('missing state');
      return state;
    };
    const makeComposition = async (resuming: boolean) => {
      const live = await resolveLiveTestModel();
      const factory = createLocalTaskCompositionFactory({
        loadState: s => runtime.store.load(s),
        bindCompletionVerifier: verify => runtime.bindLocalCompletionVerifier(verify),
        prepare: async () => ({ local, cwd: root, sessionRoot: join(owner.root, 'harness-sessions') }),
        scheduler, model: live.model,
        executorOptions: { ...live.options, maxToolCallsPerTurn: 20,
          approval: async exec => {
            log('tool-start', { name: exec.name, activeLeases: scheduler.activeCount });
            expect(scheduler.activeCount).toBe(1);
            if (!resuming) { announceTool(); await toolBarrier; }
            return { kind: 'allow' };
          },
        },
      });
      const state = await get();
      composition = await factory({
        scope, goal: task, loadState: () => runtime.store.load(scope),
        transition: async (_state, mutations) => (await runtime.commitMutations(scope, mutations)).state,
        transitionStep: async (_state, role, mutations) => (await runtime.commitWorkerStepMutations(scope, role, mutations)).state,
        handleOutput: (state, role, output) => runtime.handleWorkerOutput(state, role, output),
        buildChannelContext: (state, role) => runtime.workerStepChannelContextFor(state, role),
        ...(resuming ? { resume: { state, actionId, receipt: canonicalReceipt! } } : {}),
      });
      log('composition-created', { resuming, activeLeases: scheduler.activeCount });
      expect(scheduler.activeCount).toBe(0);
      if (resuming) {
        const receipt = canonicalReceipt!;
        await runtime.commitMessage(scope, {
          msgId: `human-gate-resumed:${actionId}`, channelId: 'main', fromRole: 'COORDINATOR', type: 'announce',
          payload: { kind: 'human_gate_resumed', actionId, gateId: receipt.gateId, resumeSessionId: receipt.resumeSessionId, workerResumes: receipt.workerResumes },
          display: 'Fixture Leader continuation resumed.', ts: Date.now(),
        });
      }
      return composition;
    };
    const assignment = { workerId: 'lru-coder', role: 'CODER', subtaskId: 'lru' };
    const shape = Annotation.Root({ phase: Annotation() });
    const graph = new StateGraph(shape)
      .addNode('first', async () => {
        log('dispatch-initial');
        const c = await makeComposition(false);
        await c.workerRuntime.runOne(await get(), assignment);
        expect((await get()).workers[0]?.status).toBe('paused');
        return { phase: 'paused' };
      })
      .addNode('gate', async () => {
        log('gate-enter');
        const resume = interrupt({ gateId });
        if (resume.actionId !== actionId || !canonicalReceipt || (await get()).humanGate) throw Error('canonical resolution required');
        return { phase: 'resolved' };
      })
      .addNode('continued', async () => {
        log('dispatch-resumed');
        const c = await makeComposition(true);
        const state = await c.workerRuntime.runOne(await get(), assignment);
        expect(state.workers[0]?.status).toBe('done');
        expect(state.workers[0]?.worktree).toBeUndefined();
        await c.suspend(); composition = undefined;
        return { phase: 'finished' };
      })
      .addEdge(START, 'first').addEdge('first', 'gate').addEdge('gate', 'continued').addEdge('continued', END)
      .compile({ checkpointer: saver });
    if (mode === 'initial') {
      graphCall = graph.invoke({ phase: 'start' }, cfg);
      await Promise.race([firstTool, graphCall!.then(() => { throw Error('no tool reached'); })]);
      log('pause-requested');
      const pausePromise = composition!.workerRuntime.requestPause({ scope, actionId: 'graph-native-pause', reason: 'iteration_limit', mode: 'human_gate' });
      releaseTool();
      const pause = await pausePromise;
      expect(pause.workers).toHaveLength(1);
      expect(pause.workers[0]?.status).toBe('paused');
      const refs = pause.workers.flatMap(w => w.safePointRef ? [w.safePointRef] : []);
      const gate = materializeHumanGate({ triggerMsgId: 'graph-native-pause', triggerTs: 1, reason: 'iteration_limit', options: ['continue'], phase: 'coding' }, refs);
      await runtime.commitMutations(scope, [setMutation('humanGate', gate)]);
      log('gate-durable', { activeLeases: scheduler.activeCount, refs: refs.length });
      expect(scheduler.activeCount).toBe(1);
      await composition!.workerRuntime.completePause(pause);
      expect(scheduler.activeCount).toBe(0);
      await composition!.suspend(); composition = undefined;
      log('composition-suspended', { activeLeases: scheduler.activeCount });
      const result: any = await graphCall;
      expect(result.__interrupt__).toHaveLength(1);
      expect(readFileSync(join(root, 'lru-cache.cjs'), 'utf8')).toContain('module.exports = {}');
      evidence.pause = pause;
    } else if (mode === 'inspect') {
      const before = allEvents().filter(e => e.event.startsWith('dispatch-') || e.event === 'tool-start').length;
      const snapshot = await graph.getState(cfg);
      expect(snapshot.next).toEqual(['gate']);
      expect((await get()).workers[0]?.status).toBe('paused');
      expect(allEvents().filter(e => e.event.startsWith('dispatch-') || e.event === 'tool-start').length).toBe(before);
      evidence.pending = snapshot.next;
    } else if (mode === 'graph-only-duplicate') {
      const before = allEvents().filter(e => e.event.startsWith('dispatch-') || e.event === 'tool-start').length;
      expect((await graph.getState(cfg)).next).toEqual([]);
      await graph.invoke(new Command({ resume: { actionId } }), cfg);
      expect(allEvents().filter(e => e.event.startsWith('dispatch-') || e.event === 'tool-start').length).toBe(before);
      evidence.scope = 'Graph-only no-op after completion; production D9 replay still fails';
    } else {
      const response = await createPostMessage(runtime)(new Request('http://localhost/api/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...scope, channelId: 'main', msgId: actionId, display: `/resolve-gate ${gateId} continue` }),
      }));
      expect(response.status).toBe(202);
      expect((await response.json()).action.status).toBe('applied');
      expect(canonicalReceipt?.workerResumes).toHaveLength(1);
      evidence.resolution = canonicalReceipt;
      if (mode === 'resolve') {
        expect((await graph.getState(cfg)).next).toEqual(['gate']);
        expect((await get()).workers[0]?.status).toBe('paused');
        expect(allEvents().filter(e => e.event === 'dispatch-resumed')).toHaveLength(0);
      } else {
        const before = allEvents().filter(e => e.event.startsWith('dispatch-') || e.event === 'tool-start').length;
        graphCall = graph.invoke(new Command({ resume: { actionId } }), cfg);
        await graphCall;
        expect((await graph.getState(cfg)).next).toEqual([]);
        if (mode === 'duplicate') expect(allEvents().filter(e => e.event.startsWith('dispatch-') || e.event === 'tool-start').length).toBe(before);
        expect((await get()).messages.filter(m => m.msgId === actionId)).toHaveLength(1);
        expect((await get()).messages.filter(m => m.msgId === `human-gate-resumed:${actionId}`)).toHaveLength(1);
    const receipts: WorkspaceCommandReceipt[] = [];
    const requests: { inputHash: string; request: WorkspaceCommandRequest }[] = [];
    for (const reference of await objects.references()) {
      const record = (await objects.get(reference.valueHash)) as Partial<WorkspaceCommandReceipt>;
      const prepared = record as unknown as {
        schemaVersion?: string;
        inputHash: string;
        request: WorkspaceCommandRequest;
      };
      if (prepared.schemaVersion === 'workspace-command-prepared-v1')
        requests.push({ inputHash: prepared.inputHash, request: prepared.request });
      if (record.schemaVersion === 'workspace-command-receipt-v1')
        receipts.push(record as WorkspaceCommandReceipt);
    }
    evidence.commandReceipts = receipts;
    evidence.commandRequests = requests;
    const passes = [];
    for (const receipt of receipts) {
      const stdout = (await objects.getBytes(receipt.stdoutRef)).toString('utf8');
      const stderr = (await objects.getBytes(receipt.stderrRef)).toString('utf8');
      passes.push({ receipt, stdout, stderr });
    }
    evidence.runs = passes;
    const passed = passes.find(
      (run) =>
        requests.some(
          (prepared) =>
            prepared.inputHash === run.receipt.inputHash &&
            prepared.request.toolId === 'node' &&
            JSON.stringify(prepared.request.argv) ===
              JSON.stringify(['--test', '--test-reporter=tap', '@input/lru-cache.test.cjs']) &&
            JSON.stringify(prepared.request.inputVersion) ===
              JSON.stringify(run.receipt.inputVersion),
        ) &&
        run.receipt.exitCode === 0 &&
        run.receipt.stage === 'exited' &&
        run.receipt.quiescent &&
        run.stdout.includes('# tests 5') &&
        run.stdout.includes('# pass 5') &&
        run.stdout.includes('# fail 0') &&
        run.stdout.includes('# skipped 0') &&
        run.stdout.includes('# cancelled 0'),
    );
    expect(passed).toBeDefined();
    if (!passed) throw Error('no trusted passing command');
    const registered = (await control.snapshot()).roots[0];
    if (!registered) throw Error('missing root');
    await versions.verify(
      passed.receipt.inputVersion,
      { ...scope, rootId: grant.rootId, policyHash: grant.policyHash },
      localRootBinding(registered),
      async () => {
        await controller.assertGrant(scope, grant.grantId);
        return true;
      },
    );
        evidence.generatedSourceHash = hash(readFileSync(join(root, 'lru-cache.cjs')));
      }
    }
    expect(scheduler.activeCount).toBe(0);
    expect(readFileSync(join(root, 'lru-cache.test.cjs'), 'utf8')).toBe(tests);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('FIXED_FAKE_SECRET=not-a-real-credential\n');
    evidence.workers = (await get()).workers;
    evidence.passed = true;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    releaseTool();
    if (composition) {
      // Close through natural safe points before disposing an active composition.
      await composition.workerRuntime.awaitRoleSafePoint('CODER');
      if (graphCall) await Promise.allSettled([graphCall]);
      await composition.suspend();
    }
    saver.db.close();
    await owner.release();
    evidence.endedAt = new Date().toISOString();
    evidence.activeLeasesAfter = scheduler.activeCount;
    writeFileSync(join(output, `${mode}-${Date.now()}.json`), JSON.stringify(evidence, null, 2));
    log('process-finished', { passed: evidence.passed === true, activeLeases: scheduler.activeCount });
  }
}, 180000);
