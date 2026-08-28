import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppState, PHASE0_ROSTER } from '@agora/core-domain';
import { runOrchestration } from '@agora/core-orchestration';
import {
  createSandbox,
  Dockerode,
  DockerSandbox,
  LocalTempSandbox,
  type Worktree,
} from '@agora/runtime-sandbox';
import { createToolCatalog, type ToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { Context } from '@deepseek-ai/cordis';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPhase1Runtime,
  type Phase1Runtime,
} from '../../../packages/core/__tests__/e2e/phase1-runtime';

/**
 * Phase 1 exit integration test (task 1.6) — deterministic regression covering
 * the Phase 1 exit criteria:
 *
 *   「Coder 能真正写代码进沙箱并执行；MCP 五类 server 可用；
 *     LocalTemp/Docker 可配置切换」(task-status.json exit_criteria)
 *
 * R11 mock note: the ONLY mocked dependency is the external LLM (`LlmAdapter`),
 * scripted to emit a fixed per-role tool-call/text script so the test is
 * deterministic and CI-green without an API key. Everything else is real: the
 * Harness agent loop, the MCP fs/test/git servers bridged over
 * InMemoryTransport, the sandbox_run function tool, the real git binary, real
 * node --test subprocesses, and the LocalTemp/Docker sandboxes. The live-LLM
 * G5 chain stays covered by `packages/core/__tests__/e2e/lru-cache.test.ts`
 * (skipIf no key).
 *
 * DEF-005: the lint server landed in task 2.5 (biome-backed), so the catalog
 * resolves `lint` for CODER/REVIEWER; the Phase 1 in-loop surface still
 * excludes it (PHASE1_TOOL_SURFACE), so the loop itself never requires lint.
 * The `git` group is verified in the direct catalog chain (an in-loop git flow
 * needs Phase 2 composition-root worktree-pointer machinery; DEF-006 defers
 * the git grant-granularity ruling).
 */

/** Phase 1 shared-worktree handoff files (spec §9 file protocol). */
const SUBTASK_STATUS_FILE = 'subtask-status.json';
const TEST_RESULTS_FILE = 'test-results.json';

/** Plain-JS CommonJS math module the scripted CODER writes via the MCP fs server. */
const MATH_SOURCE = `// Simple math module (Phase 1 exit task).
function add(a, b) {
  return a + b;
}

function mul(a, b) {
  return a * b;
}

module.exports = { add, mul };
`;

/** Matching node:test suite the scripted TESTER writes, run by real node --test. */
const MATH_TEST_SOURCE = `const { test } = require('node:test');
const assert = require('node:assert');
const { add, mul } = require('./math.js');

test('add sums two numbers', () => {
  assert.strictEqual(add(2, 3), 5);
});

test('mul multiplies two numbers', () => {
  assert.strictEqual(mul(2, 3), 6);
});
`;

interface ScriptedAction {
  tool: 'fs_write' | 'sandbox_run';
  args: Record<string, unknown>;
}

/**
 * Deterministic per-role script: which real tools the fake LLM asks for, in
 * order. Only tools the §2 matrix whitelist grants to each role are used
 * (fs_write/sandbox_run for both); the fs.read/fs.list/test.run/git tools are
 * exercised by the direct catalog chain below.
 */
const ROLE_SCRIPTS: Readonly<Record<string, readonly ScriptedAction[]>> = {
  CODER: [
    { tool: 'fs_write', args: { path: 'math.js', content: MATH_SOURCE } },
    {
      tool: 'fs_write',
      args: { path: SUBTASK_STATUS_FILE, content: JSON.stringify({ status: 'done' }) },
    },
  ],
  TESTER: [
    { tool: 'fs_write', args: { path: 'math.test.js', content: MATH_TEST_SOURCE } },
    { tool: 'sandbox_run', args: { cmd: 'node --test math.test.js' } },
    {
      tool: 'fs_write',
      args: {
        path: TEST_RESULTS_FILE,
        content: JSON.stringify({ passed: true, total: 2, failed: 0, failures: [] }),
      },
    },
  ],
};

/** Final assistant text per role; the loop quiesces once the fake LLM stops calling tools. */
const FINAL_TEXTS: Readonly<Record<string, string>> = {
  CODER: 'Implemented math.js and marked the subtask done.',
  TESTER: 'Tests passed; recorded test-results.json.',
};

/**
 * Fake LLM (R11: external dependency only). Reads the projected messages the
 * Harness loop feeds it, counts how many tool-results have landed so far, and
 * emits the next scripted tool call — or, once the script is exhausted, plain
 * text so the ReAct loop quiesces. Every tool call is executed by the REAL
 * ToolRuntime against the REAL sandbox (LocalTemp or Docker).
 */
class ScriptedLlmAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  private callSeq = 0;

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    const role = projectionRoleOf(options);
    const completed = completedActionsOf(options);
    const action = (ROLE_SCRIPTS[role] ?? [])[completed];
    if (action === undefined) {
      yield* textChunks(FINAL_TEXTS[role] ?? 'done');
      return;
    }
    yield* toolCallChunks(action, CallId(`call-${this.callSeq++}`));
  }
}

/** Parse the projected role from the first message (the pre-step projection). */
function projectionRoleOf(call: GenerateOptions): string {
  const first = call.messages[0];
  const block = first === undefined ? undefined : first.content.find((b) => b.type === 'text');
  if (block === undefined || block.type !== 'text') {
    throw new Error('scripted adapter expected the projection as the first message block');
  }
  const view = JSON.parse(block.text) as { role?: unknown };
  if (typeof view.role !== 'string') {
    throw new Error('scripted adapter expected a role in the projection');
  }
  return view.role;
}

/** Number of tool executions already completed: one tool-result block per executed call. */
function completedActionsOf(call: GenerateOptions): number {
  return call.messages.reduce(
    (count, message) => count + message.content.filter((b) => b.type === 'tool-result').length,
    0,
  );
}

/** The parsed tool-result JSON of the first executed `toolName` call, if any. */
function toolResultOf(calls: readonly GenerateOptions[], toolName: string): unknown | undefined {
  for (const call of calls) {
    for (const message of call.messages) {
      for (const block of message.content) {
        if (block.type !== 'tool-call' || block.name !== toolName) continue;
        const callId = block.id;
        for (const other of call.messages) {
          for (const result of other.content) {
            if (result.type !== 'tool-result' || result.toolCallId !== callId) continue;
            const text = result.content.find((t) => t.type === 'text');
            if (text?.type === 'text') {
              return JSON.parse(text.text) as unknown;
            }
          }
        }
      }
    }
  }
  return undefined;
}

function usageChunk(): StreamChunk {
  return { type: 'usage', usage: { inputTokens: 16, outputTokens: 16 } };
}

function* toolCallChunks(action: ScriptedAction, callId: CallId): Iterable<StreamChunk> {
  const argumentsJson = JSON.stringify(action.args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield {
    type: 'tool-call-delta',
    index: 0,
    id: callId,
    name: action.tool,
    argumentsDelta: argumentsJson,
  };
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: callId, name: action.tool, arguments: argumentsJson },
  };
  yield usageChunk();
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function* textChunks(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield usageChunk();
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** Docker daemon probe (mirrors docker-sandbox.test.ts; skip when unreachable). */
const DOCKER_SOCKETS = [
  process.env.DOCKER_HOST,
  '/var/run/docker.sock',
  join(process.env.HOME ?? '', '.docker/run/docker.sock'),
].filter((p): p is string => Boolean(p));

function connectDocker(): Dockerode | null {
  for (const socket of DOCKER_SOCKETS) {
    if (socket.startsWith('unix://') || socket.startsWith('http://')) {
      // DOCKER_HOST style: dockerode reads it directly.
      return new Dockerode();
    }
    if (existsSync(socket)) {
      return new Dockerode({ socketPath: socket });
    }
  }
  return null;
}

const docker = connectDocker();
const describeDocker = docker === null ? describe.skip : describe;

/** Direct-catalog fixture (bridgeFixture-lite): real MCP servers + real sandbox. */
async function catalogFixture(): Promise<{
  sandbox: LocalTempSandbox;
  worktree: Worktree;
  setWorktree(next: Worktree): void;
  catalog: ToolCatalog;
  ctx: Context;
  dispose(): Promise<void>;
}> {
  const sandbox = new LocalTempSandbox();
  const worktree = await sandbox.createWorktree('exit-bridge', 'shared');
  const registry = new WorktreeRegistry();
  registry.register(worktree.path);
  let current = worktree;
  const catalog = await createToolCatalog({
    registry,
    sandbox,
    getWorktree: async () => current,
  });
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  for (const tool of catalog.all()) {
    ctx.tools.register(tool);
  }
  return {
    sandbox,
    worktree,
    setWorktree: (next) => {
      current = next;
    },
    catalog,
    ctx,
    dispose: async () => {
      await catalog.dispose();
      await sandbox.teardown('exit-bridge');
    },
  };
}

function exec(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: CallId(`call-${name}-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
  });
}

/** The canonical value a bridged tool resolved (or the thrown error message). */
async function toolValue(ctx: Context, name: string, args: unknown): Promise<unknown> {
  const result = await exec(ctx, name, args);
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.value;
}

describe('Phase 1 exit integration (scripted LLM, real MCP fs + LocalTemp sandbox)', () => {
  let runtime: Phase1Runtime;
  let final: AppState;
  let adapter: ScriptedLlmAdapter;

  beforeAll(async () => {
    adapter = new ScriptedLlmAdapter();
    runtime = await createPhase1Runtime({
      taskId: 'exit-1',
      goal: '实现一个支持加法和乘法的 math 模块，并编写单元测试',
      adapter,
    });
    final = await runOrchestration(runtime.initialState, {
      workerRuntime: runtime.workerRuntime,
      roster: PHASE0_ROSTER,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('chain 1: shared State flows through mutations to a done phase', () => {
    expect(final.phase).toBe('done');
    expect(final.testResults?.passed).toBe(true);
    expect(final.testResults?.total).toBe(2);
    expect(final.subtasks[0]?.status).toBe('done');
    const roles = final.messages.map((message) => message.fromRole);
    expect(roles).toContain('COORDINATOR');
    expect(roles).toContain('CODER');
    expect(roles).toContain('TESTER');
    expect(final.iterationCount).toBe(0);
  });

  it('chain 2: the Harness agent loop drives every role to quiescence', () => {
    const coderCalls = adapter.calls.filter((c) => projectionRoleOf(c) === 'CODER');
    const testerCalls = adapter.calls.filter((c) => projectionRoleOf(c) === 'TESTER');
    expect(coderCalls.length).toBeGreaterThanOrEqual(2);
    expect(testerCalls.length).toBeGreaterThanOrEqual(2);
    expect(coderCalls.some((c) => completedActionsOf(c) > 0)).toBe(true);
    expect(testerCalls.some((c) => completedActionsOf(c) > 0)).toBe(true);
    expect(adapter.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('chain 3: MCP fs wrote real files and sandbox_run executed node --test (exitCode 0)', () => {
    const files = readdirSync(runtime.worktree.path);
    expect(files).toEqual(
      expect.arrayContaining(['math.js', 'math.test.js', SUBTASK_STATUS_FILE, TEST_RESULTS_FILE]),
    );
    expect(readFileSync(join(runtime.worktree.path, 'math.js'), 'utf8')).toBe(MATH_SOURCE);
    const runResult = toolResultOf(adapter.calls, 'sandbox_run') as
      | { exitCode: number | null; stdout: string; timedOut: boolean }
      | undefined;
    expect(runResult).toBeDefined();
    expect(runResult?.exitCode).toBe(0);
    expect(runResult?.stdout).toContain('pass 2');
    expect(runResult?.timedOut).toBe(false);
  });

  it('chain 4: pre-step overwrites the LLM input with the projection (R2/D1)', () => {
    for (const role of ['CODER', 'TESTER'] as const) {
      const calls = adapter.calls.filter((c) => projectionRoleOf(c) === role);
      const first = calls[0];
      if (first === undefined) {
        throw new Error(`no scripted LLM call recorded for role ${role}`);
      }
      const textBlock = first.messages[0]?.content.find((b) => b.type === 'text');
      if (textBlock?.type !== 'text') {
        throw new Error('expected the projection as the first message block');
      }
      const view = JSON.parse(textBlock.text) as { role?: unknown; slices?: unknown };
      expect(view.role).toBe(role);
      const slicesJson = JSON.stringify(view.slices);
      expect(slicesJson).not.toContain('channelId');
      expect(slicesJson).not.toContain('fromRole');
      expect(completedActionsOf(first)).toBe(0);
      // CODER's assignedSubtask slice carries the worktree path (code by reference).
      if (role === 'CODER') {
        expect(slicesJson).toContain(runtime.worktree.path);
      }
      // Later exchanges keep the mid-turn tool exchange (decision D1 calibration).
      const last = calls[calls.length - 1];
      if (last === undefined) {
        throw new Error(`no scripted LLM call recorded for role ${role}`);
      }
      expect(last.messages.some((m) => m.content.some((b) => b.type === 'tool-call'))).toBe(true);
      expect(last.messages.some((m) => m.content.some((b) => b.type === 'tool-result'))).toBe(true);
    }
  });
});

describe('Phase 1 exit: MCP 五类 server 可用 (direct catalog chain, lint resolved via task 2.5)', () => {
  it('resolves the full §2 whitelist matrix (git worktree-scoped, sandbox.applyPatch aliases, lint available)', async () => {
    const fixture = await catalogFixture();
    try {
      const coder = PHASE0_ROSTER.find((entry) => entry.role === 'CODER');
      const tester = PHASE0_ROSTER.find((entry) => entry.role === 'TESTER');
      if (coder === undefined || tester === undefined) throw new Error('roster missing roles');
      const coderResolved = fixture.catalog.resolve(coder.tools);
      // DEF-006 (task 2.5): worktree-scoped git; DEF-005 (task 2.5): lint
      // resolves the biome-backed lint-server.
      expect(coderResolved.allowNames).toEqual([
        'fs_read',
        'fs_write',
        'sandbox_run',
        'git_applyPatch',
        'git_diff',
        'lint_check',
      ]);
      expect(coderResolved.allowNames).not.toContain('git_createWorktree');
      expect(coderResolved.allowNames).not.toContain('git_merge');
      expect(coderResolved.unavailable).toEqual([]);
      const testerResolved = fixture.catalog.resolve(tester.tools);
      expect(testerResolved.unavailable).toEqual([]);
      expect(testerResolved.allowNames).toContain('sandbox_run');
    } finally {
      await fixture.dispose();
    }
  });

  it('round-trips a real file through the MCP fs-server (write → read → list)', async () => {
    const fixture = await catalogFixture();
    try {
      await toolValue(fixture.ctx, 'fs_write', {
        path: 'notes/exit.txt',
        content: 'exit-test content',
      });
      const content = (await toolValue(fixture.ctx, 'fs_read', {
        path: 'notes/exit.txt',
      })) as string;
      expect(content).toBe('exit-test content');
      const listing = (await toolValue(fixture.ctx, 'fs_list', {
        glob: '**/*.txt',
      })) as { paths: string[] };
      expect(listing.paths).toContain('notes/exit.txt');
    } finally {
      await fixture.dispose();
    }
  });

  it('runs a real node --test suite through the MCP test-server (structured result)', async () => {
    const fixture = await catalogFixture();
    try {
      await toolValue(fixture.ctx, 'fs_write', {
        path: 'sum.test.js',
        content:
          "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('1 + 2 = 3', () => assert.strictEqual(1 + 2, 3));\n",
      });
      const run = (await toolValue(fixture.ctx, 'test_run', {
        cmd: 'node --test sum.test.js',
      })) as { passed: boolean; total: number; failed: number };
      expect(run.passed).toBe(true);
      expect(run.total).toBe(1);
      expect(run.failed).toBe(0);
    } finally {
      await fixture.dispose();
    }
  });

  it('runs the full git chain on the real git binary (createWorktree → write → diff → applyPatch → merge)', async () => {
    const fixture = await catalogFixture();
    try {
      const created = (await toolValue(fixture.ctx, 'git_createWorktree', {
        taskId: 'exit-git',
        name: 'feat-exit-bridge',
      })) as { path: string; branch: string };
      expect(created.branch).toBe('feat-exit-bridge');
      // Point the resolver at the git worktree so fs/git tools share it.
      fixture.setWorktree({ path: created.path, branch: created.branch });

      await toolValue(fixture.ctx, 'fs_write', {
        path: 'hello.txt',
        content: 'hello from the exit test',
      });
      // The fs_write landed in the git worktree (fs_read hits the real file).
      // Note `git diff` alone would NOT list it yet — untracked files are
      // invisible to git diff until the applyPatch commit (add -A) below.
      const readBack = (await toolValue(fixture.ctx, 'fs_read', {
        path: 'hello.txt',
      })) as string;
      expect(readBack).toBe('hello from the exit test');

      const patched = (await toolValue(fixture.ctx, 'git_applyPatch', {
        patch: [
          'diff --git a/patched.txt b/patched.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/patched.txt',
          '@@ -0,0 +1 @@',
          '+patched content',
          '',
        ].join('\n'),
      })) as { commitId: string };
      expect(patched.commitId).toMatch(/^[0-9a-f]{40}$/);

      // applyPatch stages and commits everything (add -A), so the diff vs the
      // initial commit shows both the fs-written and the patched file.
      const diff = (await toolValue(fixture.ctx, 'git_diff', {
        ref: 'HEAD~1',
      })) as string;
      expect(diff).toContain('hello.txt');
      expect(diff).toContain('patched.txt');

      const merged = (await toolValue(fixture.ctx, 'git_merge', {
        base: 'main',
        branch: 'feat-exit-bridge',
      })) as { ok: boolean };
      expect(merged.ok).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects an unregistered worktree root (R7 guard through the bridge)', async () => {
    const sandbox = new LocalTempSandbox();
    try {
      const catalog = await createToolCatalog({
        sandbox,
        getWorktree: async () => ({
          path: join(tmpdir(), 'agora-exit-unregistered'),
          branch: 'x',
        }),
      });
      const ctx = new Context();
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      for (const tool of catalog.all()) {
        ctx.tools.register(tool);
      }
      try {
        const outcome = await exec(ctx, 'fs_read', { path: 'a.txt' });
        expect(outcome.isError).toBe(true);
      } finally {
        await catalog.dispose();
      }
    } finally {
      await sandbox.teardown('exit-unregistered');
    }
  });
});

describe('Phase 1 exit: LocalTemp/Docker 可配置切换 (decision D5)', () => {
  it('createSandbox returns the configured implementation (always runs)', () => {
    expect(createSandbox()).toBeInstanceOf(LocalTempSandbox);
    expect(createSandbox({ kind: 'local' })).toBeInstanceOf(LocalTempSandbox);
    expect(createSandbox({ kind: 'docker' })).toBeInstanceOf(DockerSandbox);
  });

  it('createPhase1Runtime defaults to LocalTempSandbox (Phase 0 behavior preserved)', async () => {
    const runtime = await createPhase1Runtime({
      taskId: 'exit-default',
      goal: 'default sandbox probe',
      adapter: new ScriptedLlmAdapter(),
    });
    try {
      expect(runtime.sandbox).toBeInstanceOf(LocalTempSandbox);
    } finally {
      await runtime.dispose();
    }
  });
});

describeDocker('Phase 1 exit: Docker sandbox dual-mode (full loop, real container)', () => {
  let runtime: Phase1Runtime;
  let final: AppState;
  let adapter: ScriptedLlmAdapter;

  beforeAll(async () => {
    // describeDocker skips this suite when the daemon is unreachable; the guard
    // below only narrows the type for TS (docker is Dockerode | null).
    if (docker === null) {
      throw new Error('docker daemon unreachable — describeDocker should have skipped');
    }
    adapter = new ScriptedLlmAdapter();
    runtime = await createPhase1Runtime({
      taskId: 'exit-1-docker',
      goal: '实现一个支持加法和乘法的 math 模块，并编写单元测试',
      adapter,
      sandboxConfig: { kind: 'docker', docker },
    });
    final = await runOrchestration(runtime.initialState, {
      workerRuntime: runtime.workerRuntime,
      roster: PHASE0_ROSTER,
    });
  }, 120_000);

  afterAll(async () => {
    await runtime.dispose();
  }, 60_000);

  it('runs the same orchestration to done under a Docker sandbox', () => {
    expect(runtime.sandbox).toBeInstanceOf(DockerSandbox);
    expect(final.phase).toBe('done');
    expect(final.testResults?.passed).toBe(true);
    expect(final.testResults?.total).toBe(2);
    expect(final.subtasks[0]?.status).toBe('done');
  });

  it('wrote real files on the host bind mount and executed node --test in the container', () => {
    const files = readdirSync(runtime.worktree.path);
    expect(files).toEqual(
      expect.arrayContaining(['math.js', 'math.test.js', SUBTASK_STATUS_FILE, TEST_RESULTS_FILE]),
    );
    const runResult = toolResultOf(adapter.calls, 'sandbox_run') as
      | { exitCode: number | null; stdout: string; timedOut: boolean }
      | undefined;
    expect(runResult).toBeDefined();
    expect(runResult?.exitCode).toBe(0);
    expect(runResult?.stdout).toContain('pass 2');
    expect(runResult?.timedOut).toBe(false);
  });
});
