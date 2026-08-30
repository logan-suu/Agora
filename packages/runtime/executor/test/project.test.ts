import {
  type AppState,
  createInitialAppState,
  type Decision,
  type Requirement,
  type TestResults,
} from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { describe, expect, it } from 'vitest';
import { project } from '../src/project';

// Task 2.4 (spec §7 slice table) + task 3.3 (iron rule 3: decisions carry
// rationale). Pure data assertions, no mocks (R11): positive slice shapes for
// all six roles, the three-rule negative guarantees, and the
// no-silent-degradation guard for unimplemented slice names.

const REQ: Requirement = {
  id: 'req-1',
  story: 'as a user I want O(1) cache ops',
  acceptance: ['cache get/set are O(1)'],
  nonGoals: ['no TTL eviction'],
};

const TEST_RESULTS: TestResults = {
  passed: false,
  total: 5,
  failed: 2,
  failures: [
    { test: 'get evicts', message: 'SENTINEL-FAILURE-MESSAGE', file: 'src/a.test.ts', line: 3 },
    { test: 'set updates', message: 'SENTINEL-FAILURE-MESSAGE', file: 'src/a.test.ts', line: 7 },
    {
      test: 'get evicts again',
      message: 'SENTINEL-FAILURE-MESSAGE',
      file: 'src/a.test.ts',
      line: 3,
    },
    { test: 'ttl expires', message: 'other', file: 'src/b.test.ts', line: 1 },
  ],
};

const LEADER_DECISION: Decision = {
  id: 'dec-1',
  topic: 'cache-eviction',
  decision: 'LRU over LFU',
  rationale: 'SENTINEL-LEADER-RATIONALE',
  authority: 'leader',
  by: 'leader',
  ts: 1,
};

function makeState(overrides: Partial<AppState> = {}): AppState {
  return { ...createInitialAppState('t-1', 'build an LRU cache'), ...overrides };
}

function slicesOf(state: AppState, role: string): Record<string, unknown> {
  return project(state, role, DEFAULT_ROSTER).slices;
}

function chatLog(): AppState['messages'] {
  return [
    {
      msgId: 'm-1',
      channelId: 'ch-main',
      fromRole: 'PM',
      type: 'chat',
      payload: { note: 'SENTINEL-PM-PAYLOAD' },
      display: 'SENTINEL-PM-DISPLAY',
      ts: 1,
    },
  ];
}

describe('project (task 2.4, spec §7 slice table)', () => {
  it('COORDINATOR global.summary carries phase/test summary with explicit Phase 4/9 empties', () => {
    const view = slicesOf(makeState({ testResults: TEST_RESULTS }), 'COORDINATOR');
    expect(view['global.summary']).toEqual({
      taskId: 't-1',
      goal: 'build an LRU cache',
      phase: 'clarifying',
      iterationCount: 0,
      complexity: null,
      workers: [],
      testSummary: { passed: false, total: 5, failed: 2 },
    });
  });

  it('COORDINATOR testSummary is null before any test run', () => {
    expect(slicesOf(makeState(), 'COORDINATOR')['global.summary']).toMatchObject({
      testSummary: null,
    });
  });

  it('COORDINATOR global.summary projects the complexity tier once entry evaluates it (task 4.2, 4.1 ruling ③ wiring)', () => {
    const tiered = makeState({ complexity: { tier: 2, signals: { rule: 'tier2.multi_module' } } });
    expect(slicesOf(tiered, 'COORDINATOR')['global.summary']).toMatchObject({
      complexity: { tier: 2, signals: { rule: 'tier2.multi_module' } },
    });
    // Unset stays null (entry has not run / pre-4.1 replayed states).
    expect(slicesOf(makeState(), 'COORDINATOR')['global.summary']).toMatchObject({
      complexity: null,
    });
    // WO: the projection copies the slice — the live State object never leaks.
    const summary = slicesOf(tiered, 'COORDINATOR')['global.summary'] as {
      complexity: { signals: Record<string, unknown> } | null;
    };
    expect(summary.complexity?.signals).not.toBe(tiered.complexity?.signals);
  });

  it('PM gets goal, full requirements, and leader decisions with rationale attached (iron rule 3)', () => {
    const supersedingLeader: Decision = {
      ...LEADER_DECISION,
      id: 'dec-2',
      decision: 'TwoQueue over plain LRU',
      rationale: 'SENTINEL-REVISED-RATIONALE',
      supersedes: 'dec-1',
      ts: 2,
    };
    const agentEntry: Decision = {
      id: 'dec-3',
      topic: 'cache-eviction',
      decision: 'SENTINEL-AGENT-DECISION',
      rationale: 'architect preference only',
      authority: 'agent',
      by: 'ARCHITECT',
      ts: 3,
    };
    const view = slicesOf(
      makeState({
        requirements: [REQ],
        decisionLedger: [LEADER_DECISION, supersedingLeader, agentEntry],
      }),
      'PM',
    );
    expect(view.goal).toEqual({ goal: 'build an LRU cache' });
    expect(view.requirements).toEqual([REQ]);
    expect(view.leaderDecisions).toEqual([LEADER_DECISION, supersedingLeader]);
    const json = JSON.stringify(view.leaderDecisions);
    expect(json).toContain('SENTINEL-LEADER-RATIONALE');
    expect(json).toContain('SENTINEL-REVISED-RATIONALE');
    expect(json).toContain('"supersedes":"dec-1"');
    expect(json).not.toContain('SENTINEL-AGENT-DECISION');
  });

  it('leaderDecisions defaults to [] on an empty ledger and yields defensive copies (WO)', () => {
    expect(slicesOf(makeState(), 'PM').leaderDecisions).toEqual([]);
    const ledger = [LEADER_DECISION];
    const view = slicesOf(makeState({ decisionLedger: ledger }), 'PM');
    const projected = view.leaderDecisions as Decision[];
    expect(projected[0]).toEqual(LEADER_DECISION);
    expect(projected[0]).not.toBe(ledger[0]);
  });

  it('ARCHITECT gets requirements, explicit-empty repoStructure (Phase 1), and conventions', () => {
    const view = slicesOf(
      makeState({ requirements: [REQ], conventions: { style: 'biome' } }),
      'ARCHITECT',
    );
    expect(view.requirements).toEqual([REQ]);
    expect(view.repoStructure).toEqual({});
    expect(view.conventions).toEqual({ style: 'biome' });
  });

  it('CODER assignedSubtask lists only own non-done subtasks with worktree refs', () => {
    const view = slicesOf(
      makeState({
        subtasks: [
          {
            id: 'st-1',
            title: 'write LRU',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress',
            worktree: '/wt/a',
          },
          { id: 'st-2', title: 'old', ownerRole: 'CODER', dependsOn: [], status: 'done' },
          {
            id: 'st-3',
            title: 'SENTINEL-OTHER-SUBTASK',
            ownerRole: 'TESTER',
            dependsOn: [],
            status: 'in_progress',
          },
        ],
      }),
      'CODER',
    );
    expect(view.assignedSubtask).toEqual([
      {
        id: 'st-1',
        title: 'write LRU',
        ownerRole: 'CODER',
        status: 'in_progress',
        worktree: '/wt/a',
      },
    ]);
  });

  it('CODER failingTests: zero shape when absent, full shape when present', () => {
    expect(slicesOf(makeState(), 'CODER').failingTests).toEqual({
      passed: null,
      total: 0,
      failed: 0,
      failures: [],
    });
    expect(slicesOf(makeState({ testResults: TEST_RESULTS }), 'CODER').failingTests).toEqual({
      passed: false,
      total: 5,
      failed: 2,
      failures: TEST_RESULTS.failures,
    });
  });

  it('CODER fileRefs: deduped path+line refs from failing tests, never code content (iron rule 2)', () => {
    const refs = slicesOf(makeState({ testResults: TEST_RESULTS }), 'CODER').fileRefs;
    expect(refs).toEqual([
      { file: 'src/a.test.ts', lines: [3, 7] },
      { file: 'src/b.test.ts', lines: [1] },
    ]);
    expect(JSON.stringify(refs)).not.toContain('SENTINEL-FAILURE-MESSAGE');
    expect(slicesOf(makeState(), 'CODER').fileRefs).toEqual([]);
  });

  it('CODER architecture/conventions pass through as copies and default to {} when absent', () => {
    const architecture = { modules: ['cache'] };
    const view = slicesOf(makeState({ architecture, conventions: { style: 'biome' } }), 'CODER');
    expect(view.architecture).toEqual(architecture);
    expect(view.architecture).not.toBe(architecture);
    expect(view.conventions).toEqual({ style: 'biome' });
    const bare = slicesOf(makeState(), 'CODER');
    expect(bare.architecture).toEqual({});
    expect(bare.conventions).toEqual({});
  });

  it('TESTER acceptance: requirements acceptance only — no goal echo, no test internals', () => {
    const view = slicesOf(
      makeState({ goal: 'SENTINEL-GOAL', requirements: [REQ], testResults: TEST_RESULTS }),
      'TESTER',
    );
    expect(view.acceptance).toEqual({
      requirements: [{ id: 'req-1', acceptance: ['cache get/set are O(1)'] }],
    });
    const json = JSON.stringify(view.acceptance);
    expect(json).not.toContain('SENTINEL-GOAL');
    expect(json).not.toContain('"passed"');
    expect(slicesOf(makeState(), 'TESTER').acceptance).toEqual({ requirements: [] });
  });

  it('TESTER branchOrPatch: active worktree paths plus pendingPatch (null until its writer lands)', () => {
    const patched = makeState({
      subtasks: [
        {
          id: 'st-1',
          title: 'write LRU',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
          worktree: '/wt/a',
        },
        { id: 'st-2', title: 'old', ownerRole: 'CODER', dependsOn: [], status: 'done' },
      ],
      pendingPatch: { diff: 'x' },
    });
    expect(slicesOf(patched, 'TESTER').branchOrPatch).toEqual({
      worktrees: ['/wt/a'],
      patch: { diff: 'x' },
    });
    expect(slicesOf(makeState(), 'TESTER').branchOrPatch).toEqual({
      worktrees: [],
      patch: null,
    });
  });

  it('TESTER interfaceContracts: architecture.interfaces passthrough with {} defaults', () => {
    const interfaces = [{ name: 'Cache', method: 'get' }];
    expect(
      slicesOf(makeState({ architecture: { interfaces } }), 'TESTER').interfaceContracts,
    ).toEqual(interfaces);
    expect(slicesOf(makeState({ architecture: {} }), 'TESTER').interfaceContracts).toEqual({});
    expect(
      slicesOf(makeState({ architecture: { interfaces: 'oops' } }), 'TESTER').interfaceContracts,
    ).toEqual({});
    expect(slicesOf(makeState(), 'TESTER').interfaceContracts).toEqual({});
  });

  it('REVIEWER gets structured failure context without receiving raw coordinator messages', () => {
    const rich = makeState({
      pendingPatch: { diff: 'x' },
      conventions: { style: 'biome' },
      architecture: { modules: ['cache'] },
      testResults: TEST_RESULTS,
      messages: [
        {
          msgId: 'm-root-cause',
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          payload: {
            nextRole: 'REVIEWER',
            reason: 'repeated_test_failures',
            failureStreak: 2,
          },
          display: 'SENTINEL-RAW-ANNOUNCEMENT',
          ts: 2,
        },
      ],
    });
    const reviewer = slicesOf(rich, 'REVIEWER');
    expect(reviewer.pendingPatch).toEqual({ diff: 'x' });
    expect(reviewer.conventions).toEqual({ style: 'biome' });
    expect(reviewer.architecture).toEqual({ modules: ['cache'] });
    expect(reviewer.reviewContext).toEqual({
      mode: 'test_failure_root_cause',
      reason: 'repeated_test_failures',
      failureStreak: 2,
    });
    expect(reviewer.failingTests).toEqual(TEST_RESULTS);
    expect(reviewer.fileRefs).toEqual([
      { file: 'src/a.test.ts', lines: [3, 7] },
      { file: 'src/b.test.ts', lines: [1] },
    ]);
    expect(JSON.stringify(reviewer)).not.toContain('SENTINEL-RAW-ANNOUNCEMENT');
    expect(JSON.stringify(reviewer)).not.toContain('m-root-cause');
    const bare = slicesOf(makeState(), 'REVIEWER');
    expect(bare.pendingPatch).toBeNull();
    expect(bare.conventions).toEqual({});
    expect(bare.architecture).toEqual({});
    expect(bare.reviewContext).toEqual({
      mode: 'quality_review',
      reason: null,
      failureStreak: null,
    });
  });

  it('ARCHITECT and CODER receive only the latest structured review turn', () => {
    const first = { id: 'rv-1', kind: 'verdict', verdict: 'changes_requested' };
    const currentComment = { id: 'rc-2', kind: 'comment', summary: 'split boundary' };
    const currentVerdict = {
      id: 'rv-2',
      kind: 'verdict',
      verdict: 'changes_requested',
      issueScope: 'architecture',
      summary: 'module boundary is wrong',
    };
    const state = makeState({
      architecture: { modules: ['legacy'] },
      reviewComments: [first, currentComment, currentVerdict],
    });

    for (const role of ['ARCHITECT', 'CODER']) {
      const slices = slicesOf(state, role);
      expect(slices.reviewFeedback).toEqual({
        verdict: currentVerdict,
        entries: [currentComment, currentVerdict],
      });
      expect((slices.reviewFeedback as { verdict: unknown }).verdict).not.toBe(currentVerdict);
    }
    expect(slicesOf(state, 'ARCHITECT').architecture).toEqual({ modules: ['legacy'] });
    expect(slicesOf(makeState(), 'ARCHITECT').reviewFeedback).toEqual({
      verdict: null,
      entries: [],
    });
  });

  it('iron rule 1 (R2): no role view ever carries the raw chat log', () => {
    for (const spec of DEFAULT_ROSTER) {
      const json = JSON.stringify(slicesOf(makeState({ messages: chatLog() }), spec.role));
      expect(json).not.toContain('SENTINEL-PM-PAYLOAD');
      expect(json).not.toContain('SENTINEL-PM-DISPLAY');
      expect(json).not.toContain('channelId');
      expect(json).not.toContain('fromRole');
      expect(json).not.toContain('msgId');
    }
  });

  it('unknown declared slice throws instead of silently degrading', () => {
    const custom = [
      {
        role: 'CUSTOM',
        enabled: true,
        executor: 'harness' as const,
        systemPrompt: 'test',
        tools: [],
        projection: ['mystery.slice'],
        routeWhen: 'always',
      },
    ];
    expect(() => project(makeState(), 'CUSTOM', custom)).toThrow('unknown projection slice');
  });

  it('drift guard: every slice declared by DEFAULT_ROSTER is implemented', () => {
    const rich = makeState({
      requirements: [REQ],
      subtasks: [
        {
          id: 'st-1',
          title: 'write LRU',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
          worktree: '/wt/a',
        },
      ],
      testResults: TEST_RESULTS,
      conventions: { style: 'biome' },
      architecture: { modules: ['cache'], interfaces: [{ name: 'Cache' }] },
      pendingPatch: { diff: 'x' },
      decisionLedger: [LEADER_DECISION],
    });
    for (const spec of DEFAULT_ROSTER) {
      expect(() => project(rich, spec.role, DEFAULT_ROSTER)).not.toThrow();
    }
  });
});

describe('project slice compression (task 3.4, spec §7 cross-agent slice compression)', () => {
  // Deliberately local (not imported): asserts the tombstone shape, not module exports.
  type TombstoneLike = { id: string; topic: string; supersededBy: string };

  const LONG = 'x'.repeat(4200);

  it('PM leaderDecisions collapses over threshold: head rationale travels, superseded rationale replaced by an id-bearing tombstone, WO copies kept', () => {
    const d1: Decision = {
      id: 'dec-1',
      topic: 'cache-eviction',
      decision: 'LRU over LFU',
      rationale: `SENTINEL-SUPERSEDED ${LONG}`,
      authority: 'leader',
      by: 'leader',
      ts: 1,
    };
    const d2: Decision = {
      id: 'dec-2',
      topic: 'cache-eviction',
      decision: 'TwoQueue over plain LRU',
      rationale: `SENTINEL-HEAD ${LONG}`,
      authority: 'leader',
      by: 'leader',
      supersedes: 'dec-1',
      ts: 2,
    };
    const agent: Decision = {
      id: 'dec-3',
      topic: 'cache-eviction',
      decision: 'SENTINEL-AGENT-DECISION',
      rationale: 'architect preference only',
      authority: 'agent',
      by: 'ARCHITECT',
      ts: 3,
    };
    const ledger = [d1, d2, agent];
    const projected = slicesOf(makeState({ decisionLedger: ledger }), 'PM').leaderDecisions as (
      | Decision
      | TombstoneLike
    )[];
    expect(projected[0]).toEqual({ id: 'dec-1', topic: 'cache-eviction', supersededBy: 'dec-2' });
    const json = JSON.stringify(projected);
    expect(json).toContain('SENTINEL-HEAD');
    expect(json).not.toContain('SENTINEL-SUPERSEDED');
    expect(json).not.toContain('SENTINEL-AGENT-DECISION');
    const head = projected[1] as Decision;
    expect(head).not.toBe(ledger[1]); // WO: defensive copy survives compression
  });

  it('compressed tombstones keep every role view free of raw-log fields (iron rule 1)', () => {
    const d1: Decision = {
      id: 'dec-1',
      topic: 'cache-eviction',
      decision: 'LRU over LFU',
      rationale: LONG,
      authority: 'leader',
      by: 'leader',
      ts: 1,
    };
    const d2: Decision = {
      id: 'dec-2',
      topic: 'cache-eviction',
      decision: 'TwoQueue over plain LRU',
      rationale: LONG,
      authority: 'leader',
      by: 'leader',
      supersedes: 'dec-1',
      ts: 2,
    };
    for (const spec of DEFAULT_ROSTER) {
      const json = JSON.stringify(
        slicesOf(makeState({ decisionLedger: [d1, d2], messages: chatLog() }), spec.role),
      );
      expect(json).not.toContain('SENTINEL-PM-PAYLOAD');
      expect(json).not.toContain('SENTINEL-PM-DISPLAY');
      expect(json).not.toContain('msgId');
      expect(json).not.toContain('channelId');
      expect(json).not.toContain('fromRole');
    }
  });
});
