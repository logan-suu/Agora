import { readFileSync } from 'node:fs';
import { COORDINATION_LEDGER_KIND, latestCoordinationLedger } from '@agora/core-domain';
import { runOrchestration } from '@agora/core-orchestration';
import { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import {
  createPhase2Runtime,
  type Phase2Runtime,
} from '../../../packages/core/__tests__/e2e/phase2-runtime';

// R11 mock reason: only the nondeterministic external LLM response is scripted.
// Harness, WorkerRuntime, role projection, MCP fs_write, LocalTempSandbox, reducer,
// Coordinator routing, and Ledger/handoff persistence all use their real implementations.

const TEST_RESULTS_FILE = 'test-results.json';
const PASSED_RESULTS = { passed: true, total: 1, failed: 0, failures: [] };

interface ScriptedAction {
  tool: 'fs_write';
  args: Record<string, unknown>;
}

interface ScriptedTurn {
  actions: readonly ScriptedAction[];
  final: string;
}

type RoleTurns = Readonly<Record<string, readonly ScriptedTurn[]>>;

function pureTurn(final: string): ScriptedTurn {
  return { actions: [], final };
}

function testerTurn(): ScriptedTurn {
  return {
    actions: [
      {
        tool: 'fs_write',
        args: { path: TEST_RESULTS_FILE, content: JSON.stringify(PASSED_RESULTS) },
      },
    ],
    final: 'Tests passed; recorded test-results.json.',
  };
}

const TIER0_TURNS: RoleTurns = {
  CODER: [pureTurn('Implemented the requested function.')],
  TESTER: [testerTurn()],
  REVIEWER: [
    pureTurn(
      JSON.stringify([
        { id: 'tier0-approved', kind: 'verdict', verdict: 'approved', summary: 'approved' },
      ]),
    ),
  ],
};

const TIER2_TURNS: RoleTurns = {
  PM: [
    pureTurn(
      JSON.stringify([
        {
          id: 'rest-api-requirement',
          story: 'Expose a REST API service',
          acceptance: ['the API responds successfully'],
          nonGoals: [],
        },
      ]),
    ),
  ],
  ARCHITECT: [
    pureTurn(
      JSON.stringify({
        architecture: { modules: ['api', 'service', 'store'] },
        conventions: { transport: 'http' },
      }),
    ),
  ],
  CODER: [
    pureTurn('Implemented api.'),
    pureTurn('Implemented service.'),
    pureTurn('Implemented store.'),
  ],
  TESTER: [testerTurn(), testerTurn(), testerTurn()],
  REVIEWER: [
    pureTurn(
      JSON.stringify([
        { id: 'tier2-approved', kind: 'verdict', verdict: 'approved', summary: 'approved' },
      ]),
    ),
  ],
};

class TurnScriptedLlmAdapter extends LlmAdapter {
  readonly dispatches: string[] = [];
  private readonly turnIndexOf = new Map<string, number>();
  private callSequence = 0;

  constructor(private readonly turns: RoleTurns) {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const role = projectionRoleOf(options);
    const completedActions = completedActionsOf(options);
    if (completedActions === 0) {
      this.dispatches.push(role);
      this.turnIndexOf.set(role, (this.turnIndexOf.get(role) ?? -1) + 1);
    }
    const turnIndex = this.turnIndexOf.get(role) ?? 0;
    const turn = this.turns[role]?.[turnIndex];
    if (turn === undefined) {
      throw new Error(`unexpected ${role} turn ${turnIndex}`);
    }
    const action = turn.actions[completedActions];
    if (action === undefined) {
      yield* textChunks(turn.final);
      return;
    }
    yield* toolCallChunks(action, CallId(`phase4-call-${this.callSequence++}`));
  }
}

function projectionRoleOf(call: GenerateOptions): string {
  const first = call.messages[0];
  const block = first?.content.find((entry) => entry.type === 'text');
  if (block?.type !== 'text') {
    throw new Error('scripted adapter expected a projected view in the first message');
  }
  const view = JSON.parse(block.text) as { role?: unknown };
  if (typeof view.role !== 'string') {
    throw new Error('scripted adapter expected a role in the projected view');
  }
  return view.role;
}

function completedActionsOf(call: GenerateOptions): number {
  return call.messages.reduce(
    (count, message) =>
      count + message.content.filter((entry) => entry.type === 'tool-result').length,
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

function* textChunks(value: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: value };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
  yield usageChunk();
  yield { type: 'finish', reason: { kind: 'stop' } };
}

async function runScenario(
  taskId: string,
  goal: string,
  turns: RoleTurns,
): Promise<{ runtime: Phase2Runtime; adapter: TurnScriptedLlmAdapter }> {
  const adapter = new TurnScriptedLlmAdapter(turns);
  const runtime = await createPhase2Runtime({ taskId, goal, adapter });
  return { runtime, adapter };
}

describe('Phase 4 adaptive routing deterministic real-chain validation', () => {
  it('routes “实现一个函数” as Tier 0 and skips PM/ARCHITECT', async () => {
    const { runtime, adapter } = await runScenario('phase4-tier0', '实现一个函数', TIER0_TURNS);
    try {
      const final = await runOrchestration(runtime.initialState, {
        workerRuntime: runtime.workerRuntime,
        roster: runtime.roster,
      });

      expect(final.phase).toBe('review');
      expect(final.humanGate?.reason).toMatch(/^completion_confirmation:/);
      expect(final.complexity).toMatchObject({ tier: 0, signals: { rule: 'tier0.single_entity' } });
      expect(adapter.dispatches).toEqual(['CODER', 'TESTER', 'REVIEWER']);
      expect(final.subtasks).toHaveLength(1);
      expect(final.subtasks[0]?.status).toBe('done');
      expect(final.testResults).toEqual(PASSED_RESULTS);
      expect(final.messages.some((message) => message.fromRole === 'PM')).toBe(false);
      expect(final.messages.some((message) => message.fromRole === 'ARCHITECT')).toBe(false);
      expect(readFileSync(`${runtime.worktree.path}/${TEST_RESULTS_FILE}`, 'utf8')).toBe(
        JSON.stringify(PASSED_RESULTS),
      );
      expect(latestCoordinationLedger(final)).toMatchObject({
        completionCandidate: true,
        progress: {
          isRequestSatisfied: { answer: false, authority: 'leader' },
        },
      });
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it('routes “实现一个 REST API 服务” as Tier 2 and engages the full sequential team', async () => {
    const { runtime, adapter } = await runScenario(
      'phase4-tier2',
      '实现一个 REST API 服务',
      TIER2_TURNS,
    );
    try {
      const final = await runOrchestration(runtime.initialState, {
        workerRuntime: runtime.workerRuntime,
        roster: runtime.roster,
      });

      expect(final.phase).toBe('review');
      expect(final.humanGate?.reason).toMatch(/^completion_confirmation:/);
      expect(final.complexity).toMatchObject({ tier: 2, signals: { rule: 'tier2.multi_module' } });
      expect(adapter.dispatches).toEqual([
        'PM',
        'ARCHITECT',
        'CODER',
        'TESTER',
        'CODER',
        'TESTER',
        'CODER',
        'TESTER',
        'REVIEWER',
      ]);
      expect(final.subtasks.map(({ title, status }) => ({ title, status }))).toEqual([
        { title: 'api', status: 'done' },
        { title: 'service', status: 'done' },
        { title: 'store', status: 'done' },
      ]);
      expect(final.testResults).toEqual(PASSED_RESULTS);
      expect(
        final.messages.filter((message) => message.payload.kind === COORDINATION_LEDGER_KIND)
          .length,
      ).toBeGreaterThanOrEqual(adapter.dispatches.length);
      for (const role of ['COORDINATOR', 'PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER']) {
        expect(final.messages.some((message) => message.fromRole === role)).toBe(true);
      }
      expect(final.handoffPackets.length).toBeGreaterThanOrEqual(4);
      expect(latestCoordinationLedger(final)).toMatchObject({
        completionCandidate: true,
        progress: {
          isRequestSatisfied: { answer: false, authority: 'leader' },
        },
      });
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});
