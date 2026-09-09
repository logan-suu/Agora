// Only provider responses are scripted for deterministic failure injection.
// Harness/retry/invariants, MCP, Git, Docker, TaskStateStore, scheduler and JSONL/Fork are real.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { GlobalScheduler, WorkerRuntime } from '@agora/core-orchestration';
import { HarnessExecutor, HarnessTraceReader, project } from '@agora/runtime-executor';
import { Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import { JsonTaskStateStore } from '@agora/runtime-state';
import { createToolCatalog, type ToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { initializeRegisteredWorktree, WorktreeGitService } from '@agora/tools-git';
import {
  CallId,
  type GenerateOptions,
  LlmAdapter,
  resolveRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { fetchTraceSnapshot } from '../../../apps/web/src/app/chat-model';
import { createGetTrace } from '../../../apps/web/src/server/trace-handlers';

class RecoveringTools extends LlmAdapter {
  calls = 0;
  readonly observed: unknown[] = [];
  override providerRetryPolicy() {
    return resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 2,
        backoff: { initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 },
      },
      'phase10',
    );
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = ++this.calls;
    if (call === 1) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'INJECTED_SECRET' } },
      };
      return;
    }
    const results = options.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool-result');
    const result = results.at(-1);
    if (result?.type === 'tool-result') {
      const text = result.content.find((b) => b.type === 'text');
      if (text?.type !== 'text') throw new Error('missing real tool result');
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(text.text);
      this.observed.push(parsed);
      if (call === 4) expect(parsed.timedOut).toBe(true);
      if (call === 5)
        expect(parsed).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'usable\n' });
    }
    const actions = [
      { name: 'fs_write', args: { path: 'proof.txt', content: 'recovered' } },
      { name: 'sandbox_run', args: { cmd: 'node -e "while(true){}"', timeoutMs: 150 } },
      { name: 'sandbox_run', args: { cmd: 'node -e "console.log(\'usable\')"', timeoutMs: 5000 } },
      { name: 'git_applyPatch', args: { patch: '' } },
    ];
    const action = actions[call - 2];
    if (action) {
      const id = CallId(`call-${call}`);
      const args = JSON.stringify(action.args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: action.name, arguments: args },
      };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Recovered and checked actual tool results.' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'Recovered and checked actual tool results.' },
      };
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

it('recovers through real MCP/Docker/Git, commits state, releases its lease and reads a genuine Fork without retry seed duplication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-phase10-'));
  const scope = { projectId: 'resilience-project', taskId: 'resilience-task' };
  const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
  const docker = new Dockerode(existsSync(socket) ? { socketPath: socket } : {});
  const sandbox = new DockerSandbox({ docker });
  const registry = new WorktreeRegistry();
  const git = new WorktreeGitService(registry);
  let catalog: ToolCatalog | undefined;
  const executors: HarnessExecutor[] = [];
  const errors: unknown[] = [];
  try {
    await docker.ping();
    const worktree = await sandbox.createWorktree(scope.taskId, 'CODER');
    await initializeRegisteredWorktree(registry, worktree.path);
    const base = await git.headOf(worktree.path);
    catalog = await createToolCatalog({
      sandbox,
      registry,
      gitService: git,
      getWorktree: async () => worktree,
    });
    const coder = PHASE0_ROSTER.find((r) => r.role === 'CODER');
    if (!coder) throw new Error('missing CODER');
    const tools = catalog.resolve(coder.tools);
    const adapter = new RecoveringTools();
    const persistence = {
      root: join(root, 'projects', scope.projectId, 'tasks', scope.taskId, 'harness-sessions'),
      cwd: worktree.path,
      ...scope,
    };
    const store = new JsonTaskStateStore(root);
    const initial = await store.initialize(
      scope,
      createInitialAppState(scope.taskId, 'Exercise recovery', scope.projectId),
    );
    const scheduler = new GlobalScheduler({ cap: 1 });
    const executor = new HarnessExecutor(coder, {
      adapter,
      tools: tools.definitions,
      allowTools: tools.allowNames,
      sessionPersistence: persistence,
    });
    executors.push(executor);
    const runtime = new WorkerRuntime(
      {
        roster: PHASE0_ROSTER,
        loadState: () => store.load(scope),
        transition: async (_state, mutations) => (await store.commit(scope, mutations)).state,
        buildExecutor: () => executor,
      },
      scheduler,
    );
    const state = await runtime.runOne(initial, { workerId: 'worker-recovery', role: 'CODER' });
    expect(state.workers[0]?.status).toBe('done');
    expect(state.messages).toHaveLength(1);
    expect(adapter.calls).toBe(6);
    expect(adapter.observed).toHaveLength(4);
    expect(scheduler.activeCount).toBe(0);
    expect(await sandbox.read(worktree, 'proof.txt')).toBe('recovered');
    expect(await git.headOf(worktree.path)).not.toBe(base);
    const checkpoint = await executor.saveSafePoint();
    await executor.dispose();
    executors.pop();
    const child = new HarnessExecutor(coder, {
      adapter,
      sessionPersistence: { ...persistence, resumeSessionId: 'resilience-child' },
    });
    executors.push(child);
    await child.loadSafePoint(checkpoint);
    await child.step({
      sessionId: 'resilience-child',
      view: project(state, 'CODER', PHASE0_ROSTER),
    });
    await child.saveSafePoint();
    const handler = createGetTrace(store, new HarnessTraceReader(root));
    const trace = await fetchTraceSnapshot(
      'http://localhost/api/traces?projectId=resilience-project&taskId=resilience-task',
      (input) => handler(new Request(String(input))),
    );
    expect(trace.sessions).toHaveLength(2);
    expect(
      trace.sessions.find((s) => s.sessionId === 'resilience-child')?.parentSessionId,
    ).toBeDefined();
    const retries = trace.sessions.flatMap((s) =>
      s.turns.flatMap((t) => t.steps.flatMap((step) => step.retries ?? [])),
    );
    expect(retries).toEqual([
      expect.objectContaining({ retry: 1, errorCode: 'TRANSPORT', status: 'backoff_completed' }),
    ]);
    expect(JSON.stringify(trace)).not.toContain('INJECTED_SECRET');
  } catch (error) {
    errors.push(error);
  } finally {
    for (const cleanup of [
      ...executors.map((executor) => () => executor.dispose()),
      () => catalog?.dispose(),
      () => git.dispose(),
      () => sandbox.teardown(scope.taskId),
      () => rm(root, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'phase10 execution and cleanup failed');
}, 60_000);
