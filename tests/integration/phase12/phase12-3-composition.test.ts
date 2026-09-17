// Only external LLM responses are scripted. Every tool result is checked;
// filesystem, grant, registry, Harness, MCP, D4/D16 and archiving are real.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInitialAppState, latestCoordinationLedger, setMutation } from '@agora/core-domain';
import { GlobalScheduler, type HumanGateLifecyclePort } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createLocalTaskCompositionFactory } from '../../../apps/web/src/server/local-task-composition';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import {
  type TaskComposition,
  TaskOrchestrationRuntime,
} from '../../../apps/web/src/server/task-orchestration-runtime';
import { LocalBindingCoordinator } from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { LocalGrantController } from '../../../packages/runtime/sandbox/src/local-grant-controller';
import { LocalRootCoordinator } from '../../../packages/runtime/sandbox/src/local-root-coordinator';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { projectedInputText } from '../../evals/core/projected-input';

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

const implementation = `class LRUCache {
  constructor(capacity, ttlMs = Infinity) { this.capacity=capacity; this.ttlMs=ttlMs; this.items=new Map(); }
  get(key) { const item=this.items.get(key); if(!item) return undefined; if(Date.now()>=item.expires) { this.items.delete(key); return undefined; } this.items.delete(key); this.items.set(key,item); return item.value; }
  set(key,value) { this.items.delete(key); this.items.set(key,{value,expires:Date.now()+this.ttlMs}); while(this.items.size>this.capacity) this.items.delete(this.items.keys().next().value); }
  delete(key) { return this.items.delete(key); }
}
module.exports={LRUCache};
`;
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class LocalAdapter extends LlmAdapter {
  readonly entered = signal();
  readonly released = signal();
  readonly roles = new Set<string>();
  sequence = 0;
  applied = 0;
  resumed = false;
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const view = JSON.parse(projectedInputText(options)) as {
      role: string;
      slices: Record<string, unknown>;
    };
    this.roles.add(view.role);
    if (view.role === 'PM') {
      yield* textChunks(
        JSON.stringify([
          {
            id: 'req-lru',
            story: 'Fixed LRU implementation',
            acceptance: ['All five original tests pass unchanged'],
            nonGoals: [],
          },
        ]),
      );
      return;
    }
    if (view.role === 'ARCHITECT') {
      yield* textChunks(
        JSON.stringify({
          architecture: { modules: ['LRUCache'] },
          conventions: { testFiles: ['lru-cache.test.cjs'] },
        }),
      );
      return;
    }
    const results = options.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool-result');
    if (view.role === 'CODER') {
      if (results.length === 0) {
        yield* this.tool('workspace_read', { path: 'lru-cache.cjs' });
        return;
      }
      if (results.length === 1) {
        const read = toolResult(options, 'workspace_read') as {
          content: string;
          version: unknown;
          readReceiptId: string;
        };
        expect(read.content).toContain('module.exports = {}');
        this.entered.resolve();
        await this.released.promise;
        yield* this.tool('workspace_apply', {
          changes: [
            {
              path: 'lru-cache.cjs',
              expected: read.version,
              readReceiptId: read.readReceiptId,
              content: implementation,
              encoding: 'utf8',
            },
          ],
          dependencies: [],
        });
        return;
      }
      const applied = toolResult(options, 'workspace_apply') as { stage: string };
      expect(applied.stage).toBe('applied');
      this.applied++;
      this.resumed = true;
      yield* textChunks('Resumed after the Leader decision; original tests preserved.');
      return;
    }
    if (results.length === 0) {
      yield* this.tool('workspace_read', { path: 'lru-cache.cjs' });
      return;
    }
    expect((toolResult(options, 'workspace_read') as { content: string }).content).toBe(
      implementation,
    );
    yield* textChunks(
      view.role === 'REVIEWER'
        ? JSON.stringify([
            {
              id: 'fixed-local-review',
              kind: 'verdict',
              verdict: 'approved',
              summary: 'Inspected the same validated LRU source.',
            },
          ])
        : 'Inspected fixed source; trusted runtime must run the original five tests.',
    );
  }
  *tool(name: string, args: Record<string, unknown>): Iterable<StreamChunk> {
    const id = CallId(`local-call-${++this.sequence}`),
      argumentsText = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id, name, arguments: argumentsText },
    };
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
function* textChunks(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function toolResult(options: GenerateOptions, name: string): unknown {
  const content = options.messages.flatMap((m) => m.content);
  const call = content.filter((b) => b.type === 'tool-call' && b.name === name).at(-1);
  if (call?.type !== 'tool-call') throw Error('missing tool call');
  const result = content.find((b) => b.type === 'tool-result' && b.toolCallId === call.id);
  if (result?.type !== 'tool-result') throw Error('missing tool result');
  const text = result.content.find((b) => b.type === 'text');
  if (text?.type !== 'text') throw Error('missing result content');
  return JSON.parse(text.text);
}
it('runs local composition through a real D4 Fork and D16 fixed artifact', async () => {
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const identity = lstatSync(base);
  const root = join(base, 'project');
  mkdirSync(root);
  writeFileSync(
    join(root, 'lru-cache.cjs'),
    '// Fixed incomplete LRU fixture.\nmodule.exports = {};\n',
  );
  writeFileSync(join(root, 'lru-cache.test.cjs'), tests);
  writeFileSync(join(root, '.env'), 'FIXED_FAKE_SECRET=not-a-real-credential\n');
  const owner = await acquireState(join(base, 'state'));
  const evidence: Record<string, unknown> = {
    base,
    startedAt: new Date().toISOString(),
    task,
    testSource: tests,
    provider: 'deterministic-external-llm-adapter',
    scope: 'real composition, native MCP, official Harness Fork and D16',
  };
  const compositions: TaskComposition[] = [];
  let failed: unknown;
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
      execFileSync('/usr/bin/clang', [
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
    const scope = { projectId: 'fixed-lru-project', taskId: 'fixed-lru-task' };
    const runtime = new MessageRuntime(
      join(owner.root, 'tasks'),
      new ChannelStream(),
      DEFAULT_ROSTER,
    );
    await runtime.initializeState(
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
    const proposal = await controller.prepareGrant(scope, {
      selectionRef: 'fixed-lru-selection',
      path: root,
    });
    const body = {
      ...scope,
      actionId: 'fixed-lru-grant',
      expectedRevision: proposal.proposal.expectedRevision,
      selectionRef: 'fixed-lru-selection',
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
    const grant = (await control.snapshot()).grants[0];
    if (!grant) throw Error('missing canonical grant');
    const roots = await LocalRootCoordinator.open(owner, control, {
      inspector: helper('local-root-inspection'),
      initializer: helper('local-root-initialization'),
    });
    await roots.initialize({
      ...scope,
      actionId: 'fixed-lru-initialize',
      rootId: grant.rootId,
      grantId: grant.grantId,
      expectedRevision: (await control.snapshot()).revision,
    });
    const objects = await LocalControlObjects.open(owner);
    const versions = new LocalVersionStore(objects, helper('local-file-transaction'));
    const localOptions = {
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
      verifyGrant: (s: typeof scope, id: string) => controller.assertGrant(s, id),
      grantForAssignment: async () => grant.grantId,
    };
    const adapter = new LocalAdapter();
    const scheduler = new GlobalScheduler({ cap: 1 });
    const sessionRoot = join(
      owner.root,
      'projects',
      scope.projectId,
      'tasks',
      scope.taskId,
      'harness-sessions',
    );
    const localFactory = createLocalTaskCompositionFactory({
      loadState: (s) => runtime.store.load(s),
      bindCompletionVerifier: (verify) => runtime.bindLocalCompletionVerifier(verify),
      scheduler,
      executorOptions: { adapter, provider: 'fixed-local-composition', deepseek: false },
      prepare: async (s, versionForAssignment) => {
        expect(s).toEqual(scope);
        return {
          local: await LocalWorkspaceSessions.create({ ...localOptions, versionForAssignment }),
          cwd: root,
          sessionRoot,
        };
      },
    });
    const factory = createWebTaskCompositionFactory({ localFactory });
    let lifecycle: HumanGateLifecyclePort | undefined;
    const bindLifecycle = runtime.bindHumanGateLifecyclePort.bind(runtime);
    runtime.bindHumanGateLifecyclePort = (port) => {
      lifecycle = port;
      bindLifecycle(port);
    };
    const tasks = new TaskOrchestrationRuntime(runtime, async (input) => {
      const composition = await factory(input);
      compositions.push(composition);
      const runOne = composition.workerRuntime.runOne.bind(composition.workerRuntime);
      composition.workerRuntime.runOne = async (...args) => {
        try {
          return await runOne(...args);
        } catch (error) {
          evidence.workerFailure =
            error instanceof Error
              ? { message: error.message, stack: error.stack, cause: String(error.cause) }
              : String(error);
          throw error;
        }
      };
      return composition;
    });
    const state = async () => {
      const s = await runtime.store.load(scope);
      if (!s) throw Error('missing state');
      return s;
    };
    // The ordinary project-start UI belongs to 12.6. This approved fixture
    // enters via the existing durable Leader gate with an empty active cohort.
    await runtime.commitMutations(scope, [
      setMutation('humanGate', {
        gateId: 'human-gate:fixed-local-start',
        reason: 'iteration_limit',
        options: ['continue'],
        phase: 'clarifying',
        openedTs: Date.now(),
        safePointRefs: [],
      }),
    ]);
    const started = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: 'fixed-local-start',
          display: '/resolve-gate human-gate:fixed-local-start continue',
        }),
      }),
    );
    const startedBody = await started.json();
    expect(started.status, JSON.stringify(startedBody)).toBe(202);
    await adapter.entered.promise;
    if (!lifecycle) throw Error('missing actual lifecycle port');
    const pausing = lifecycle.suspend(scope, {
      triggerMsgId: 'fixed-coder-pause',
      triggerTs: Date.now(),
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'coding',
    });
    adapter.released.resolve();
    await pausing;
    await tasks.waitForIdle(scope);
    evidence.firstSummary = await tasks.summary(scope);
    evidence.firstState = await state();
    const gate = (await state()).humanGate;
    expect(gate, JSON.stringify(evidence.firstSummary)).toBeDefined();
    expect(gate?.reason).toBe('iteration_limit');
    expect(gate?.safePointRefs).toHaveLength(1);
    expect(scheduler.activeCount).toBe(0);
    expect((await state()).workers.filter((w) => w.status === 'paused')).toHaveLength(1);
    const leader = async (msgId: string, display: string) => {
      const result = await createPostMessage(runtime)(
        new Request('http://localhost/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...scope, channelId: 'main', msgId, display }),
        }),
      );
      const body = await result.json();
      evidence[msgId] = body;
      expect(result.status, JSON.stringify(body)).toBe(202);
      await tasks.waitForIdle(scope);
    };
    await leader('resume-fixed-coder', `/resolve-gate ${gate?.gateId} continue`);
    evidence.reviewSummary = await tasks.summary(scope);
    evidence.reviewState = await state();
    const finalGate = (await state()).humanGate;
    expect(finalGate?.reason, JSON.stringify(evidence.reviewSummary)).toMatch(
      /^completion_confirmation:/,
    );
    expect((await state()).testResults).toMatchObject({ passed: true, total: 5, failed: 0 });
    expect(scheduler.activeCount).toBe(0);
    await leader(
      'approve-fixed-completion',
      `/resolve-gate ${finalGate?.gateId} approve_completion`,
    );
    evidence.finalSummary = await tasks.summary(scope);
    evidence.finalState = await state();
    const summary = await tasks.summary(scope);
    expect(summary, JSON.stringify(summary)).toMatchObject({
      runStatus: 'completed',
      phase: 'done',
      testResults: { passed: true, total: 5, failed: 0 },
    });
    expect(latestCoordinationLedger(await state())?.progress.isRequestSatisfied.answer).toBe(true);
    expect((await control.snapshot()).claims.every((c) => c.status === 'released')).toBe(true);
    expect(summary?.artifactPath).not.toBe(root);
    if (!summary?.artifactPath) throw Error('missing artifact');
    expect(readFileSync(join(summary.artifactPath, 'lru-cache.cjs'), 'utf8')).toBe(implementation);
    expect(readFileSync(join(summary.artifactPath, 'lru-cache.test.cjs'), 'utf8')).toBe(tests);
    expect(readFileSync(join(root, 'lru-cache.test.cjs'), 'utf8')).toBe(tests);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
      'FIXED_FAKE_SECRET=not-a-real-credential\n',
    );
    expect([...adapter.roles].sort()).toEqual(['ARCHITECT', 'CODER', 'PM', 'REVIEWER', 'TESTER']);
    expect(adapter.applied).toBe(1);
    expect(adapter.resumed).toBe(true);
    const trace = await new HarnessTraceReader(owner.root).read(scope);
    const coderChild = trace.sessions.filter(
      (s) => s.role === 'CODER' && s.parentSessionId !== undefined,
    );
    expect(coderChild).toHaveLength(1);
    expect(coderChild[0]?.sessionId).toMatch(/^human-gate-resume:resume-fixed-coder:/);
    evidence.trace = trace;
    expect(scheduler.activeCount).toBe(0);
    evidence.passed = true;
  } catch (error) {
    failed = error;
    evidence.failure = error instanceof Error ? error.message : 'unknown';
  }
  {
    for (const composition of compositions) await composition.dispose();
    await owner.release();
    const files: { path: string; sha256: string }[] = [];
    const scan = (directory: string, prefix = '') => {
      for (const name of readdirSync(directory)) {
        const file = join(directory, name),
          stat = lstatSync(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) scan(file, join(prefix, name));
        else if (stat.isFile())
          files.push({ path: join(prefix, name), sha256: hash(readFileSync(file)) });
        else throw Error('unexpected live fixture object');
      }
    };
    scan(base);
    evidence.files = files;
    evidence.sources = Object.fromEntries(
      [
        ...readdirSync('packages/runtime/sandbox/src')
          .filter((name) => name.startsWith('local-') || name.startsWith('workspace-'))
          .map((name) => `packages/runtime/sandbox/src/${name}`),
        ...readdirSync('packages/runtime/sandbox/native')
          .filter((name) => name.startsWith('local-'))
          .map((name) => `packages/runtime/sandbox/native/${name}`),
        'packages/core/orchestration/src/worker-runtime.ts',
        'packages/runtime/executor/src/harness-executor.ts',
        'packages/runtime/executor/src/project.ts',
        'packages/tools/bridge/src/local-workspace-bridge.ts',
        'packages/tools/fs/src/workspace-server.ts',
        'packages/roles/definitions/src/local-runtime-contract.ts',
        'apps/web/src/server/local-workspace-executor.ts',
        'apps/web/src/server/local-task-composition.ts',
        'apps/web/src/server/local-validation.ts',
        'apps/web/src/server/task-composition.ts',
        'apps/web/src/server/task-orchestration-runtime.ts',
        'tests/integration/phase12/phase12-3-composition.test.ts',
      ].map((path) => [path, hash(readFileSync(path))]),
    );
    const folder = resolve('test-outputs/reviews/task123-composition-evidence');
    mkdirSync(folder, { recursive: true });
    const target = join(folder, `${basename(base)}.json`);
    writeFileSync(target, JSON.stringify(evidence, null, 2));
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' }),
      mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' }),
      current = lstatSync(base),
      before = statfsSync(base);
    if (
      handles.status !== 1 ||
      handles.stdout ||
      handles.stderr ||
      mounts.status !== 0 ||
      mounts.stdout.includes(base) ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.isSymbolicLink()
    )
      throw Error('live_fixture_cleanup_unproven');
    rmSync(base, { recursive: true });
    const after = statfsSync('/private/tmp');
    evidence.cleanup = {
      deleted: true,
      ownerReleased: true,
      noHandles: true,
      noMounts: true,
      availableBytesDelta: after.bavail * after.bsize - before.bavail * before.bsize,
    };
    writeFileSync(target, JSON.stringify(evidence, null, 2));
  }
  if (failed) throw failed;
}, 360000);
