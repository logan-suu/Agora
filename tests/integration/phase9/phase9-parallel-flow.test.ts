// Mock reason (R11): only external LLM responses are scripted. Every scripted
// tool result is consumed and checked. HTTP, Harness sessions, Git, Docker,
// task persistence, integration, test execution and D4/D16 are real implementations.
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppState, validationReceipt } from '@agora/core-domain';
import type { HumanGateLifecyclePort, WorkerRuntime } from '@agora/core-orchestration';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { createPostTask } from '../../../apps/web/src/server/task-handlers';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';
import { projectedInputText } from '../../evals/core/projected-input';

const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
const docker = new Dockerode(existsSync(socket) ? { socketPath: socket } : {});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'phase9 flow cleanup failed');
});
const plan = {
  version: 1,
  subtasks: [
    { id: 'A', title: 'Export a = 2 in a.mjs', dependsOn: [] },
    { id: 'B', title: 'Export b = 3 in b.mjs', dependsOn: [] },
    { id: 'C', title: 'Import A and B and export sum = 5 in c.mjs', dependsOn: ['A', 'B'] },
  ],
};
type Action = { tool: string; args: Record<string, unknown> };
type View = {
  role: string;
  slices: {
    assignment?: {
      workerId: string;
      subtaskId?: string;
      subtaskIds: string[];
      validationDispatchId?: string;
      completedSubtaskIds: string[];
    };
    branchOrIntegration?: { reviewScope?: { subtasks: { subtaskId: string }[] } };
    failingTests?: { passed: boolean };
  };
};

class ParallelAdapter extends LlmAdapter {
  sequence = 0;
  reviews = 0;
  observedRuns = 0;
  readonly workers = new Set<string>();
  private firstCoders = new Set<string>();
  private releaseFirstCoders: (() => void) | undefined;
  private readonly overlap = new Promise<void>((resolve) => {
    this.releaseFirstCoders = resolve;
  });
  constructor(
    readonly changesOnce = false,
    readonly validationBarrier?: { entered(): void; release: Promise<void> },
    readonly reviewBarrier?: { entered(): void; release: Promise<void> },
    readonly scenario?:
      | 'conflict'
      | 'test_failure'
      | 'root_cause_failure'
      | 'architecture_failure'
      | 'ignored_cache',
    readonly validationHoldAfter = 0,
  ) {
    super();
  }
  private validationHeld = false;
  private reviewHeld = false;
  private initialCoderA: string | undefined;
  private initialValidation: string | undefined;
  private readonly validations = new Set<string>();
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const view = JSON.parse(projectedInputText(options)) as View;
    const rootCause =
      this.scenario === 'root_cause_failure' || this.scenario === 'architecture_failure';
    const assignment = view.slices.assignment;
    const completed = options.messages.reduce(
      (count, message) =>
        count + message.content.filter((candidate) => candidate.type === 'tool-result').length,
      0,
    );
    if (view.role === 'PM') {
      yield* textChunks(
        JSON.stringify([
          {
            id: 'R',
            story: 'Compose independent modules',
            acceptance: ['A exports 2; B exports 3; C combines them to 5'],
            nonGoals: [],
          },
        ]),
      );
      return;
    }
    if (view.role === 'ARCHITECT') {
      yield* textChunks(JSON.stringify({ architecture: { executionPlan: plan }, conventions: {} }));
      return;
    }
    if (assignment === undefined)
      throw new Error('production Tier 2 execution did not project an assignment');
    this.workers.add(assignment.workerId);
    if (view.role === 'REVIEWER' && !this.reviewHeld && this.reviewBarrier !== undefined) {
      this.reviewHeld = true;
      this.reviewBarrier.entered();
      await this.reviewBarrier.release;
    }
    if (
      view.role === 'TESTER' &&
      completed === this.validationHoldAfter &&
      !this.validationHeld &&
      this.validationBarrier !== undefined
    ) {
      this.validationHeld = true;
      this.validationBarrier.entered();
      await this.validationBarrier.release;
    }
    if (
      view.role === 'CODER' &&
      completed === 0 &&
      (assignment.subtaskId === 'A' || assignment.subtaskId === 'B') &&
      this.firstCoders.size < 2
    ) {
      this.firstCoders.add(assignment.subtaskId);
      if (this.firstCoders.size === 2) this.releaseFirstCoders?.();
      await this.overlap;
    }
    const actions: Action[] = [];
    if (view.role === 'CODER') {
      const subtask = assignment.subtaskId;
      if (subtask === 'A') this.initialCoderA ??= assignment.workerId;
      if (subtask === 'C') expect(view.slices.failingTests?.passed).not.toBe(false);
      if (subtask === 'C')
        actions.push(
          { tool: 'fs_read', args: { path: 'a.mjs' } },
          { tool: 'fs_read', args: { path: 'b.mjs' } },
        );
      const filename = `${subtask?.toLowerCase()}.mjs`;
      const source =
        subtask === 'A'
          ? `export const a = ${(this.scenario === 'test_failure' && assignment.workerId === this.initialCoderA) || (rootCause && this.reviews === 0) ? 1 : 2};`
          : subtask === 'B'
            ? 'export const b = 3;'
            : "import {a} from './a.mjs'; import {b} from './b.mjs'; export const sum = a + b;";
      if (
        this.scenario === 'conflict' &&
        (subtask === 'A' || subtask === 'B') &&
        !assignment.workerId.includes('integration-rework:')
      )
        actions.push({ tool: 'fs_write', args: { path: 'shared.txt', content: `${subtask}\n` } });
      if (this.scenario === 'ignored_cache')
        actions.push(
          { tool: 'fs_write', args: { path: '.gitignore', content: 'cache/\n' } },
          { tool: 'fs_write', args: { path: 'cache/output.txt', content: 'local coder cache' } },
        );
      actions.push(
        {
          tool: 'fs_write',
          args: { path: filename, content: `${source}\n// ${assignment.workerId}\n` },
        },
        {
          tool: 'sandbox_run',
          args: {
            cmd: `node --input-type=module -e "import('./${filename}').then(value => console.log(JSON.stringify(value)))"`,
          },
        },
        { tool: 'git_applyPatch', args: { patch: '' } },
      );
    } else if (view.role === 'TESTER') {
      this.initialValidation ??= assignment.validationDispatchId;
      this.validations.add(assignment.validationDispatchId as string);
      const includesC =
        assignment.subtaskIds.includes('C') || assignment.completedSubtaskIds.includes('C');
      const checks = `test('A',()=>assert.equal(a,2)); test('B',()=>assert.equal(b,3)); ${includesC ? "test('C',()=>assert.equal(sum,5));" : ''}`;
      const nested = this.scenario === 'test_failure';
      const source = `import {test,describe} from 'node:test'; import assert from 'node:assert/strict'; import {a} from './a.mjs'; import {b} from './b.mjs'; ${includesC ? "import {sum} from './c.mjs';" : ''}\n${nested ? `describe('wave acceptance',()=>{${checks}});` : checks}\n`;
      const path = `${nested ? '业务 验证' : 'wave'}-${assignment.validationDispatchId}.test.mjs`;
      actions.push(
        { tool: 'fs_write', args: { path, content: source } },
        { tool: 'sandbox_run', args: { cmd: `node --test --test-reporter=tap '${path}'` } },
        { tool: 'git_applyPatch', args: { patch: '' } },
      );
    } else if (view.role === 'REVIEWER') {
      expect(
        view.slices.branchOrIntegration?.reviewScope?.subtasks.map((node) => node.subtaskId),
      ).toEqual(['A', 'B', 'C']);
      actions.push({
        tool: 'fs_read',
        args: {
          path: rootCause && this.reviews === 0 ? 'a.mjs' : 'c.mjs',
        },
      });
    }
    // The adapter advances only after inspecting the real previous result.
    if (completed > 0) {
      const previous = actions[completed - 1];
      if (previous === undefined) throw new Error('unexpected tool result count');
      const value = toolResult(options, previous.tool);
      if (previous.tool === 'sandbox_run') {
        const expectedFailure =
          view.role === 'TESTER' &&
          ((this.scenario === 'test_failure' &&
            assignment.validationDispatchId === this.initialValidation) ||
            (rootCause && this.validations.size <= 2));
        expect(value).toMatchObject({ exitCode: expectedFailure ? 1 : 0, timedOut: false });
        const stdout = (value as { stdout: string }).stdout;
        expect(stdout).not.toBe('');
        if (view.role === 'TESTER') expect(stdout).toContain(`# fail ${expectedFailure ? 1 : 0}`);
        this.observedRuns++;
      } else if (previous.tool === 'git_applyPatch')
        expect(JSON.stringify(value)).toMatch(/[a-f0-9]{40}/);
      else if (previous.tool === 'fs_read') expect(JSON.stringify(value)).toContain('export');
    }
    const action = actions[completed];
    if (action !== undefined) {
      yield* toolChunks(action, CallId(`parallel-call-${++this.sequence}`));
      return;
    }
    yield* textChunks(
      view.role === 'REVIEWER'
        ? JSON.stringify([
            {
              id: `parallel-review-${++this.reviews}`,
              kind: 'verdict',
              verdict:
                (this.changesOnce || rootCause) && this.reviews === 1
                  ? 'changes_requested'
                  : 'approved',
              ...((this.changesOnce || rootCause) && this.reviews === 1
                ? { subtaskIds: ['A'] }
                : {}),
              ...(this.scenario === 'architecture_failure' && this.reviews === 1
                ? { issueScope: 'architecture' }
                : {}),
              summary: 'Reviewed the cumulative tested artifact.',
            },
          ])
        : 'Completed the assigned work using the observed tool results.',
    );
  }
}

function toolResult(options: GenerateOptions, name: string): unknown {
  const calls = options.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'tool-call' && block.name === name);
  const call = calls[calls.length - 1];
  if (call?.type !== 'tool-call') throw new Error(`missing actual call ${name}`);
  const result = options.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === 'tool-result' && block.toolCallId === call.id);
  if (result?.type !== 'tool-result') throw new Error(`missing actual result ${name}`);
  const text = result.content.find((block) => block.type === 'text');
  if (text?.type !== 'text') throw new Error(`missing actual result text ${name}`);
  return JSON.parse(text.text) as unknown;
}
function* textChunks(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function* toolChunks(action: Action, id: CallId): Iterable<StreamChunk> {
  const args = JSON.stringify(action.args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name: action.tool, argumentsDelta: args };
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id, name: action.tool, arguments: args },
  };
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

async function startFlow(adapter: ParallelAdapter, taskId: string) {
  await docker.ping();
  const root = await mkdtemp(join(tmpdir(), 'agora-phase9-flow-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const scope = { projectId: 'parallel-project', taskId };
  const messages = createMessageRuntime(root, new ChannelStream());
  // Observe the actual lifecycle binding; the registered production port still
  // owns every pause, persistence, cleanup, resolution and resume operation.
  let lifecycle: HumanGateLifecyclePort | undefined;
  let workerRuntime: WorkerRuntime | undefined;
  const bind = messages.bindHumanGateLifecyclePort.bind(messages);
  messages.bindHumanGateLifecyclePort = (port) => {
    lifecycle = port;
    bind(port);
  };
  const baseFactory = createWebTaskCompositionFactory({
    dataRoot: root,
    sandboxConfig: { kind: 'docker', docker },
    executorOptions: { adapter, provider: 'phase9-g5', deepseek: false },
  });
  const runtime = new TaskOrchestrationRuntime(messages, async (input) => {
    const composition = await baseFactory(input);
    workerRuntime = composition.workerRuntime;
    cleanups.push(() => composition.suspend());
    return composition;
  });
  const response = await createPostTask(runtime)(
    new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope,
        requestId: 'start',
        goal: 'Build a modular API system: A and B independently, then C combines them.',
      }),
    }),
  );
  expect(response.status).toBe(202);
  if (lifecycle === undefined) throw new Error('missing actual lifecycle port');
  const post = createPostMessage(messages);
  return {
    root,
    scope,
    messages,
    runtime,
    lifecycle,
    get workerRuntime() {
      return workerRuntime;
    },
    postLeader: async (msgId: string, display: string) => {
      const response = await post(
        new Request('http://localhost/api/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...scope, channelId: 'main', msgId, display }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await response.json()).toMatchObject({ action: { status: 'applied' } });
    },
  };
}

describe('Phase 9 automatic parallel flow (real G5)', () => {
  it.each(['root_cause_failure', 'architecture_failure'] as const)(
    'preserves cumulative evidence through %s before starting C',
    async (scenario) => {
      const architecture = scenario === 'architecture_failure';
      const adapter = new ParallelAdapter(false, undefined, undefined, scenario);
      const { scope, messages, runtime, postLeader } = await startFlow(
        adapter,
        'root-cause-rework',
      );
      await runtime.waitForIdle(scope);
      const state = (await messages.store.load(scope)) as AppState;
      expect(state.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toBe(
        'completion_confirmation:parallel-review-2',
      );
      const receipts = state.messages
        .filter((message) => message.payload.kind === 'wave_validation')
        .map((message) => validationReceipt(state, message.msgId));
      expect(receipts.map((receipt) => receipt.results.passed)).toEqual([false, false, true, true]);
      expect(receipts[2]?.subtaskIds).toEqual(['A', 'B']);
      expect(receipts[2]?.results.total).toBe(6);
      expect(receipts[3]?.results.total).toBe(9);
      expect(state.subtasks.map((subtask) => [subtask.id, subtask.status])).toEqual([
        ['A', 'done'],
        ['B', 'done'],
        ['C', 'done'],
      ]);
      expect(
        state.messages
          .filter((message) => message.payload.kind === 'coding_wave')
          .map((message) => message.payload.subtaskIds),
      ).toEqual([['A', 'B'], architecture ? ['A', 'B'] : ['A'], ['C']]);
      expect(
        state.workers.filter((worker) => worker.role === 'CODER' && worker.subtaskId === 'B'),
      ).toHaveLength(architecture ? 3 : 2);
      if (architecture) {
        const replan = state.messages.find(
          (message) => message.payload.kind === 'parallel_replan_dispatch',
        );
        expect(replan?.payload.replanSourceReceiptId).toBe(
          `wave-validation:${receipts[1]?.dispatchId}`,
        );
      } else {
        const rework = state.messages.find((message) => message.payload.kind === 'review_rework');
        expect(rework?.payload.subtaskIds).toEqual(['A', 'C']);
      }
      const cWorker = state.workers.find((worker) => worker.subtaskId === 'C');
      expect(cWorker?.worktree).toMatchObject({ baseCommit: receipts[2]?.worktree.headCommit });
      await postLeader(
        'approve-root-cause-rework',
        `/resolve-gate ${state.humanGate?.gateId} approve_completion`,
      );
      await runtime.waitForIdle(scope);
      expect(await runtime.summary(scope)).toMatchObject({ runStatus: 'completed', phase: 'done' });
    },
    60_000,
  );

  it('aborts a real merge conflict and rebuilds only the Leader-selected worker from the original base', async () => {
    const adapter = new ParallelAdapter(false, undefined, undefined, 'conflict');
    const { scope, messages, runtime, postLeader } = await startFlow(adapter, 'conflict-rework');
    await runtime.waitForIdle(scope);
    const before = (await messages.store.load(scope)) as AppState;
    expect(before.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toMatch(
      /^integration_conflict:/,
    );
    const wave = before.parallelExecution?.activeWave;
    const target = before.integration?.conflicts[0]?.workerId;
    expect(target).toBe(wave?.coderWorkerIds[1]);
    expect(before.integration?.status).toBe('conflict');
    expect(before.messages.some((message) => message.payload.kind === 'wave_validation')).toBe(
      false,
    );
    await postLeader(
      'rework-conflict',
      `/resolve-gate ${before.humanGate?.gateId} request_rework ${target}`,
    );
    await runtime.waitForIdle(scope);
    const after = (await messages.store.load(scope)) as AppState;
    expect(after.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toBe(
      'completion_confirmation:parallel-review-1',
    );
    const replacement = after.workers.find(
      (worker) => worker.workerId === 'worker:integration-rework:rework-conflict:0',
    );
    expect(replacement).toMatchObject({
      role: 'CODER',
      subtaskId: 'B',
      status: 'done',
      worktree: { baseCommit: wave?.base.commit },
    });
    expect(
      after.workers.filter((worker) => worker.role === 'CODER' && worker.subtaskId === 'A'),
    ).toHaveLength(1);
    expect(
      after.workers.find((worker) => worker.workerId === wave?.coderWorkerIds[0])?.worktree,
    ).toEqual(
      before.workers.find((worker) => worker.workerId === wave?.coderWorkerIds[0])?.worktree,
    );
    await postLeader(
      'approve-conflict-rework',
      `/resolve-gate ${after.humanGate?.gateId} approve_completion`,
    );
    await runtime.waitForIdle(scope);
    expect(await runtime.summary(scope)).toMatchObject({ runStatus: 'completed' });
  }, 60_000);

  it('uses a real failing test receipt to rework the wave from its tested HEAD before advancing dependencies', async () => {
    const adapter = new ParallelAdapter(false, undefined, undefined, 'test_failure');
    const { scope, messages, runtime, postLeader } = await startFlow(adapter, 'failed-validation');
    await runtime.waitForIdle(scope);
    const state = (await messages.store.load(scope)) as AppState;
    expect(state.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toBe(
      'completion_confirmation:parallel-review-1',
    );
    const receipts = state.messages
      .filter((message) => message.payload.kind === 'wave_validation')
      .map((message) => validationReceipt(state, message.msgId));
    expect(receipts.map((receipt) => receipt.results.passed)).toEqual([false, true, true]);
    expect(receipts[0]?.evidence.exitCode).toBe(1);
    const waves = state.messages.filter((message) => message.payload.kind === 'coding_wave');
    expect(waves.map((message) => message.payload.subtaskIds)).toEqual([['A', 'B'], ['C']]);
    const retry = state.messages.find((message) => message.payload.kind === 'coding_retry');
    expect(retry?.payload).toMatchObject({
      waveId: waves[0]?.msgId,
      attempt: 2,
      failedReceiptId: `wave-validation:${receipts[0]?.dispatchId}`,
    });
    const retryWorkerIds = retry?.payload.workerIds as string[];
    expect(retryWorkerIds).toHaveLength(2);
    for (const workerId of retryWorkerIds) {
      const worktree = state.workers.find((worker) => worker.workerId === workerId)?.worktree;
      expect(typeof worktree).toBe('object');
      if (worktree === undefined || typeof worktree === 'string')
        throw new Error('missing real retry worktree');
      expect(worktree.baseCommit).toBe(receipts[0]?.worktree.headCommit);
    }
    expect(waves[1]?.payload.base).toMatchObject({ commit: receipts[1]?.worktree.headCommit });
    await postLeader(
      'approve-test-rework',
      `/resolve-gate ${state.humanGate?.gateId} approve_completion`,
    );
    await runtime.waitForIdle(scope);
    expect(await runtime.summary(scope)).toMatchObject({ runStatus: 'completed' });
  }, 60_000);

  it('invalidates completed evidence after a real D9 requirement reproject and revalidates without recoding completed waves', async () => {
    let entered = () => {};
    let release = () => {};
    const reachedReview = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseReview = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new ParallelAdapter(false, undefined, { entered, release: releaseReview });
    const flow = await startFlow(adapter, 'stale-validation');
    const { scope, messages, runtime, postLeader } = flow;
    await reachedReview;
    const before = (await messages.store.load(scope)) as AppState;
    const oldReceiptId = before.parallelExecution?.acceptedReceiptId as string;
    const oldReceipt = validationReceipt(before, oldReceiptId);
    const inheritedTests = await Promise.all(
      (await readdir(oldReceipt.worktree.path))
        .filter((path) => path.endsWith('.test.mjs'))
        .map(
          async (path) =>
            [path, await readFile(join(oldReceipt.worktree.path, path), 'utf8')] as const,
        ),
    );
    const changed = postLeader(
      'change-requirement',
      `/requirement R ${JSON.stringify({ story: 'Reconfirm all independent modules and composition', acceptance: ['A exports 2; B exports 3; C combines them to 5'], nonGoals: [] })}`,
    );
    await expect.poll(() => flow.workerRuntime?.hasActivePause).toBe(true);
    release();
    await changed;
    await runtime.waitForIdle(scope);
    const after = (await messages.store.load(scope)) as AppState;
    expect(after.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toBe(
      'completion_confirmation:parallel-review-2',
    );
    expect(after.messages.filter((message) => message.payload.kind === 'coding_wave')).toHaveLength(
      2,
    );
    expect(after.messages.filter((message) => message.payload.kind === 'wave_closed')).toHaveLength(
      2,
    );
    expect(
      after.messages.filter((message) => message.payload.kind === 'wave_validation'),
    ).toHaveLength(3);
    const currentId = after.parallelExecution?.acceptedReceiptId as string;
    expect(currentId).not.toBe(oldReceiptId);
    const currentReceipt = validationReceipt(after, currentId);
    expect(currentReceipt.inputCommit).toBe(oldReceipt.worktree.headCommit);
    for (const [path, contents] of inheritedTests)
      expect(await readFile(join(currentReceipt.worktree.path, path), 'utf8')).toBe(contents);
    expect(currentReceipt.results.total).toBeGreaterThan(oldReceipt.results.total);
    expect(validationReceipt(after, currentId).controlFingerprint).not.toBe(
      validationReceipt(after, oldReceiptId).controlFingerprint,
    );
    await postLeader(
      'approve-current',
      `/resolve-gate ${after.humanGate?.gateId} approve_completion`,
    );
    await runtime.waitForIdle(scope);
    expect(await runtime.summary(scope)).toMatchObject({ runStatus: 'completed' });
  }, 60_000);
  it('reopens A and already completed C while preserving B, then honors Leader request_changes', async () => {
    const adapter = new ParallelAdapter(true);
    const { root, scope, messages, runtime, postLeader } = await startFlow(
      adapter,
      'review-rework',
    );
    await runtime.waitForIdle(scope);
    let state = (await messages.store.load(scope)) as AppState;
    expect(state.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toBe(
      'completion_confirmation:parallel-review-2',
    );
    const waves = state.messages.filter((message) => message.payload.kind === 'coding_wave');
    expect(waves.map((message) => message.payload.subtaskIds)).toEqual([
      ['A', 'B'],
      ['C'],
      ['A'],
      ['C'],
    ]);
    expect(
      state.workers.filter((worker) => worker.role === 'CODER' && worker.subtaskId === 'B'),
    ).toHaveLength(1);
    expect(
      state.messages.find((message) => message.payload.kind === 'review_rework')?.payload
        .subtaskIds,
    ).toEqual(['A', 'C']);
    await postLeader(
      'leader-rework',
      `/resolve-gate ${state.humanGate?.gateId} request_changes Verify the full cumulative artifact again.`,
    );
    await runtime.waitForIdle(scope);
    state = (await messages.store.load(scope)) as AppState;
    expect(state.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toBe(
      'completion_confirmation:parallel-review-3',
    );
    expect(
      state.messages
        .filter((message) => message.payload.kind === 'coding_wave')
        .slice(-2)
        .map((message) => message.payload.subtaskIds),
    ).toEqual([['A', 'B'], ['C']]);
    await postLeader(
      'approve-rework',
      `/resolve-gate ${state.humanGate?.gateId} approve_completion`,
    );
    await runtime.waitForIdle(scope);
    expect(await runtime.summary(scope)).toMatchObject({ runStatus: 'completed', phase: 'done' });
    expect((await new HarnessTraceReader(root).read(scope)).sessions.length).toBeGreaterThan(10);
  }, 60_000);

  it.each([0, 2])(
    'suspends validation after %i observed tools and resumes the same dispatch in a fresh Harness Fork',
    async (holdAfter) => {
      let entered = () => {};
      let release = () => {};
      const reachedValidation = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const releaseValidation = new Promise<void>((resolve) => {
        release = resolve;
      });
      const adapter = new ParallelAdapter(
        false,
        { entered, release: releaseValidation },
        undefined,
        undefined,
        holdAfter,
      );
      const { root, scope, messages, runtime, lifecycle, postLeader } = await startFlow(
        adapter,
        'validation-fork',
      );
      await reachedValidation;
      const before = (await messages.store.load(scope)) as AppState;
      const dispatchId = before.parallelExecution?.activeWave?.validation?.dispatchId;
      const workerId = before.parallelExecution?.activeWave?.validation?.workerId;
      const paused = lifecycle.suspend(scope, {
        triggerMsgId: 'validation-pause',
        triggerTs: Date.now(),
        reason: 'iteration_limit',
        options: ['continue'],
        phase: 'testing',
      });
      release();
      await paused;
      await runtime.waitForIdle(scope);
      const suspended = (await messages.store.load(scope)) as AppState;
      expect(suspended.workers.find((worker) => worker.workerId === workerId)?.status).toBe(
        'paused',
      );
      expect(suspended.parallelExecution?.activeWave?.validation?.receiptId).toBeUndefined();
      expect(suspended.humanGate?.safePointRefs).toHaveLength(1);
      if (holdAfter === 2) {
        const worktree = suspended.workers.find((worker) => worker.workerId === workerId)?.worktree;
        expect(worktree).toEqual(expect.objectContaining({ headCommit: expect.any(String) }));
        expect(typeof worktree !== 'string' && worktree?.headCommit).not.toBe(
          before.parallelExecution?.activeWave?.validation?.inputCommit,
        );
      }
      await postLeader('resume-validation', '/resolve-gate human-gate:validation-pause continue');
      await runtime.waitForIdle(scope);
      const resumed = (await messages.store.load(scope)) as AppState;
      expect(resumed.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toBe(
        'completion_confirmation:parallel-review-1',
      );
      expect(
        resumed.messages.some((message) => message.msgId === `wave-validation:${dispatchId}`),
      ).toBe(true);
      const trace = await new HarnessTraceReader(root).read(scope);
      expect(
        trace.sessions.filter(
          (session) => session.role === 'TESTER' && session.parentSessionId !== undefined,
        ),
      ).toHaveLength(1);
      await postLeader(
        'approve-fork',
        `/resolve-gate ${resumed.humanGate?.gateId} approve_completion`,
      );
      await runtime.waitForIdle(scope);
      expect(await runtime.summary(scope)).toMatchObject({ runStatus: 'completed' });
    },
    60_000,
  );
  it('continues the real Harness after aborting a quiescent validation pause', async () => {
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new ParallelAdapter(false, { entered, release: released });
    const flow = await startFlow(adapter, 'abort-native-pause');
    await started;
    const worker = flow.workerRuntime;
    if (worker === undefined) throw new Error('missing active worker runtime');
    const pausing = worker.requestPause({
      scope: flow.scope,
      actionId: 'abort-native',
      reason: 'decision_change',
      mode: 'reproject',
    });
    release();
    const receipt = await pausing;
    expect(receipt.workers.some((entry) => entry.status === 'paused')).toBe(true);
    await worker.abortPause(receipt);
    await flow.runtime.waitForIdle(flow.scope);
    const state = await flow.messages.store.load(flow.scope);
    expect(state?.humanGate?.reason, JSON.stringify(await flow.runtime.summary(flow.scope))).toBe(
      'completion_confirmation:parallel-review-1',
    );
    expect(state?.subtasks.every((node) => node.status === 'done')).toBe(true);
    expect(state?.messages.some((message) => message.msgId === 'abort-native')).toBe(false);
  }, 60_000);

  it('suspends real parallel resources after evidence failure while preserving the source and freeing admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-failed-parallel-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const scope = { projectId: 'failure-project', taskId: 'first' };
    const messages = createMessageRuntime(root, new ChannelStream());
    const factory = createWebTaskCompositionFactory({
      dataRoot: root,
      sandboxConfig: { kind: 'docker', docker },
      executorOptions: { adapter: new ParallelAdapter(), provider: 'phase9-g5', deepseek: false },
    });
    const runtime = new TaskOrchestrationRuntime(
      messages,
      async (input) => {
        const composition = await factory(input);
        cleanups.push(() => composition.suspend());
        return {
          ...composition,
          parallelContext: async (state) => {
            if (state.parallelExecution?.activeWave?.validation?.receiptId !== undefined)
              throw new Error('injected evidence inspection failure');
            if (composition.parallelContext === undefined)
              throw new Error('missing parallel context');
            return composition.parallelContext(state);
          },
        };
      },
      { maxActiveCompositions: 1 },
    );
    const input = {
      ...scope,
      requestId: 'start',
      goal: 'Build a modular API system: A and B independently, then C combines them.',
    };
    await runtime.start(input);
    await runtime.waitForIdle(scope);
    expect(await runtime.summary(scope)).toMatchObject({
      runStatus: 'needs_attention',
      error: '[RUN_FAILED] Task execution failed.',
    });
    const state = await messages.store.load(scope);
    expect(state?.humanGate).toBeUndefined();
    if (state === undefined) throw new Error('missing preserved state');
    const receiptId = state.parallelExecution?.activeWave?.validation?.receiptId;
    if (receiptId === undefined) throw new Error('missing preserved receipt');
    const receipt = validationReceipt(state, receiptId);
    const taskRoot = join(root, 'projects', scope.projectId, 'tasks', scope.taskId);
    expect(existsSync(join(taskRoot, 'artifacts', receipt.evidence.path))).toBe(true);
    expect(existsSync(join(receipt.worktree.path, 'a.mjs'))).toBe(true);
    expect(existsSync(join(taskRoot, 'artifacts/worktree'))).toBe(false);
    const physicalTaskRoot = await realpath(taskRoot);
    expect(
      (await docker.listContainers({ all: true })).some((container) =>
        container.Mounts.some((mount) => mount.Source.startsWith(physicalTaskRoot)),
      ),
    ).toBe(false);
    await expect(
      runtime.start({ ...input, taskId: 'second', requestId: 'second' }),
    ).resolves.toMatchObject({ startOutcome: 'started' });
    await runtime.waitForIdle({ ...scope, taskId: 'second' });
  }, 60_000);

  it('runs A/B concurrently, inherits tested code into C, then approves and reruns the archived artifact', async () => {
    await docker.ping();
    const root = await mkdtemp(join(tmpdir(), 'agora-phase9-flow-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const scope = { projectId: 'agora', taskId: 'parallel-task' };
    const messages = createMessageRuntime(root, new ChannelStream());
    const adapter = new ParallelAdapter(false, undefined, undefined, 'ignored_cache');
    const baseFactory = createWebTaskCompositionFactory({
      dataRoot: root,
      sandboxConfig: { kind: 'docker', docker },
      executorOptions: { adapter, provider: 'phase9-g5', deepseek: false },
    });
    const runtime = new TaskOrchestrationRuntime(messages, async (input) => {
      const composition = await baseFactory(input);
      cleanups.push(() => composition.suspend());
      return composition;
    });
    const response = await createPostTask(runtime)(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          requestId: 'start',
          goal: 'Build a modular API system: A and B independently, then C combines them.',
        }),
      }),
    );
    expect(response.status).toBe(202);
    await runtime.waitForIdle(scope);
    let state = (await messages.store.load(scope)) as AppState;
    expect(await runtime.summary(scope)).toMatchObject({
      runStatus: 'needs_attention',
      phase: 'review',
    });
    expect(state.humanGate?.reason, JSON.stringify(await runtime.summary(scope))).toBe(
      'completion_confirmation:parallel-review-1',
    );
    expect(state.subtasks.map((node) => [node.id, node.status])).toEqual([
      ['A', 'done'],
      ['B', 'done'],
      ['C', 'done'],
    ]);
    const receipts = state.messages
      .filter((message) => message.payload.kind === 'wave_validation')
      .map((message) => validationReceipt(state, message.msgId));
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.results.total)).toEqual([2, 5]);
    const waves = state.messages.filter((message) => message.payload.kind === 'coding_wave');
    expect(waves.map((wave) => wave.payload.subtaskIds)).toEqual([['A', 'B'], ['C']]);
    expect(waves[1]?.payload.base).toMatchObject({ commit: receipts[0]?.worktree.headCommit });
    for (const worker of state.workers.filter((worker) => worker.role === 'CODER')) {
      if (typeof worker.worktree !== 'object') throw new Error('missing coder worktree');
      expect(await readFile(join(worker.worktree.path, 'cache/output.txt'), 'utf8')).toBe(
        'local coder cache',
      );
    }
    expect(receipts.every((receipt) => !existsSync(join(receipt.worktree.path, 'cache')))).toBe(
      true,
    );
    expect(adapter.observedRuns).toBeGreaterThanOrEqual(5);
    const trace = await new HarnessTraceReader(root).read(scope);
    expect(trace.sessions.filter((session) => session.role === 'CODER')).toHaveLength(3);
    const post = createPostMessage(messages);
    const approval = await post(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: 'approve',
          display: `/resolve-gate ${state.humanGate?.gateId} approve_completion`,
        }),
      }),
    );
    expect(approval.status, await approval.clone().text()).toBe(202);
    await runtime.waitForIdle(scope);
    state = (await messages.store.load(scope)) as AppState;
    expect(await runtime.summary(scope)).toMatchObject({ runStatus: 'completed', phase: 'done' });
    expect(
      state.messages.find((message) => message.msgId === 'approve')?.payload.resolution,
    ).toMatchObject({
      completionEvidence: { validationReceiptId: state.parallelExecution?.acceptedReceiptId },
    });
    const artifact = join(
      root,
      'projects',
      scope.projectId,
      'tasks',
      scope.taskId,
      'artifacts/worktree',
    );
    const reloadedRuntime = new TaskOrchestrationRuntime(messages, baseFactory);
    expect(await reloadedRuntime.summary(scope)).toMatchObject({
      runStatus: 'completed',
      artifactPath: artifact,
    });
    expect(await readFile(join(artifact, 'c.mjs'), 'utf8')).toContain('a + b');
    expect(
      await readdir(join(root, 'projects', scope.projectId, 'tasks', scope.taskId, 'worktrees')),
    ).toEqual([]);
    const fresh = new DockerSandbox({ docker, baseDir: root });
    cleanups.push(() => fresh.teardown('archive-rerun'));
    const target = await fresh.createWorktree('archive-rerun', 'verify');
    await cp(artifact, target.path, { recursive: true });
    const rerun = await fresh.run(target, 'node --test --test-reporter=tap *.test.mjs');
    expect(rerun).toMatchObject({ exitCode: 0, timedOut: false });
    expect(rerun.stdout).toContain('# tests 5');
    const evidenceDirectory = process.env.AGORA_G5_EVIDENCE_DIR;
    if (evidenceDirectory !== undefined)
      await cp(root, evidenceDirectory, { recursive: true, force: false, errorOnExist: true });
  }, 60_000);
});
