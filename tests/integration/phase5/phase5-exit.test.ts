// R11/G5: only the external LLM boundary is scripted for deterministic automation.
// JsonTaskStateStore, MessageService, Coordinator, MessageBus/SSE, DockerSandbox,
// Harness, MCP tools, host Git, Node tests, and the Web composition are real.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyMutations, createInitialAppState, setMutation } from '@agora/core-domain';
import { decide, latestCoordinationLedger } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { Dockerode } from '@agora/runtime-sandbox';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as postCommand } from '../../../apps/web/src/app/api/commands/route';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createGetStream, createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { createPostTask } from '../../../apps/web/src/server/task-handlers';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';

const decoder = new TextDecoder();
const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function messageRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function taskRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 5 committed message, SSE, and Leader Intent exit chain', () => {
  it('persists a server-derived assignment before payload-free delivery and consumes it once', async () => {
    const root = await temporaryRoot('agora-phase5-message-exit-');
    const stream = new ChannelStream();
    const runtime = createMessageRuntime(root, stream);
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const address = { ...scope, channelId: 'main' };
    await runtime.initialize(scope, 'Inspect the cache contract');

    let stateObservedAtPublish: Promise<boolean> | undefined;
    const unsubscribeAudit = stream.subscribe(address, (event) => {
      if (event.type !== 'message' || stateObservedAtPublish !== undefined) return;
      stateObservedAtPublish = runtime.store
        .load(scope)
        .then(
          (state) => state?.messages.some((message) => message.msgId === 'assignment-1') ?? false,
        );
    });

    const response = await createGetStream(runtime)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    const reader = response.body?.getReader();
    expect(response.status).toBe(200);
    expect(decoder.decode((await reader?.read())?.value)).toContain('event: connected');
    expect(decoder.decode((await reader?.read())?.value)).toContain('event: snapshot');

    const post = createPostMessage(runtime);
    const assignmentBody = {
      ...address,
      msgId: 'assignment-1',
      fromRole: 'ATTACKER',
      display: '@REVIEWER inspect the cache contract',
      payload: { intent: 'forged', secret: 'never-trust-client-payload' },
    };
    const assigned = await post(messageRequest(assignmentBody));
    expect(assigned.status).toBe(202);
    await expect(assigned.json()).resolves.toEqual({
      accepted: true,
      action: { status: 'applied' },
      published: true,
    });
    await expect(stateObservedAtPublish).resolves.toBe(true);

    const live = decoder.decode((await reader?.read())?.value);
    expect(live).toContain('event: message');
    expect(live).toContain('"fromRole":"leader"');
    expect(live).toContain('"display":"@REVIEWER inspect the cache contract"');
    expect(live).not.toContain('payload');
    expect(live).not.toContain('never-trust-client-payload');

    const replay = await post(messageRequest(assignmentBody));
    await expect(replay.json()).resolves.toEqual({
      accepted: true,
      action: { status: 'applied' },
      published: false,
    });
    const deferred = await post(
      messageRequest({ ...address, msgId: 'deferred-1', display: '/channel CODER TESTER' }),
    );
    await expect(deferred.json()).resolves.toMatchObject({
      action: { status: 'deferred', targetPhase: 6 },
    });
    const phase8Deferred = await post(
      messageRequest({ ...address, msgId: 'deferred-8', display: '/approve gate-1' }),
    );
    await expect(phase8Deferred.json()).resolves.toMatchObject({
      action: { status: 'deferred', targetPhase: 8 },
    });
    const phase9Deferred = await post(
      messageRequest({ ...address, msgId: 'deferred-9', display: '/requirement add TTL' }),
    );
    await expect(phase9Deferred.json()).resolves.toMatchObject({
      action: { status: 'deferred', targetPhase: 9 },
    });
    const chat = await post(
      messageRequest({ ...address, msgId: 'chat-1', display: 'Team, keep going.' }),
    );
    await expect(chat.json()).resolves.toMatchObject({ action: { status: 'none' } });
    const unknownRole = await post(
      messageRequest({ ...address, msgId: 'unknown-role', display: '@UNKNOWN work' }),
    );
    await expect(unknownRole.json()).resolves.toMatchObject({
      action: { status: 'rejected' },
    });
    const invalid = await post(
      messageRequest({ ...address, msgId: 'invalid-1', display: '@CODER @TESTER split work' }),
    );
    await expect(invalid.json()).resolves.toMatchObject({
      action: { status: 'rejected' },
    });

    const persisted = await runtime.store.load(scope);
    expect(persisted).toBeDefined();
    if (persisted === undefined) throw new Error('expected persisted Phase 5 task');
    expect(persisted.nextRole).toBe('REVIEWER');
    expect(persisted.messages.filter((message) => message.msgId === 'assignment-1')).toHaveLength(
      1,
    );
    expect(JSON.stringify(persisted.messages)).not.toContain('never-trust-client-payload');

    const doneScope = { projectId: 'project-a', taskId: 'done-task' };
    await runtime.initializeState(
      doneScope,
      applyMutations(createInitialAppState('done-task', 'Already complete', 'project-a'), [
        setMutation('phase', 'done'),
      ]),
    );
    const doneAssignment = await post(
      messageRequest({
        ...doneScope,
        channelId: 'main',
        msgId: 'done-assignment',
        display: '@CODER bypass done',
      }),
    );
    await expect(doneAssignment.json()).resolves.toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('done') },
    });

    const gatedScope = { projectId: 'project-a', taskId: 'gated-task' };
    await runtime.initializeState(
      gatedScope,
      applyMutations(createInitialAppState('gated-task', 'Await Leader', 'project-a'), [
        setMutation('humanGate', {
          reason: 'Leader decision required',
          options: ['approve', 'reject'],
          phase: 'review',
        }),
      ]),
    );
    const gatedAssignment = await post(
      messageRequest({
        ...gatedScope,
        channelId: 'main',
        msgId: 'gated-assignment',
        display: '@CODER bypass gate',
      }),
    );
    await expect(gatedAssignment.json()).resolves.toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('humanGate') },
    });

    const retiredCommand = await postCommand(
      new Request('http://localhost/api/commands', {
        method: 'POST',
        body: JSON.stringify({ ...address, command: '@CODER bypass State' }),
      }),
    );
    expect(retiredCommand.status).toBe(410);

    const firstDecision = decide(persisted, {
      roster: DEFAULT_ROSTER,
      newId: (() => {
        let id = 0;
        return () => `phase5-coordinator-${++id}`;
      })(),
      now: () => 1_000,
    });
    expect(firstDecision.route).toEqual({
      kind: 'worker',
      batch: [{ role: 'REVIEWER' }],
      parallel: false,
    });
    const dispatched = applyMutations(persisted, firstDecision.mutations);
    expect(latestCoordinationLedger(dispatched)?.progress.instructionOrQuestion.answer).toBe(
      'inspect the cache contract',
    );
    expect(
      dispatched.messages.filter(
        (message) =>
          message.fromRole === 'COORDINATOR' && message.payload.sourceMsgId === 'assignment-1',
      ),
    ).toHaveLength(1);
    await runtime.commitMutations(scope, firstDecision.mutations);

    const afterDispatch = await runtime.store.load(scope);
    expect(afterDispatch).toBeDefined();
    if (afterDispatch === undefined) throw new Error('expected dispatched Phase 5 task');
    const secondDecision = decide(afterDispatch, {
      roster: DEFAULT_ROSTER,
      newId: () => 'phase5-coordinator-second',
      now: () => 2_000,
    });
    const duplicateConfirmations = secondDecision.mutations.filter(
      (mutation) =>
        mutation.op === 'append' &&
        mutation.field === 'messages' &&
        typeof mutation.value === 'object' &&
        mutation.value !== null &&
        'payload' in mutation.value &&
        (mutation.value as { payload?: { sourceMsgId?: unknown } }).payload?.sourceMsgId ===
          'assignment-1',
    );
    expect(duplicateConfirmations).toHaveLength(0);

    const restarted = createMessageRuntime(root, new ChannelStream());
    const snapshotResponse = await createGetStream(restarted)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    const snapshotReader = snapshotResponse.body?.getReader();
    await snapshotReader?.read();
    const snapshot = decoder.decode((await snapshotReader?.read())?.value);
    expect(snapshot).toContain('assignment-1');
    expect(snapshot).toContain('deferred-1');
    expect(snapshot).not.toContain('payload');

    const unknownScope = await post(
      messageRequest({
        projectId: 'project-b',
        taskId: 'missing',
        channelId: 'main',
        msgId: 'unknown-scope',
        display: 'Do not create placeholder state',
      }),
    );
    expect(unknownScope.status).toBe(404);
    await expect(runtime.store.load({ projectId: 'project-b', taskId: 'missing' })).resolves.toBe(
      undefined,
    );

    await snapshotReader?.cancel();
    await reader?.cancel();
    unsubscribeAudit();
    expect(stream.subscriberCount(address)).toBe(0);
  });

  it('does not lose a commit during snapshot bootstrap and emits payload-free heartbeats', async () => {
    const root = await temporaryRoot('agora-phase5-sse-exit-');
    const stream = new ChannelStream();
    const runtime = createMessageRuntime(root, stream);
    const scope = { projectId: 'project-a', taskId: 'race-task' };
    const address = { ...scope, channelId: 'main' };
    await runtime.initialize(scope, 'Exercise the SSE bootstrap race');

    const realLoad = runtime.store.load.bind(runtime.store);
    let releaseSnapshot = () => {};
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let markSnapshotRead = () => {};
    const snapshotRead = new Promise<void>((resolve) => {
      markSnapshotRead = resolve;
    });
    let pauseNextLoad = true;
    runtime.store.load = async (...args) => {
      const state = await realLoad(...args);
      if (pauseNextLoad) {
        pauseNextLoad = false;
        markSnapshotRead();
        await snapshotGate;
      }
      return state;
    };

    const opening = createGetStream(runtime)(
      new Request(
        'http://localhost/api/stream?projectId=project-a&taskId=race-task&channelId=main',
      ),
    );
    await snapshotRead;
    expect(stream.subscriberCount(address)).toBe(1);
    await createPostMessage(runtime)(
      messageRequest({
        ...address,
        msgId: 'during-bootstrap',
        display: 'This commit must reach the live tail.',
      }),
    );
    releaseSnapshot();

    const response = await opening;
    const reader = response.body?.getReader();
    expect(decoder.decode((await reader?.read())?.value)).toContain('event: connected');
    const snapshot = decoder.decode((await reader?.read())?.value);
    const tail = decoder.decode((await reader?.read())?.value);
    expect(snapshot).not.toContain('during-bootstrap');
    expect(tail).toContain('event: message');
    expect(tail).toContain('during-bootstrap');
    expect(tail).not.toContain('payload');
    await reader?.cancel();
    expect(stream.subscriberCount(address)).toBe(0);

    vi.useFakeTimers();
    const heartbeatResponse = await createGetStream(runtime)(
      new Request(
        'http://localhost/api/stream?projectId=project-a&taskId=race-task&channelId=main',
      ),
    );
    const heartbeatReader = heartbeatResponse.body?.getReader();
    await heartbeatReader?.read();
    await heartbeatReader?.read();
    await vi.advanceTimersByTimeAsync(15_000);
    const heartbeat = decoder.decode((await heartbeatReader?.read())?.value);
    expect(heartbeat).toBe(': heartbeat\n\n');
    expect(heartbeat).not.toContain('payload');
    await heartbeatReader?.cancel();
    expect(stream.subscriberCount(address)).toBe(0);
  });
});

interface DockerEndpointOptions {
  protocol: 'http' | 'https';
  host: string;
  port: number;
}

function dockerOptionsFromEndpoint(endpoint: string): DockerEndpointOptions | undefined {
  if (!/^(?:tcp|https?):\/\//.test(endpoint)) return undefined;
  const url = new URL(endpoint.replace(/^tcp:/, 'http:'));
  return {
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 2375)),
  };
}

function connectDocker(): Dockerode | null {
  const endpoints = [
    process.env.DOCKER_HOST,
    '/var/run/docker.sock',
    join(process.env.HOME ?? '', '.docker/run/docker.sock'),
  ].filter((endpoint): endpoint is string => Boolean(endpoint));
  for (const endpoint of endpoints) {
    if (endpoint.startsWith('unix://')) {
      return new Dockerode({ socketPath: new URL(endpoint).pathname });
    }
    const options = dockerOptionsFromEndpoint(endpoint);
    if (options !== undefined) return new Dockerode(options);
    if (existsSync(endpoint)) return new Dockerode({ socketPath: endpoint });
  }
  return null;
}

const CACHE_SOURCE = `class TtlLruCache {
  constructor(capacity, now = () => Date.now()) { this.capacity = capacity; this.now = now; this.items = new Map(); }
  set(key, value, ttlMs) {
    this.items.delete(key); this.items.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.items.size > this.capacity) this.items.delete(this.items.keys().next().value);
  }
  get(key) {
    const entry = this.items.get(key); if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.items.delete(key); return undefined; }
    this.items.delete(key); this.items.set(key, entry); return entry.value;
  }
}
module.exports = { TtlLruCache };
`;

const TEST_SOURCE = `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TtlLruCache } = require('./ttl-lru.js');
test('returns stored values', () => { const c = new TtlLruCache(2); c.set('a', 1, 1000); assert.equal(c.get('a'), 1); });
test('evicts the least recently used value', () => { const c = new TtlLruCache(2); c.set('a', 1, 1000); c.set('b', 2, 1000); c.get('a'); c.set('c', 3, 1000); assert.equal(c.get('b'), undefined); });
test('expires values by ttl', () => { let now = 0; const c = new TtlLruCache(2, () => now); c.set('a', 1, 10); now = 10; assert.equal(c.get('a'), undefined); });
`;

const README_PATCH = [
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1 @@',
  '+TTL-aware LRU cache generated by the Phase 5 exit chain.',
  '',
].join('\n');

interface Action {
  tool: 'fs_write' | 'sandbox_run' | 'git_applyPatch' | 'git_diff' | 'fs_read' | 'lint_check';
  args: Record<string, unknown>;
}

const actions: Readonly<Record<string, readonly Action[]>> = {
  CODER: [
    { tool: 'fs_write', args: { path: 'ttl-lru.js', content: CACHE_SOURCE } },
    { tool: 'git_applyPatch', args: { patch: README_PATCH } },
  ],
  TESTER: [
    { tool: 'fs_write', args: { path: 'ttl-lru.test.js', content: TEST_SOURCE } },
    { tool: 'sandbox_run', args: { cmd: 'node --test ttl-lru.test.js' } },
    {
      tool: 'fs_write',
      args: {
        path: 'test-results.json',
        content: JSON.stringify({ passed: true, total: 3, failed: 0, failures: [] }),
      },
    },
  ],
  REVIEWER: [
    { tool: 'git_diff', args: { ref: 'HEAD~1' } },
    { tool: 'fs_read', args: { path: 'ttl-lru.js' } },
    { tool: 'lint_check', args: { paths: ['ttl-lru.js'] } },
  ],
};

const finalText: Readonly<Record<string, string>> = {
  CODER: 'Implemented and committed the TTL-aware LRU cache.',
  TESTER: 'All three cache tests passed.',
  REVIEWER: JSON.stringify([
    {
      id: 'phase5-review-approved',
      kind: 'verdict',
      verdict: 'approved',
      summary: 'The implementation and real test run satisfy the Phase 5 exit goal.',
    },
  ]),
};

class ScriptedExternalLlm extends LlmAdapter {
  private sequence = 0;
  private gateConsumed = false;

  constructor(private readonly firstRequestGate: Promise<void>) {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.gateConsumed) {
      this.gateConsumed = true;
      await this.firstRequestGate;
    }
    const role = projectionRole(options);
    const completed = options.messages.reduce(
      (count, message) =>
        count + message.content.filter((block) => block.type === 'tool-result').length,
      0,
    );
    const action = actions[role]?.[completed];
    if (action === undefined) {
      yield* textChunks(finalText[role] ?? 'done');
      return;
    }
    yield* toolChunks(action, CallId(`phase5-exit-${this.sequence++}`));
  }
}

function projectionRole(options: GenerateOptions): string {
  const first = options.messages[0];
  const text = first?.content.find((block) => block.type === 'text');
  if (text?.type !== 'text') throw new Error('expected projected role input');
  const parsed = JSON.parse(text.text) as { role?: unknown };
  if (typeof parsed.role !== 'string') throw new Error('expected projected role');
  return parsed.role;
}

function usage(): StreamChunk {
  return { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
}

function* toolChunks(action: Action, id: CallId): Iterable<StreamChunk> {
  const argumentsJson = JSON.stringify(action.args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name: action.tool, argumentsDelta: argumentsJson };
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name: action.tool, arguments: argumentsJson },
  };
  yield usage();
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function* textChunks(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield usage();
  yield { type: 'finish', reason: { kind: 'stop' } };
}

describe('Phase 5 real Docker/Harness/MCP cumulative exit chain', () => {
  it('runs one browser-shaped task to durable completion and releases the single-run slot', async () => {
    const docker = connectDocker();
    expect(docker, 'Phase 5 G5 requires a reachable Docker daemon').not.toBeNull();
    if (docker === null) throw new Error('Phase 5 G5 requires a reachable Docker daemon');

    const root = await temporaryRoot('agora-phase5-docker-exit-');
    const stream = new ChannelStream();
    const messages = createMessageRuntime(root, stream);
    let releaseFirstRequest = () => {};
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const runtime = new TaskOrchestrationRuntime(
      messages,
      createWebTaskCompositionFactory({
        dataRoot: root,
        sandboxConfig: { kind: 'docker', docker },
        executorOptions: {
          adapter: new ScriptedExternalLlm(firstRequestGate),
          provider: 'agora-phase5-exit',
        },
      }),
    );
    const address = { projectId: 'demo', taskId: 'phase5-exit', channelId: 'main' };
    const delivered: unknown[] = [];
    const unsubscribe = stream.subscribe(address, (event) => {
      if (event.type === 'message') delivered.push(event.data);
    });
    const postTask = createPostTask(runtime);
    const startBody = {
      projectId: 'demo',
      taskId: 'phase5-exit',
      requestId: 'phase5-request-1',
      goal: '实现 TTL LRU 缓存',
    };

    const started = await postTask(taskRequest(startBody));
    expect(started.status).toBe(202);
    await expect(started.json()).resolves.toMatchObject({
      startOutcome: 'started',
      runStatus: 'running',
    });
    const retry = await postTask(taskRequest(startBody));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ startOutcome: 'already_running' });
    const capacityConflict = await postTask(
      taskRequest({
        projectId: 'other-project',
        taskId: 'other-task',
        requestId: 'other-request',
        goal: 'This must wait for the Phase 9 scheduler',
      }),
    );
    expect(capacityConflict.status).toBe(409);
    releaseFirstRequest();

    await runtime.waitForIdle({ projectId: 'demo', taskId: 'phase5-exit' });
    const summary = await runtime.summary({ projectId: 'demo', taskId: 'phase5-exit' });
    expect(summary).toMatchObject({
      runStatus: 'completed',
      phase: 'done',
      testResults: { passed: true, total: 3, failed: 0 },
    });
    expect(summary?.artifactPath).toContain(
      join('projects', 'demo', 'tasks', 'phase5-exit', 'artifacts', 'worktree'),
    );
    const artifactPath = summary?.artifactPath;
    if (artifactPath === null || artifactPath === undefined) {
      throw new Error('expected archived Phase 5 artifact');
    }
    expect(readFileSync(join(artifactPath, 'ttl-lru.js'), 'utf8')).toContain('class TtlLruCache');
    const independentTest = execFileSync(process.execPath, ['--test', 'ttl-lru.test.js'], {
      cwd: artifactPath,
      encoding: 'utf8',
    });
    expect(independentTest).toContain('pass 3');

    const state = await messages.store.load({ projectId: 'demo', taskId: 'phase5-exit' });
    expect(state?.messages.some((message) => message.fromRole === 'CODER')).toBe(true);
    expect(state?.messages.some((message) => message.fromRole === 'TESTER')).toBe(true);
    expect(state?.messages.some((message) => message.fromRole === 'REVIEWER')).toBe(true);
    expect(JSON.stringify(delivered)).not.toContain('payload');
    expect(delivered.length).toBeGreaterThanOrEqual(3);

    const restartedMessages = createMessageRuntime(root, new ChannelStream());
    const restarted = new TaskOrchestrationRuntime(
      restartedMessages,
      createWebTaskCompositionFactory({
        dataRoot: root,
        sandboxConfig: { kind: 'docker', docker },
      }),
    );
    await expect(
      restarted.summary({ projectId: 'demo', taskId: 'phase5-exit' }),
    ).resolves.toMatchObject({
      runStatus: 'completed',
      phase: 'done',
      artifactPath,
    });
    const interruptedScope = { projectId: 'demo', taskId: 'interrupted-after-restart' };
    await restartedMessages.initializeState(
      interruptedScope,
      createInitialAppState(
        'interrupted-after-restart',
        'This active snapshot lost its process',
        'demo',
      ),
    );
    await expect(restarted.summary(interruptedScope)).resolves.toMatchObject({
      runStatus: 'interrupted',
      phase: 'clarifying',
    });

    const next = await postTask(
      taskRequest({
        projectId: 'demo',
        taskId: 'slot-reuse',
        requestId: 'phase5-request-2',
        goal: '实现第二个 TTL LRU 缓存以证明活动槽位已释放',
      }),
    );
    expect(next.status).toBe(202);
    await runtime.waitForIdle({ projectId: 'demo', taskId: 'slot-reuse' });
    await expect(
      runtime.summary({ projectId: 'demo', taskId: 'slot-reuse' }),
    ).resolves.toMatchObject({ runStatus: 'completed', phase: 'done' });

    unsubscribe();
    await runtime.disposeAll();
    await restarted.disposeAll();
  }, 240_000);
});
