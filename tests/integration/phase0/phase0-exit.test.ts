import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState } from '@agora/core-domain';
import { runOrchestration } from '@agora/core-orchestration';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPhase0Runtime,
  type Phase0Runtime,
} from '../../../packages/core/__tests__/e2e/phase0-runtime';

/**
 * Phase 0 exit integration test (task 0.7) — deterministic four-chain regression.
 *
 * R11 mock note: the ONLY mocked dependency is the external LLM (`LlmAdapter`),
 * scripted to emit a fixed per-role tool-call/text script so the test is
 * deterministic and CI-green without an API key. Everything else is real: the
 * Harness agent loop (AgentLoop + ToolRuntime), the fs_write/sandbox_run
 * function tools, and the LocalTempSandbox (real temp dir + real child_process).
 * The live-LLM G5 chain is covered separately by
 * `packages/core/__tests__/e2e/lru-cache.test.ts` (skipIf no key).
 *
 * Exit criteria (详细设计 §9): the LRU cache task runs end-to-end, proving
 * State 传递 + Harness 接入 + 投影覆写.
 */

/** Phase 0 shared-worktree handoff files (spec §9 file protocol). */
const SUBTASK_STATUS_FILE = 'subtask-status.json';
const TEST_RESULTS_FILE = 'test-results.json';

/** Plain-JS CommonJS LRU cache the scripted CODER writes into the sandbox. */
const LRU_SOURCE = `// LRU cache with TTL support (Phase 0 exit task).
class LRUCache {
  constructor(capacity = 10, ttlMs = 0) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.ttlMs > 0 && Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const entry = this.map.get(key);
    if (entry !== undefined) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, ts: Date.now() });
  }

  delete(key) {
    return this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { LRUCache };
`;

/** Matching node:test suite the scripted TESTER writes, run by real node --test. */
const LRU_TEST_SOURCE = `const { test } = require('node:test');
const assert = require('node:assert');
const { LRUCache } = require('./lru-cache.js');

test('set and get round-trip', () => {
  const cache = new LRUCache(2);
  cache.set('a', 1);
  assert.strictEqual(cache.get('a'), 1);
});

test('evicts least recently used beyond capacity', () => {
  const cache = new LRUCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.strictEqual(cache.get('b'), undefined);
  assert.strictEqual(cache.get('a'), 1);
  assert.strictEqual(cache.get('c'), 3);
});

test('delete removes a key', () => {
  const cache = new LRUCache(2);
  cache.set('a', 1);
  assert.strictEqual(cache.delete('a'), true);
  assert.strictEqual(cache.get('a'), undefined);
});
`;

interface ScriptedAction {
  tool: 'fs_write' | 'sandbox_run';
  args: Record<string, unknown>;
}

/** Deterministic per-role script: which real tools the fake LLM asks for, in order. */
const ROLE_SCRIPTS: Readonly<Record<string, readonly ScriptedAction[]>> = {
  CODER: [
    { tool: 'fs_write', args: { path: 'lru-cache.js', content: LRU_SOURCE } },
    {
      tool: 'fs_write',
      args: { path: SUBTASK_STATUS_FILE, content: JSON.stringify({ status: 'done' }) },
    },
  ],
  TESTER: [
    { tool: 'fs_write', args: { path: 'lru-cache.test.js', content: LRU_TEST_SOURCE } },
    { tool: 'sandbox_run', args: { cmd: 'node --test lru-cache.test.js' } },
    {
      tool: 'fs_write',
      args: {
        path: TEST_RESULTS_FILE,
        content: JSON.stringify({ passed: true, total: 3, failed: 0, failures: [] }),
      },
    },
  ],
};

/** Final assistant text per role; the loop quiesces only once the fake LLM stops calling tools. */
const FINAL_TEXTS: Readonly<Record<string, string>> = {
  CODER: 'Implemented lru-cache.js and marked the subtask done.',
  TESTER: 'Tests passed; recorded test-results.json.',
};

/**
 * Fake LLM (R11: external dependency only). Reads the projected messages the
 * Harness loop feeds it, counts how many tool-results have landed so far, and
 * emits the next scripted tool call — or, once the script is exhausted, plain
 * text so the ReAct loop quiesces. Every tool call is executed by the REAL
 * ToolRuntime against the REAL LocalTempSandbox.
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

interface SandboxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Locate the real sandbox.run tool outcome among the recorded LLM exchanges. */
function sandboxRunResultOf(calls: readonly GenerateOptions[]): SandboxRunResult | undefined {
  for (const call of calls) {
    for (const message of call.messages) {
      for (const block of message.content) {
        if (block.type !== 'tool-call' || block.name !== 'sandbox_run') continue;
        const callId = block.id;
        for (const other of call.messages) {
          for (const result of other.content) {
            if (result.type !== 'tool-result' || result.toolCallId !== callId) continue;
            const text = result.content.find((t) => t.type === 'text');
            if (text?.type === 'text') {
              return JSON.parse(text.text) as SandboxRunResult;
            }
          }
        }
      }
    }
  }
  return undefined;
}

describe('Phase 0 exit integration (scripted LLM, real harness/tools/sandbox)', () => {
  let runtime: Phase0Runtime;
  let final: AppState;
  let adapter: ScriptedLlmAdapter;

  beforeAll(async () => {
    adapter = new ScriptedLlmAdapter();
    runtime = await createPhase0Runtime({
      taskId: 'exit-0',
      goal: '实现一个带 TTL 的 LRU 缓存类，包含 get/set/delete 方法，并编写单元测试',
      adapter,
    });
    final = await runOrchestration(runtime.initialState, {
      workerRuntime: runtime.workerRuntime,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('chain 1: shared State flows through mutations to a done phase', () => {
    expect(final.phase).toBe('done');
    expect(final.testResults?.passed).toBe(true);
    expect(final.testResults?.total).toBe(3);
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

  it('chain 3: LocalTempSandbox persisted real files and executed node --test (exitCode 0)', () => {
    const files = readdirSync(runtime.worktree.path);
    expect(files).toEqual(
      expect.arrayContaining([
        'lru-cache.js',
        'lru-cache.test.js',
        SUBTASK_STATUS_FILE,
        TEST_RESULTS_FILE,
      ]),
    );
    expect(readFileSync(join(runtime.worktree.path, 'lru-cache.js'), 'utf8')).toBe(LRU_SOURCE);
    const result = sandboxRunResultOf(adapter.calls);
    expect(result).toBeDefined();
    expect(result?.exitCode).toBe(0);
    expect(result?.timedOut).toBe(false);
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
