import { readdirSync, readFileSync } from 'node:fs';
import {
  type AppState,
  appendMutation,
  applyMutations,
  COORDINATION_LEDGER_KIND,
  latestCoordinationLedger,
  mergeByIdMutation,
  PHASE0_ROSTER,
  setMutation,
} from '@agora/core-domain';
import { runOrchestration, WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import type { Worktree } from '@agora/runtime-sandbox';
import { createToolCatalog, type ToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertRosterBinding,
  createPhase2Runtime,
  PHASE2_TOOL_SURFACE,
  type Phase2Runtime,
  reviewerTurnMutations,
} from '../../../packages/core/__tests__/e2e/phase2-runtime';

/**
 * Phase 2 exit integration test (task 2.5) — deterministic regression covering
 * the Phase 2 exit criteria:
 *
 *   「PM/ARCHITECT/REVIEWER 补齐，完整回环 + 迭代上限可控」(task-status.json)
 *
 * Six-role loop end to end: 需求(PM)→设计(ARCHITECT)→编码(CODER)→测试(TESTER)
 * →评审(REVIEWER)→finalize, plus both loop paths (test-failure → CODER,
 * review changes_requested → CODER) and the iteration-limit escalation
 * (humanGate + halt, task 2.3 semantics).
 *
 * R11 mock note: the ONLY mocked dependency is the external LLM
 * (`TurnScriptedLlmAdapter`), scripted per role AND per turn so loops are
 * deterministic without an API key. Everything else is real: the Harness agent
 * loop, the MCP fs/git/test servers bridged in-process, the sandbox_run
 * function tool, the real git binary (REVIEWER diffs the CODER's committed
 * patch in-loop), real `node --test` subprocesses, and the LocalTempSandbox.
 * The live-LLM G5 chain stays covered by the Phase 0 e2e (skipIf no key).
 *
 * Deferred-item dispositions verified here (all user-approved for 2.5):
 * - DEF-006: the `git` grant is worktree-scoped; no model role resolves
 *   git_createWorktree/git_merge; ARCHITECT/REVIEWER resolve the diff-only
 *   `git.readonly` surface (chain E).
 * - DEF-008: routing and execution share the DEFAULT_ROSTER binding,
 *   enforced by assertRosterBinding at assembly (chain E).
 * - DEF-010: pendingPatch stays unset for the whole run — the CODER→REVIEWER
 *   patch flow travels via worktree refs (branchOrPatch slice) + git_diff,
 *   proving no State patch-metadata consumer exists (chain 1).
 * - DEF-005: resolved in this PR — the biome-backed lint-server
 *   (packages/tools/lint) lands and the catalog grants `lint_check`; the
 *   REVIEWER exercises it for real in-loop (chain 3) alongside git_diff.
 * - DEF-007: REVIEWER pass → finalize with no leader confirmation step,
 *   per the task 2.2 ruling (chains 1-3).
 */

/** CODER handoff file (Phase 0 protocol, reused). */
const SUBTASK_STATUS_FILE = 'subtask-status.json';
/** TESTER handoff file (Phase 0 protocol, reused). */
const TEST_RESULTS_FILE = 'test-results.json';

describe('REVIEWER structured verdict scope (task 4.3)', () => {
  it('accepts architecture scope and preserves it in the append mutation', () => {
    expect(
      reviewerTurnMutations(
        '[{"id":"rv-1","kind":"verdict","verdict":"changes_requested","issueScope":"architecture","summary":"split boundary"}]',
      ),
    ).toEqual([
      appendMutation('reviewComments', {
        id: 'rv-1',
        kind: 'verdict',
        verdict: 'changes_requested',
        issueScope: 'architecture',
        summary: 'split boundary',
      }),
    ]);
  });

  it('keeps missing issueScope backward-compatible and rejects unknown scopes', () => {
    expect(() =>
      reviewerTurnMutations(
        '[{"id":"rv-1","kind":"verdict","verdict":"changes_requested","issueScope":"style","summary":"wrong scope"}]',
      ),
    ).toThrow(/issueScope/);
    expect(
      reviewerTurnMutations(
        '[{"id":"rv-2","kind":"verdict","verdict":"changes_requested","summary":"fix needed"}]',
      ),
    ).toHaveLength(1);
  });

  it('requires exactly one verdict with a stable non-empty id per turn', () => {
    expect(() => reviewerTurnMutations('[{"id":"c-1","kind":"comment"}]')).toThrow(
      /exactly one verdict/,
    );
    expect(() =>
      reviewerTurnMutations(
        '[{"id":"v-1","kind":"verdict","verdict":"approved","summary":"one"},{"id":"v-2","kind":"verdict","verdict":"approved","summary":"two"}]',
      ),
    ).toThrow(/exactly one verdict/);
    expect(() =>
      reviewerTurnMutations(
        '[{"kind":"verdict","verdict":"changes_requested","summary":"missing id"}]',
      ),
    ).toThrow(/non-empty string id/);
  });
});

const MATH_SOURCE_V1 = `// Simple math module (Phase 2 exit task).
function add(a, b) {
  return a + b;
}

function mul(a, b) {
  return a * b;
}

module.exports = { add, mul };
`;

/** Round-1 bug for the test-failure loop: mul falls back to addition. */
const MATH_SOURCE_BUGGY = `// Simple math module (Phase 2 exit task).
function add(a, b) {
  return a + b;
}

function mul(a, b) {
  return a + b;
}

module.exports = { add, mul };
`;

/** Round-2 revision for the review loop: documented functions. */
const MATH_SOURCE_V2 = `// Simple math module (Phase 2 exit task, reviewed).

/** Sum two numbers. */
function add(a, b) {
  return a + b;
}

/** Multiply two numbers. */
function mul(a, b) {
  return a * b;
}

module.exports = { add, mul };
`;

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

/** Minimal patch the CODER submits via git_applyPatch (add -A sweeps fs-written files). */
const NOTES_PATCH_V1 = [
  'diff --git a/notes.txt b/notes.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes.txt',
  '@@ -0,0 +1 @@',
  '+submitted by CODER via git_applyPatch (round 1)',
  '',
].join('\n');

const NOTES_PATCH_V2 = [
  'diff --git a/notes-2.txt b/notes-2.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes-2.txt',
  '@@ -0,0 +1 @@',
  '+submitted by CODER via git_applyPatch (round 2)',
  '',
].join('\n');

const NOTES_PATCH_V3 = [
  'diff --git a/notes-3.txt b/notes-3.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes-3.txt',
  '@@ -0,0 +1 @@',
  '+submitted by CODER via git_applyPatch (round 3)',
  '',
].join('\n');

/** PM structured output (final message, tool-free role). */
const PM_REQUIREMENTS_JSON = JSON.stringify([
  {
    id: 'req-1',
    story: 'As a user I can add and multiply two numbers via one module',
    acceptance: ['add(2, 3) returns 5', 'mul(2, 3) returns 6'],
    nonGoals: ['no CLI', 'no floating point edge cases'],
  },
]);

/** ARCHITECT structured output (final message, read-only role). */
const ARCHITECT_DESIGN_JSON = JSON.stringify({
  architecture: {
    summary: 'single CommonJS module math.js exposing add/mul',
    interfaces: [
      { name: 'add', module: 'math.js' },
      { name: 'mul', module: 'math.js' },
    ],
  },
  conventions: { moduleSystem: 'commonjs', testRunner: 'node:test' },
});
const ARCHITECT_REDESIGN_JSON = JSON.stringify({
  architecture: {
    summary:
      'separate add and multiply implementations; multiplication must use the product operator',
    interfaces: [
      { name: 'add', module: 'math.js' },
      { name: 'mul', module: 'math.js', invariant: 'returns a * b' },
    ],
  },
  conventions: { moduleSystem: 'commonjs', testRunner: 'node:test' },
});

/** REVIEWER structured outputs (final message, read-only role). */
const REVIEW_APPROVED_JSON = JSON.stringify([
  {
    id: 'rv-approved',
    kind: 'verdict',
    verdict: 'approved',
    summary: 'clean implementation, tests are authoritative',
  },
]);
const REVIEW_CHANGES_JSON = JSON.stringify([
  {
    id: 'rc-implementation',
    kind: 'comment',
    file: 'math.js',
    line: 6,
    note: 'mul must not fall back to addition',
  },
  {
    id: 'rv-implementation',
    kind: 'verdict',
    verdict: 'changes_requested',
    summary: 'mul returns a + b',
  },
]);
const REVIEW_ARCHITECTURE_JSON = JSON.stringify([
  {
    id: 'rc-architecture',
    kind: 'comment',
    summary: 'the design does not state the multiplication invariant',
  },
  {
    id: 'rv-architecture',
    kind: 'verdict',
    verdict: 'changes_requested',
    issueScope: 'architecture',
    summary: 'the module contract permits addition in mul',
  },
]);

const PASSED_RESULTS = { passed: true, total: 2, failed: 0, failures: [] };
const FAILED_RESULTS = {
  passed: false,
  total: 2,
  failed: 1,
  failures: [
    {
      test: 'mul multiplies two numbers',
      message: 'Expected values to be strictly equal: 5 !== 6',
      file: 'math.test.js',
      line: 9,
    },
  ],
};

interface ScriptedAction {
  tool: 'fs_write' | 'fs_read' | 'git_applyPatch' | 'git_diff' | 'lint_check' | 'sandbox_run';
  args: Record<string, unknown>;
}

/** One turn of one role: the tool calls it makes, then its final message. */
interface ScriptedTurn {
  readonly actions: readonly ScriptedAction[];
  readonly final: string;
}

type RoleTurns = Readonly<Record<string, readonly ScriptedTurn[]>>;

const CODER_TURN = (source: string, patch: string): ScriptedTurn => ({
  actions: [
    { tool: 'fs_write', args: { path: 'math.js', content: source } },
    { tool: 'git_applyPatch', args: { patch } },
    {
      tool: 'fs_write',
      args: { path: SUBTASK_STATUS_FILE, content: JSON.stringify({ status: 'done' }) },
    },
  ],
  final: 'Implemented math.js and committed the patch.',
});

const TESTER_TURN = (results: object): ScriptedTurn => ({
  actions: [
    { tool: 'fs_write', args: { path: 'math.test.js', content: MATH_TEST_SOURCE } },
    { tool: 'sandbox_run', args: { cmd: 'node --test math.test.js' } },
    {
      tool: 'fs_write',
      args: { path: TEST_RESULTS_FILE, content: JSON.stringify(results) },
    },
  ],
  final: 'Tests executed; recorded test-results.json.',
});

const REVIEWER_TURN = (verdictJson: string): ScriptedTurn => ({
  actions: [
    { tool: 'git_diff', args: { ref: 'HEAD~1' } },
    { tool: 'fs_read', args: { path: 'math.js' } },
    { tool: 'lint_check', args: { paths: ['math.js'] } },
  ],
  final: verdictJson,
});

/** Six-role happy path: every stage passes on the first turn. */
const HAPPY_TURNS: RoleTurns = {
  PM: [{ actions: [], final: PM_REQUIREMENTS_JSON }],
  ARCHITECT: [{ actions: [], final: ARCHITECT_DESIGN_JSON }],
  CODER: [CODER_TURN(MATH_SOURCE_V1, NOTES_PATCH_V1)],
  TESTER: [TESTER_TURN(PASSED_RESULTS)],
  REVIEWER: [REVIEWER_TURN(REVIEW_APPROVED_JSON)],
};

/** Test-failure loop: round 1 fails, CODER fixes, round 2 passes. */
const TEST_LOOP_TURNS: RoleTurns = {
  PM: [{ actions: [], final: PM_REQUIREMENTS_JSON }],
  ARCHITECT: [{ actions: [], final: ARCHITECT_DESIGN_JSON }],
  CODER: [
    CODER_TURN(MATH_SOURCE_BUGGY, NOTES_PATCH_V1),
    CODER_TURN(MATH_SOURCE_V1, NOTES_PATCH_V2),
  ],
  TESTER: [TESTER_TURN(FAILED_RESULTS), TESTER_TURN(PASSED_RESULTS)],
  REVIEWER: [REVIEWER_TURN(REVIEW_APPROVED_JSON)],
};

/** Review loop: round 1 changes_requested, CODER revises, round 2 approved. */
const REVIEW_LOOP_TURNS: RoleTurns = {
  PM: [{ actions: [], final: PM_REQUIREMENTS_JSON }],
  ARCHITECT: [{ actions: [], final: ARCHITECT_DESIGN_JSON }],
  CODER: [CODER_TURN(MATH_SOURCE_V1, NOTES_PATCH_V1), CODER_TURN(MATH_SOURCE_V2, NOTES_PATCH_V2)],
  TESTER: [TESTER_TURN(PASSED_RESULTS), TESTER_TURN(PASSED_RESULTS)],
  REVIEWER: [REVIEWER_TURN(REVIEW_CHANGES_JSON), REVIEWER_TURN(REVIEW_APPROVED_JSON)],
};

/** Feedback escalation: two failures → REVIEWER root cause → ARCHITECT redesign → green. */
const ESCALATION_TURNS: RoleTurns = {
  PM: [{ actions: [], final: PM_REQUIREMENTS_JSON }],
  ARCHITECT: [
    { actions: [], final: ARCHITECT_DESIGN_JSON },
    { actions: [], final: ARCHITECT_REDESIGN_JSON },
  ],
  CODER: [
    CODER_TURN(MATH_SOURCE_BUGGY, NOTES_PATCH_V1),
    CODER_TURN(MATH_SOURCE_BUGGY, NOTES_PATCH_V2),
    CODER_TURN(MATH_SOURCE_V1, NOTES_PATCH_V3),
  ],
  TESTER: [TESTER_TURN(FAILED_RESULTS), TESTER_TURN(FAILED_RESULTS), TESTER_TURN(PASSED_RESULTS)],
  REVIEWER: [REVIEWER_TURN(REVIEW_ARCHITECTURE_JSON), REVIEWER_TURN(REVIEW_APPROVED_JSON)],
};

/** Iteration-limit escalation: seeded one round below the cap, tests keep failing. */
const LIMIT_TURNS: RoleTurns = {
  CODER: [
    {
      actions: [{ tool: 'fs_write', args: { path: 'retry.txt', content: 'another attempt' } }],
      final: 'Another attempt submitted.',
    },
  ],
  TESTER: [
    {
      actions: [
        { tool: 'sandbox_run', args: { cmd: 'node -e "process.exit(1)"' } },
        {
          tool: 'fs_write',
          args: { path: TEST_RESULTS_FILE, content: JSON.stringify(FAILED_RESULTS) },
        },
      ],
      final: 'Still failing; recorded test-results.json.',
    },
  ],
};

/**
 * Scripted LLM (R11: external dependency only). Turns are detected from the
 * message stream itself: each turn's first request carries the fresh projection
 * with zero tool results (decision D1 pre-step overwrite), so completed === 0
 * advances the per-role turn index. Every scripted tool call executes on the
 * REAL ToolRuntime against the REAL sandbox/worktree.
 */
class TurnScriptedLlmAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  private readonly turnIndexOf = new Map<string, number>();
  private callSeq = 0;

  constructor(private readonly turns: RoleTurns) {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    const role = projectionRoleOf(options);
    const completed = completedActionsOf(options);
    if (completed === 0) {
      this.turnIndexOf.set(role, (this.turnIndexOf.get(role) ?? -1) + 1);
    }
    const turn = this.turns[role]?.[this.turnIndexOf.get(role) ?? 0];
    const action = turn?.actions[completed];
    if (turn === undefined || action === undefined) {
      yield* textChunks(turn?.final ?? 'done');
      return;
    }
    yield* toolCallChunks(action, CallId(`call-${this.callSeq++}`));
  }
}

/** Parse the projected role from the first message (the pre-step projection). */
function projectionRoleOf(call: GenerateOptions): string {
  const view = projectionViewOf(call);
  if (typeof view.role !== 'string') {
    throw new Error('scripted adapter expected a role in the projection');
  }
  return view.role;
}

function projectionViewOf(call: GenerateOptions): {
  role?: unknown;
  slices?: Record<string, unknown>;
} {
  const first = call.messages[0];
  const block = first === undefined ? undefined : first.content.find((b) => b.type === 'text');
  if (block === undefined || block.type !== 'text') {
    throw new Error('scripted adapter expected the projection as the first message block');
  }
  return JSON.parse(block.text) as { role?: unknown; slices?: Record<string, unknown> };
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
  return toolResultsOf(calls, toolName)[0];
}

/** All parsed tool-result payloads of every executed `toolName` call, in order.
 * Deduped by call id (a turn's later requests replay earlier tool-result blocks);
 * error results carry plain-text messages (not JSON) and are surfaced verbatim. */
function toolResultsOf(calls: readonly GenerateOptions[], toolName: string): unknown[] {
  const byCallId = new Map<string, unknown>();
  for (const call of calls) {
    for (const message of call.messages) {
      for (const block of message.content) {
        if (block.type !== 'tool-call' || block.name !== toolName) continue;
        const callId = block.id;
        if (byCallId.has(callId)) continue;
        for (const other of call.messages) {
          for (const result of other.content) {
            if (result.type !== 'tool-result' || result.toolCallId !== callId) continue;
            const text = result.content.find((t) => t.type === 'text');
            if (text?.type === 'text') {
              try {
                byCallId.set(callId, JSON.parse(text.text) as unknown);
              } catch {
                byCallId.set(callId, text.text);
              }
            }
          }
        }
      }
    }
  }
  return [...byCallId.values()];
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

/** Assemble + run one scripted six-role orchestration to quiescence. */
async function runScriptedScenario(
  taskId: string,
  turns: RoleTurns,
  seed?: (initial: AppState) => AppState,
): Promise<{ runtime: Phase2Runtime; final: AppState; adapter: TurnScriptedLlmAdapter }> {
  const adapter = new TurnScriptedLlmAdapter(turns);
  const runtime = await createPhase2Runtime({
    taskId,
    goal: '实现一个支持加法和乘法的 math 模块，并编写单元测试',
    adapter,
  });
  const initial = seed === undefined ? runtime.initialState : seed(runtime.initialState);
  const final = await runOrchestration(initial, {
    workerRuntime: runtime.workerRuntime,
    roster: runtime.roster,
  });
  return { runtime, final, adapter };
}

function roleCalls(adapter: TurnScriptedLlmAdapter, role: string): GenerateOptions[] {
  return adapter.calls.filter((c) => projectionRoleOf(c) === role);
}

describe('Phase 2 exit: six-role happy path (scripted LLM, real MCP fs/git + LocalTemp sandbox)', () => {
  let runtime: Phase2Runtime;
  let final: AppState;
  let adapter: TurnScriptedLlmAdapter;

  beforeAll(async () => {
    ({ runtime, final, adapter } = await runScriptedScenario('exit-2-happy', HAPPY_TURNS));
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('chain 1: full loop 需求→设计→编码→测试→评审→finalize with all structured state landed', () => {
    expect(final.phase).toBe('done');
    // PM requirements (mergeById upsert through the final-text seam).
    expect(final.requirements).toHaveLength(1);
    expect(final.requirements[0]?.id).toBe('req-1');
    expect(final.requirements[0]?.acceptance).toEqual([
      'add(2, 3) returns 5',
      'mul(2, 3) returns 6',
    ]);
    // ARCHITECT design + conventions (set through the final-text seam).
    expect(final.architecture).toBeDefined();
    expect(final.conventions).toEqual({ moduleSystem: 'commonjs', testRunner: 'node:test' });
    // CODER/TESTER file protocol + REVIEWER verdict.
    expect(final.subtasks[0]?.status).toBe('done');
    expect(final.testResults?.passed).toBe(true);
    expect(final.testResults?.total).toBe(2);
    expect(final.reviewComments).toHaveLength(1);
    expect(final.reviewComments[0]).toMatchObject({ kind: 'verdict', verdict: 'approved' });
    // Loop bookkeeping: one round total (PM 提炼需求计一轮, coordinator 语义).
    expect(final.iterationCount).toBe(1);
    // All six roles spoke in the group chat.
    const roles = final.messages.map((message) => message.fromRole);
    for (const role of ['COORDINATOR', 'PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER']) {
      expect(roles).toContain(role);
    }
    // DEF-010: pendingPatch stayed unset for the whole run — the patch flow
    // travels via worktree refs (branchOrPatch) + git_diff, no State metadata.
    expect(final.pendingPatch).toBeUndefined();
    // DEF-007: REVIEWER pass → finalize directly (no leader confirmation gate).
    expect(final.humanGate).toBeUndefined();
  });

  it('chain 2: every role ran on the Harness loop; workers quiesced with tool work', () => {
    for (const role of ['PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER']) {
      const calls = roleCalls(adapter, role);
      expect(calls.length).toBeGreaterThanOrEqual(1);
    }
    // Tool-carrying workers made real tool calls; PM/ARCHITECT are scripted
    // pure-reasoning turns (no §2-granted tools in this scenario).
    for (const role of ['CODER', 'TESTER', 'REVIEWER']) {
      expect(roleCalls(adapter, role).some((c) => completedActionsOf(c) > 0)).toBe(true);
    }
  });

  it('chain 2b (task 4.4/DEF-012): Coordinator generates Ledger + handoffs without manual seeds', () => {
    const ledgers = final.messages.filter(
      (message) => message.payload.kind === COORDINATION_LEDGER_KIND,
    );
    expect(ledgers.length).toBeGreaterThanOrEqual(6);
    expect(latestCoordinationLedger(final)).toMatchObject({
      completionCandidate: true,
      progress: {
        isRequestSatisfied: {
          reason: 'awaiting_leader_confirmation',
          answer: false,
          authority: 'leader',
        },
      },
    });

    expect(final.handoffPackets.map((packet) => `${packet.fromRole}->${packet.toRole}`)).toEqual([
      'PM->ARCHITECT',
      'ARCHITECT->CODER',
      'CODER->TESTER',
      'TESTER->REVIEWER',
    ]);
    for (const packet of final.handoffPackets) {
      expect(packet.done.length).toBeGreaterThan(0);
      expect(packet.keyDecisions).toEqual([]);
    }

    const firstCoderCall = roleCalls(adapter, 'CODER')[0];
    if (firstCoderCall === undefined) throw new Error('missing CODER call');
    const coderContext = projectionViewOf(firstCoderCall).slices?.coordinationContext as
      | {
          plan?: { role?: unknown }[];
          instructionOrQuestion?: unknown;
        }
      | undefined;
    expect(coderContext?.plan?.map((step) => step.role)).toEqual(['CODER']);
    expect(typeof coderContext?.instructionOrQuestion).toBe('string');
    const contextJson = JSON.stringify(coderContext);
    expect(contextJson).not.toContain('channelId');
    expect(contextJson).not.toContain('fromRole');
    expect(contextJson).not.toContain('progressMarker');
  });

  it('chain 3: real worktree artifacts — committed patch, real node --test, real git diff', () => {
    const files = readdirSync(runtime.worktree.path);
    expect(files).toEqual(
      expect.arrayContaining([
        'math.js',
        'math.test.js',
        'notes.txt',
        SUBTASK_STATUS_FILE,
        TEST_RESULTS_FILE,
      ]),
    );
    expect(readFileSync(`${runtime.worktree.path}/math.js`, 'utf8')).toBe(MATH_SOURCE_V1);
    // CODER submitted via the real git binary (worktree-scoped applyPatch).
    const patched = toolResultOf(adapter.calls, 'git_applyPatch') as
      | { commitId: string }
      | undefined;
    expect(patched?.commitId).toMatch(/^[0-9a-f]{40}$/);
    // Real node --test subprocess, structured pass.
    const run = toolResultOf(adapter.calls, 'sandbox_run') as
      | { exitCode: number | null; stdout: string; timedOut: boolean }
      | undefined;
    expect(run?.exitCode).toBe(0);
    expect(run?.stdout).toContain('pass 2');
    expect(run?.timedOut).toBe(false);
    // REVIEWER's git_diff saw the committed change (read-only git surface, in-loop).
    const diff = toolResultOf(adapter.calls, 'git_diff');
    expect(typeof diff).toBe('string');
    expect(diff as string).toContain('math.js');
    // DEF-005 resolved: REVIEWER's in-loop lint grant runs real Biome; the
    // scripted math.js is lint-clean.
    const lintIssues = toolResultsOf(adapter.calls, 'lint_check');
    expect(lintIssues.length).toBeGreaterThanOrEqual(1);
    expect(lintIssues[0]).toEqual([]);
  });

  it('chain 4: pre-step overwrites the LLM input with the per-role projection (R2/D1)', () => {
    const projectionOf = (role: string): { role: string; slices: Record<string, unknown> } => {
      const first = roleCalls(adapter, role)[0];
      if (first === undefined) throw new Error(`no scripted LLM call recorded for role ${role}`);
      const textBlock = first.messages[0]?.content.find((b) => b.type === 'text');
      if (textBlock?.type !== 'text') {
        throw new Error(`expected the projection as the first message block for ${role}`);
      }
      expect(completedActionsOf(first)).toBe(0);
      return JSON.parse(textBlock.text) as { role: string; slices: Record<string, unknown> };
    };
    for (const role of ['PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER']) {
      const view = projectionOf(role);
      expect(view.role).toBe(role);
      const slicesJson = JSON.stringify(view.slices);
      // Iron rule 1: never the raw group-chat log.
      expect(slicesJson).not.toContain('channelId');
      expect(slicesJson).not.toContain('fromRole');
      expect(slicesJson).not.toContain('msgId');
    }
    // Slice-table spot checks (task 2.4 §7 slices, per-role 只读切片).
    expect(projectionOf('PM').slices.goal).toEqual({
      goal: '实现一个支持加法和乘法的 math 模块，并编写单元测试',
    });
    expect(projectionOf('ARCHITECT').slices.repoStructure).toEqual({});
    expect(
      (projectionOf('CODER').slices.assignedSubtask as { worktree: string }[])[0]?.worktree,
    ).toBe(runtime.worktree.path);
    expect(
      (projectionOf('TESTER').slices.acceptance as { requirements: { id: string }[] })
        .requirements[0]?.id,
    ).toBe('req-1');
    expect(
      (projectionOf('TESTER').slices.interfaceContracts as { name: string }[]).map(
        (entry) => entry.name,
      ),
    ).toEqual(['add', 'mul']);
    expect(projectionOf('REVIEWER').slices.pendingPatch).toBeNull();
    expect(projectionOf('REVIEWER').slices.conventions).toEqual({
      moduleSystem: 'commonjs',
      testRunner: 'node:test',
    });
    // Mid-turn tool exchanges survive on later requests (D1 calibration).
    for (const role of ['CODER', 'TESTER', 'REVIEWER']) {
      const last = roleCalls(adapter, role).at(-1);
      expect(last?.messages.some((m) => m.content.some((b) => b.type === 'tool-call'))).toBe(true);
      expect(last?.messages.some((m) => m.content.some((b) => b.type === 'tool-result'))).toBe(
        true,
      );
    }
  });
});

describe('Phase 2 exit: test-failure loop (coding↔testing 回环)', () => {
  let runtime: Phase2Runtime;
  let final: AppState;
  let adapter: TurnScriptedLlmAdapter;

  beforeAll(async () => {
    ({ runtime, final, adapter } = await runScriptedScenario('exit-2-testloop', TEST_LOOP_TURNS));
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('failed tests feed back to CODER, the fix passes, and the run finalizes at iteration 2', () => {
    expect(final.phase).toBe('done');
    // PM 提炼一轮 + 测试回环一轮.
    expect(final.iterationCount).toBe(2);
    expect(final.testResults?.passed).toBe(true);
    const feedback = final.messages.find(
      (message) => message.type === 'feedback' && message.payload.reason === 'tests_failed',
    );
    expect(feedback).toBeDefined();
    // Real subprocess evidence: round 1 genuinely failed, round 2 genuinely passed.
    const runs = toolResultsOf(adapter.calls, 'sandbox_run') as { exitCode: number | null }[];
    expect(runs.map((run) => run.exitCode)).toEqual([1, 0]);
    // CODER ran exactly two turns (buggy then fixed).
    const coderTurns = roleCalls(adapter, 'CODER').filter((c) => completedActionsOf(c) === 0);
    expect(coderTurns).toHaveLength(2);
    expect(final.reviewComments[0]).toMatchObject({ verdict: 'approved' });
  });
});

describe('Phase 2 exit: review loop (review↔coding 回环, DEF-007 simplification asserted)', () => {
  let runtime: Phase2Runtime;
  let final: AppState;

  beforeAll(async () => {
    ({ runtime, final } = await runScriptedScenario('exit-2-revloop', REVIEW_LOOP_TURNS));
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('changes_requested feeds back to CODER with comments, then approval finalizes at iteration 2', () => {
    expect(final.phase).toBe('done');
    // PM 提炼一轮 + 评审回环一轮.
    expect(final.iterationCount).toBe(2);
    // Round 1: one comment + the changes_requested verdict; round 2: approval.
    expect(final.reviewComments).toHaveLength(3);
    expect(final.reviewComments[0]).toMatchObject({ kind: 'comment', file: 'math.js' });
    expect(final.reviewComments[1]).toMatchObject({
      kind: 'verdict',
      verdict: 'changes_requested',
    });
    expect(final.reviewComments[2]).toMatchObject({ kind: 'verdict', verdict: 'approved' });
    const feedback = final.messages.find(
      (message) =>
        message.type === 'feedback' && message.payload.reason === 'review_changes_requested',
    );
    expect(feedback).toBeDefined();
    // The revised source actually landed (review round trip is real).
    expect(readFileSync(`${runtime.worktree.path}/math.js`, 'utf8')).toBe(MATH_SOURCE_V2);
    // DEF-007: approval converges without a leader gate in Phase 2.
    expect(final.humanGate).toBeUndefined();
  });
});

describe('Phase 2 exit: feedback escalation reaches informed REVIEWER and ARCHITECT (task 4.3)', () => {
  let runtime: Phase2Runtime;
  let final: AppState;
  let adapter: TurnScriptedLlmAdapter;

  beforeAll(async () => {
    ({ runtime, final, adapter } = await runScriptedScenario(
      'exit-2-feedback-escalation',
      ESCALATION_TURNS,
    ));
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('runs two failures through root-cause review and architecture redesign to done', () => {
    expect(final.phase).toBe('done');
    expect(final.testResults?.passed).toBe(true);
    expect(final.complexity?.signals.escalation).toMatchObject({
      reason: 'reviewer_architecture_issue',
      reviewCommentId: 'rv-architecture',
    });
    expect(toolResultsOf(adapter.calls, 'sandbox_run')).toMatchObject([
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 0 },
    ]);
  });

  it('projects structured failure evidence to REVIEWER without raw message metadata', () => {
    const reviewerStarts = roleCalls(adapter, 'REVIEWER').filter(
      (call) => completedActionsOf(call) === 0,
    );
    expect(reviewerStarts).toHaveLength(2);
    const rootCause = projectionViewOf(reviewerStarts[0] as GenerateOptions).slices;
    expect(rootCause?.reviewContext).toEqual({
      mode: 'test_failure_root_cause',
      reason: 'repeated_test_failures',
      failureStreak: 2,
    });
    expect(rootCause?.failingTests).toMatchObject({ passed: false, failed: 1 });
    expect(rootCause?.fileRefs).toEqual([{ file: 'math.test.js', lines: [9] }]);
    expect(JSON.stringify(rootCause)).not.toContain('channelId');
    expect(JSON.stringify(rootCause)).not.toContain('fromRole');
  });

  it('projects the exact architecture verdict and current design to the redesign turn', () => {
    const architectStarts = roleCalls(adapter, 'ARCHITECT').filter(
      (call) => completedActionsOf(call) === 0,
    );
    expect(architectStarts).toHaveLength(2);
    const redesign = projectionViewOf(architectStarts[1] as GenerateOptions).slices;
    expect(redesign?.architecture).toMatchObject({
      summary: 'single CommonJS module math.js exposing add/mul',
    });
    expect(redesign?.reviewFeedback).toMatchObject({
      verdict: {
        id: 'rv-architecture',
        issueScope: 'architecture',
        summary: 'the module contract permits addition in mul',
      },
    });
  });
});

describe('Phase 2 exit: iteration limit escalation (超限升级, task 2.3 semantics)', () => {
  let runtime: Phase2Runtime;
  let final: AppState;
  let adapter: TurnScriptedLlmAdapter;

  beforeAll(async () => {
    ({ runtime, final, adapter } = await runScriptedScenario(
      'exit-2-limit',
      LIMIT_TURNS,
      (initial) =>
        applyMutations(initial, [
          // Mid-loop seed: the subtask an active CODER↔TESTER round would have
          // in_progress (coordinator-owned lifecycle, task 4.2).
          mergeByIdMutation('subtasks', 'exit-2-limit-sub-0', { status: 'in_progress' }),
          setMutation('iterationCount', 7),
          setMutation('phase', 'testing'),
          setMutation('testResults', FAILED_RESULTS),
        ]),
    ));
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('the capped loop halts at humanGate with an escalation message, bounded work', () => {
    // One more CODER round + one TESTER round after the seed, then the cap.
    expect(final.iterationCount).toBe(8);
    expect(final.phase).toBe('testing');
    expect(final.humanGate).toEqual({
      reason: 'iteration_limit',
      options: ['extend', 'take-over', 'abort'],
      phase: 'testing',
    });
    const escalation = final.messages.find((message) => message.type === 'escalation');
    expect(escalation).toBeDefined();
    expect(escalation?.payload).toMatchObject({ reason: 'iteration_limit', limit: 8 });
    // Bounded: TESTER ran exactly one scripted turn (2 tool calls + final),
    // REVIEWER never dispatched, phase not forced to done.
    expect(roleCalls(adapter, 'TESTER')).toHaveLength(3);
    expect(roleCalls(adapter, 'REVIEWER')).toHaveLength(0);
  });
});

describe('Phase 2 exit: DEF-006 git grant granularity (§2 matrix, direct catalog chain)', () => {
  it('resolves worktree-scoped git for CODER/TESTER and diff-only for ARCHITECT/REVIEWER', async () => {
    const { catalog, dispose } = await catalogFixture();
    try {
      const resolveOf = (role: string) => {
        const spec = DEFAULT_ROSTER.find((entry) => entry.role === role);
        if (spec === undefined) throw new Error(`roster missing role ${role}`);
        return catalog.resolve(spec.tools.filter((tool) => PHASE2_TOOL_SURFACE.includes(tool)));
      };
      // Read-only roles: fs.read + git.readonly (ARCH has no lint per the matrix).
      const architect = resolveOf('ARCHITECT');
      expect(architect.allowNames).toEqual(['fs_read', 'git_diff']);
      expect(architect.unavailable).toEqual([]);
      // DEF-005 resolved in this PR: REVIEWER's lint grant resolves the
      // biome-backed lint-server.
      const reviewer = resolveOf('REVIEWER');
      expect(reviewer.allowNames).toEqual(['fs_read', 'git_diff', 'lint_check']);
      expect(reviewer.unavailable).toEqual([]);
      // Worker roles: worktree-scoped git (applyPatch + diff), NO main-repo mutations.
      const coder = resolveOf('CODER');
      expect(coder.allowNames).toEqual([
        'fs_read',
        'fs_write',
        'sandbox_run',
        'git_applyPatch',
        'git_diff',
        'lint_check',
      ]);
      expect(coder.unavailable).toEqual([]);
      const tester = resolveOf('TESTER');
      expect(tester.allowNames).toEqual([
        'fs_read',
        'fs_write',
        'sandbox_run',
        'git_applyPatch',
        'git_diff',
      ]);
      // No model role resolves the main-repo mutation tools (composition-root/integrate ops).
      for (const role of ['COORDINATOR', 'PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER']) {
        expect(resolveOf(role).allowNames).not.toContain('git_createWorktree');
        expect(resolveOf(role).allowNames).not.toContain('git_merge');
      }
      // Tool-free roles stay tool-free.
      expect(resolveOf('COORDINATOR').allowNames).toEqual([]);
      expect(resolveOf('PM').allowNames).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

describe('Phase 2 exit: DEF-008 roster binding (composition-root invariant)', () => {
  it('passes on the shared DEFAULT_ROSTER binding and fails loudly on a mismatch', async () => {
    const adapter = new TurnScriptedLlmAdapter({});
    const runtime = await createPhase2Runtime({
      taskId: 'exit-2-binding',
      goal: 'binding probe',
      adapter,
    });
    try {
      // The composition root shares ONE roster constant for routing + execution.
      expect(runtime.roster).toBe(DEFAULT_ROSTER);
      expect(() => assertRosterBinding(runtime.roster, runtime.workerRuntime)).not.toThrow();
      // A routing roster declaring roles the runtime lacks fails at assembly,
      // not as a late UnknownRoleError at dispatch time.
      const mismatched = new WorkerRuntime({
        roster: PHASE0_ROSTER,
        buildExecutor: () => {
          throw new Error('never built in this probe');
        },
      });
      expect(() => assertRosterBinding(DEFAULT_ROSTER, mismatched)).toThrow(/PM/);
    } finally {
      await runtime.dispose();
    }
  });
});

/** Direct-catalog fixture (real MCP servers + real sandbox, no orchestration). */
async function catalogFixture(): Promise<{
  catalog: ToolCatalog;
  worktree: Worktree;
  dispose(): Promise<void>;
}> {
  const { LocalTempSandbox } = await import('@agora/runtime-sandbox');
  const sandbox = new LocalTempSandbox();
  const worktree = await sandbox.createWorktree('exit-2-catalog', 'shared');
  const registry = new WorktreeRegistry();
  registry.register(worktree.path);
  const catalog = await createToolCatalog({
    registry,
    sandbox,
    getWorktree: async () => worktree,
  });
  return {
    catalog,
    worktree,
    dispose: async () => {
      await catalog.dispose();
      await sandbox.teardown('exit-2-catalog');
    },
  };
}
