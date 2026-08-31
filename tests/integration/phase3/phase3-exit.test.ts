import {
  type AppState,
  appendMutation,
  applyMutations,
  createInitialAppState,
  type Decision,
  type HandoffPacket,
} from '@agora/core-domain';
import { runOrchestration } from '@agora/core-orchestration';
import { SLICE_COMPRESSION_THRESHOLD_CHARS } from '@agora/runtime-executor';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPhase2Runtime,
  type Phase2Runtime,
} from '../../../packages/core/__tests__/e2e/phase2-runtime';

/**
 * Phase 3 exit integration test (task 3.5) — deterministic regression covering
 * the Phase 3 exit criteria:
 *
 *   「上下文不随对话变长而崩：台账/交接/投影/压缩四机制就位」(task-status.json)
 *   长对话场景回归：上下文规模受控、决策理由可达、交接无损。
 *
 * One scripted six-role orchestration over a LONG-conversation State (a seeded
 * decision ledger past the compression threshold, with supersede chains and
 * handoff packets) proves the four mechanisms cooperate on the real D1
 * pre-step consumption chain:
 *
 *   ledger (State + R1 seam) → projection (pre-step overwrite) →
 *   compression (read-time collapse) → handoff (reducer-gated, lossless).
 *
 * A short-conversation control run proves the mechanism adapts (below the
 * threshold the slice stays verbatim), and a direct-seam chain proves the
 * ledger authority invariant (leader > agent) is enforced at the State write
 * gate, not just in the pure functions.
 *
 * R11 mock note: the ONLY mocked dependency is the external LLM
 * (`TurnScriptedLlmAdapter`, scripted per role per turn like the Phase 2 exit
 * test). Everything else is real: the Harness agent loop, the pre-step
 * projection overwrite, the real MCP fs/git servers, the real git binary, real
 * `node --test` subprocesses, and the LocalTempSandbox. The live-LLM G5 chain
 * stays covered by the Phase 0 e2e (skipIf no key).
 *
 * Non-duplication note: the collapse algorithm's unit semantics (chain order,
 * cross-topic guards, determinism, threshold boundary) live in
 * packages/runtime/executor/test/slice-compression.test.ts and project.test.ts.
 * This suite only asserts their integration behavior end to end.
 */

/* ------------------------------------------------------------------ *
 * Scripted six-role happy path (reused verbatim from the Phase 2 exit *
 * test so the loop reaches `done` deterministically).                 *
 * ------------------------------------------------------------------ */

const SUBTASK_STATUS_FILE = 'subtask-status.json';
const TEST_RESULTS_FILE = 'test-results.json';

const MATH_SOURCE_V1 = `// Simple math module (Phase 3 exit task).
function add(a, b) {
  return a + b;
}

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

const NOTES_PATCH_V1 = [
  'diff --git a/notes.txt b/notes.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes.txt',
  '@@ -0,0 +1 @@',
  '+submitted by CODER via git_applyPatch (phase 3 exit)',
  '',
].join('\n');

const PM_REQUIREMENTS_JSON = JSON.stringify([
  {
    id: 'req-1',
    story: 'As a user I can add and multiply two numbers via one module',
    acceptance: ['add(2, 3) returns 5', 'mul(2, 3) returns 6'],
    nonGoals: ['no CLI', 'no floating point edge cases'],
  },
]);

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

const REVIEW_APPROVED_JSON = JSON.stringify([
  {
    id: 'rv-phase3-approved',
    kind: 'verdict',
    verdict: 'approved',
    summary: 'clean implementation, tests are authoritative',
  },
]);

const PASSED_RESULTS = { passed: true, total: 2, failed: 0, failures: [] };

interface ScriptedAction {
  tool: 'fs_write' | 'fs_read' | 'git_applyPatch' | 'git_diff' | 'sandbox_run';
  args: Record<string, unknown>;
}

interface ScriptedTurn {
  readonly actions: readonly ScriptedAction[];
  readonly final: string;
}

type RoleTurns = Readonly<Record<string, readonly ScriptedTurn[]>>;

const CODER_TURN: ScriptedTurn = {
  actions: [
    { tool: 'fs_write', args: { path: 'math.js', content: MATH_SOURCE_V1 } },
    { tool: 'git_applyPatch', args: { patch: NOTES_PATCH_V1 } },
    {
      tool: 'fs_write',
      args: { path: SUBTASK_STATUS_FILE, content: JSON.stringify({ status: 'done' }) },
    },
  ],
  final: 'Implemented math.js and committed the patch.',
};

const TESTER_TURN: ScriptedTurn = {
  actions: [
    { tool: 'fs_write', args: { path: 'math.test.js', content: MATH_TEST_SOURCE } },
    { tool: 'sandbox_run', args: { cmd: 'node --test math.test.js' } },
    {
      tool: 'fs_write',
      args: { path: TEST_RESULTS_FILE, content: JSON.stringify(PASSED_RESULTS) },
    },
  ],
  final: 'Tests executed; recorded test-results.json.',
};

const REVIEWER_TURN: ScriptedTurn = {
  actions: [
    { tool: 'git_diff', args: { ref: 'HEAD~1' } },
    { tool: 'fs_read', args: { path: 'math.js' } },
  ],
  final: REVIEW_APPROVED_JSON,
};

const HAPPY_TURNS: RoleTurns = {
  PM: [{ actions: [], final: PM_REQUIREMENTS_JSON }],
  ARCHITECT: [{ actions: [], final: ARCHITECT_DESIGN_JSON }],
  CODER: [CODER_TURN],
  TESTER: [TESTER_TURN],
  REVIEWER: [REVIEWER_TURN],
};

/* ------------------------------------------------------------------ *
 * Scripted LLM (R11: external dependency only) — same mechanics as    *
 * the Phase 2 exit test's TurnScriptedLlmAdapter.                     *
 * ------------------------------------------------------------------ */

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

function completedActionsOf(call: GenerateOptions): number {
  return call.messages.reduce(
    (count, message) => count + message.content.filter((b) => b.type === 'tool-result').length,
    0,
  );
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
  yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 16 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function* textChunks(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 16 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function roleCalls(adapter: TurnScriptedLlmAdapter, role: string): GenerateOptions[] {
  return adapter.calls.filter((c) => projectionRoleOf(c) === role);
}

/** The parsed ProjectionView of a role's first scripted request (D1 pre-step overwrite). */
function firstProjectionOf(
  adapter: TurnScriptedLlmAdapter,
  role: string,
): {
  role: string;
  slices: Record<string, unknown>;
} {
  const first = roleCalls(adapter, role)[0];
  if (first === undefined) throw new Error(`no scripted LLM call recorded for role ${role}`);
  const block = first.messages[0]?.content.find((b) => b.type === 'text');
  if (block?.type !== 'text') {
    throw new Error(`expected the projection as the first message block for ${role}`);
  }
  expect(completedActionsOf(first)).toBe(0);
  return JSON.parse(block.text) as { role: string; slices: Record<string, unknown> };
}

/* ------------------------------------------------------------------ *
 * Seed builders — State grows through the R1 path only                *
 * (applyMutations over appendMutation('decisionLedger'/'handoffPackets')). *
 * ------------------------------------------------------------------ */

/** Long-conversation filler: pushes the serialized leader slice past the threshold. */
const LONG_RATIONALE_FILLER = 'a'.repeat(600);

interface SeedDecisionSpec {
  readonly id: string;
  readonly topic: string;
  readonly supersedes?: string;
  readonly authority?: 'leader' | 'agent';
}

function decisionOf(spec: SeedDecisionSpec, index: number, filler: string): Decision {
  const authority = spec.authority ?? 'leader';
  return {
    id: spec.id,
    topic: spec.topic,
    decision: `ruling ${spec.id} on ${spec.topic}`,
    rationale: `rationale for ${spec.id}: ${filler}`,
    authority,
    by: authority === 'leader' ? 'leader' : 'PM',
    ...(spec.supersedes === undefined ? {} : { supersedes: spec.supersedes }),
    ts: 1_700_000_000_000 + index,
  };
}

/**
 * Long-conversation ledger (8 entries, 7 leader + 1 agent):
 * - api-shape: d-long-1 superseded by head d-long-2
 * - storage:   d-long-3 → d-long-4 → head d-long-5 (chain of three)
 * - test-runner: head d-long-6 (never superseded)
 * - observability: head d-long-7 whose supersedes points CROSS-topic at
 *   d-long-2 (api-shape) — collapse is topic-scoped, so d-long-2 stays a head.
 * - d-agent-1: agent authority — projected leader slice excludes it (3.3).
 */
const LONG_DECISION_SPECS: readonly SeedDecisionSpec[] = [
  { id: 'd-long-1', topic: 'api-shape' },
  { id: 'd-long-2', topic: 'api-shape', supersedes: 'd-long-1' },
  { id: 'd-long-3', topic: 'storage' },
  { id: 'd-long-4', topic: 'storage', supersedes: 'd-long-3' },
  { id: 'd-long-5', topic: 'storage', supersedes: 'd-long-4' },
  { id: 'd-long-6', topic: 'test-runner' },
  { id: 'd-long-7', topic: 'observability', supersedes: 'd-long-2' },
  { id: 'd-agent-1', topic: 'api-shape', authority: 'agent' },
];

function longLedgerMutations(): Mutationish[] {
  return LONG_DECISION_SPECS.map((spec, index) =>
    appendMutation('decisionLedger', decisionOf(spec, index, LONG_RATIONALE_FILLER)),
  );
}

type Mutationish = ReturnType<typeof appendMutation>;

const LONG_HANDOFF_PACKETS: readonly HandoffPacket[] = [
  {
    fromRole: 'ARCHITECT',
    toRole: 'CODER',
    done: 'module layout settled; implement against the api-shape ruling',
    // References a SUPERSEDED decision (tombstone-retrievable) and its head.
    keyDecisions: ['d-long-1', 'd-long-2'],
    openIssues: ['observability hooks deferred until the observability ruling lands'],
    fileRefs: ['src/api.ts:L10-L20'],
    ts: 1_700_000_010_000,
  },
  {
    fromRole: 'TESTER',
    toRole: 'REVIEWER',
    done: 'tests pass; review against the agent-level naming note',
    // An agent-authority decision: legal to reference (it lives in the
    // ledger), while the projected leader slice filters it out.
    keyDecisions: ['d-agent-1'],
    openIssues: [],
    fileRefs: ['test/math.test.js:L4'],
    ts: 1_700_000_020_000,
  },
];

function longConversationSeed(initial: AppState): AppState {
  return applyMutations(initial, [
    ...longLedgerMutations(),
    ...LONG_HANDOFF_PACKETS.map((packet) => appendMutation('handoffPackets', packet)),
  ]);
}

/** Short-conversation control: three small leader decisions, well under the threshold. */
const SHORT_DECISIONS: readonly Decision[] = ['d-short-1', 'd-short-2', 'd-short-3'].map(
  (id, index) => decisionOf({ id, topic: 'naming' }, index, `short rationale ${index + 1}`),
);

function shortConversationSeed(initial: AppState): AppState {
  return applyMutations(
    initial,
    SHORT_DECISIONS.map((d) => appendMutation('decisionLedger', d)),
  );
}

/* ------------------------------------------------------------------ *
 * Long-conversation scenario: the four mechanisms on the real chain.  *
 * ------------------------------------------------------------------ */

describe('Phase 3 exit: long conversation (ledger+handoff seeded, scripted LLM, real chain)', () => {
  let runtime: Phase2Runtime;
  let final: AppState;
  let adapter: TurnScriptedLlmAdapter;

  beforeAll(async () => {
    adapter = new TurnScriptedLlmAdapter(HAPPY_TURNS);
    runtime = await createPhase2Runtime({
      taskId: 'exit-3-long',
      goal: '实现一个支持加法和乘法的 math 模块，并编写单元测试',
      adapter,
    });
    final = await runOrchestration(longConversationSeed(runtime.initialState), {
      workerRuntime: runtime.workerRuntime,
      roster: runtime.roster,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('chain 1: PM projection stays bounded past the threshold — heads keep rationale, superseded entries collapse to tombstones', () => {
    // The loop itself is unaffected by the seeded context weight.
    expect(final.phase).toBe('done');
    expect(final.iterationCount).toBe(1);

    const view = firstProjectionOf(adapter, 'PM');
    expect(view.role).toBe('PM');
    const slice = view.slices.leaderDecisions as Record<string, unknown>[];

    // Bounded: the projected slice never exceeds the compression threshold,
    // while the State ledger (the complete truth) is far larger.
    const sliceJson = JSON.stringify(slice);
    expect(sliceJson.length).toBeLessThanOrEqual(SLICE_COMPRESSION_THRESHOLD_CHARS);
    expect(sliceJson.length).toBeLessThan(JSON.stringify(final.decisionLedger).length);

    // Superseded entries collapsed to id-bearing retrieval stubs, in order.
    expect(slice.find((entry) => entry.id === 'd-long-1')).toEqual({
      id: 'd-long-1',
      topic: 'api-shape',
      supersededBy: 'd-long-2',
    });
    expect(slice.find((entry) => entry.id === 'd-long-3')).toEqual({
      id: 'd-long-3',
      topic: 'storage',
      supersededBy: 'd-long-4',
    });
    expect(slice.find((entry) => entry.id === 'd-long-4')).toEqual({
      id: 'd-long-4',
      topic: 'storage',
      supersededBy: 'd-long-5',
    });

    // Heads keep full fidelity — rationale travels with the decision (iron rule 3).
    for (const headId of ['d-long-2', 'd-long-5', 'd-long-6', 'd-long-7']) {
      const head = slice.find((entry) => entry.id === headId) as Decision | undefined;
      expect(head).toBeDefined();
      expect(head?.rationale.length).toBeGreaterThan(0);
      expect(head?.decision).toBe(
        `ruling ${headId} on ${LONG_DECISION_SPECS.find((s) => s.id === headId)?.topic}`,
      );
    }
    // Topic-scoped collapse: d-long-7's cross-topic supersedes pointer did not
    // tombstone the api-shape head d-long-2.
    expect(slice.find((entry) => entry.id === 'd-long-2')).not.toHaveProperty('supersededBy');

    // Leader slice only (task 3.3 ruling): the agent entry is filtered out.
    expect(slice.some((entry) => entry.id === 'd-agent-1')).toBe(false);
  });

  it('chain 2: iron rule 1 — no slice of the PM view ever carries raw group-chat fields', () => {
    const view = firstProjectionOf(adapter, 'PM');
    const slicesJson = JSON.stringify(view.slices);
    expect(slicesJson).not.toContain('channelId');
    expect(slicesJson).not.toContain('fromRole');
    expect(slicesJson).not.toContain('msgId');
  });

  it('chain 3: nothing is lost — State keeps the full ledger, tombstones resolve, handoffs stay lossless', () => {
    // Read-time compression: State is the complete append-only truth.
    expect(final.decisionLedger).toHaveLength(LONG_DECISION_SPECS.length);
    for (const spec of LONG_DECISION_SPECS) {
      const entry = final.decisionLedger.find((d) => d.id === spec.id);
      expect(entry).toBeDefined();
      expect(entry?.rationale.length).toBeGreaterThan(0);
      expect(entry?.authority).toBe(spec.authority ?? 'leader');
    }

    // Retrieval chain inside the projection: every tombstone's supersededBy
    // pointer is walkable to a full-fidelity head within the same slice
    // (supersede chains traverse tombstone hops before terminating at a head).
    const view = firstProjectionOf(adapter, 'PM');
    const slice = view.slices.leaderDecisions as Record<string, unknown>[];
    for (const entry of slice) {
      if (entry.supersededBy === undefined) continue;
      const visited = new Set<unknown>([entry.id]);
      let cursor: Record<string, unknown> | undefined = entry;
      while (cursor?.supersededBy !== undefined) {
        expect(visited.has(cursor.supersededBy), 'no supersede cycles').toBe(false);
        visited.add(cursor.supersededBy);
        cursor = slice.find((candidate) => candidate.id === cursor?.supersededBy);
        expect(
          cursor,
          `supersededBy pointer from ${String(entry.id)} must resolve in-slice`,
        ).toBeDefined();
      }
      const head = cursor;
      expect(head?.rationale, 'the walk must terminate at a head with rationale').toBeDefined();
      expect(String(head?.rationale).length).toBeGreaterThan(0);
    }

    // Handoffs survive losslessly and every keyDecision id resolves in State.
    expect(final.handoffPackets.slice(0, LONG_HANDOFF_PACKETS.length)).toEqual(
      LONG_HANDOFF_PACKETS,
    );
    expect(
      final.handoffPackets
        .slice(LONG_HANDOFF_PACKETS.length)
        .map((packet) => `${packet.fromRole}->${packet.toRole}`),
    ).toEqual(['PM->ARCHITECT', 'ARCHITECT->CODER', 'CODER->TESTER', 'TESTER->REVIEWER']);
    for (const packet of final.handoffPackets) {
      for (const id of packet.keyDecisions) {
        expect(
          final.decisionLedger.some((entry) => entry.id === id),
          `handoff keyDecision "${id}" must resolve in the State ledger`,
        ).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Short-conversation control: below the threshold the slice is        *
 * verbatim — the mechanism adapts instead of degrading small context. *
 * ------------------------------------------------------------------ */

describe('Phase 3 exit: short conversation control (below threshold stays verbatim)', () => {
  let runtime: Phase2Runtime;
  let final: AppState;
  let adapter: TurnScriptedLlmAdapter;

  beforeAll(async () => {
    adapter = new TurnScriptedLlmAdapter(HAPPY_TURNS);
    runtime = await createPhase2Runtime({
      taskId: 'exit-3-short',
      goal: '实现一个支持加法和乘法的 math 模块，并编写单元测试',
      adapter,
    });
    final = await runOrchestration(shortConversationSeed(runtime.initialState), {
      workerRuntime: runtime.workerRuntime,
      roster: runtime.roster,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it('the PM leaderDecisions slice is a verbatim defensive copy with no tombstones', () => {
    expect(final.phase).toBe('done');
    const view = firstProjectionOf(adapter, 'PM');
    const slice = view.slices.leaderDecisions as Decision[];
    expect(slice).toEqual(SHORT_DECISIONS);
    expect(slice.every((entry) => typeof entry.rationale === 'string')).toBe(true);
    expect(JSON.stringify(slice).length).toBeLessThanOrEqual(SLICE_COMPRESSION_THRESHOLD_CHARS);
    expect(final.decisionLedger).toHaveLength(SHORT_DECISIONS.length);
  });
});

/* ------------------------------------------------------------------ *
 * Direct-seam chain: the ledger authority invariant and the handoff   *
 * referential gate are enforced at the R1 State write gate.           *
 * ------------------------------------------------------------------ */

describe('Phase 3 exit: R1 write gate (ledger authority + handoff referential integrity)', () => {
  function packetWithKeyDecisions(keyDecisions: string[]): HandoffPacket {
    return {
      fromRole: 'ARCHITECT',
      toRole: 'CODER',
      done: 'handoff probe',
      keyDecisions,
      openIssues: [],
      fileRefs: ['src/api.ts:L1'],
      ts: 1_700_000_030_000,
    };
  }

  it('agent decisions cannot supersede leader decisions; handoffs must reference known ids', () => {
    const leaderDecision = decisionOf({ id: 'd-seam-leader', topic: 'auth-topic' }, 0, 'x');
    const seeded = applyMutations(createInitialAppState('exit-3-seam', 'seam probe'), [
      appendMutation('decisionLedger', leaderDecision),
    ]);
    expect(seeded.decisionLedger).toHaveLength(1);

    // Blueprint §14: only the leader may override a leader-level decision —
    // the R1 seam rejects an agent attempt (the pure fn gate is wired in).
    const agentAttempt: Decision = {
      ...decisionOf({ id: 'd-seam-agent', topic: 'auth-topic', authority: 'agent' }, 1, 'x'),
      supersedes: 'd-seam-leader',
    };
    expect(() => applyMutations(seeded, [appendMutation('decisionLedger', agentAttempt)])).toThrow(
      /leader-level decision/,
    );

    // Leader overriding leader stays legal.
    const leaderOverride: Decision = {
      ...decisionOf({ id: 'd-seam-leader-2', topic: 'auth-topic' }, 2, 'x'),
      supersedes: 'd-seam-leader',
    };
    const overridden = applyMutations(seeded, [appendMutation('decisionLedger', leaderOverride)]);
    expect(overridden.decisionLedger).toHaveLength(2);

    // Handoff referential gate: unknown decision ids are rejected at the seam.
    expect(() =>
      applyMutations(overridden, [
        appendMutation('handoffPackets', packetWithKeyDecisions(['d-seam-unknown'])),
      ]),
    ).toThrow(/unknown decision id/);
    const handedOff = applyMutations(overridden, [
      appendMutation('handoffPackets', packetWithKeyDecisions(['d-seam-leader'])),
    ]);
    expect(handedOff.handoffPackets).toHaveLength(1);
  });
});
