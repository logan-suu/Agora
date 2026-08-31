import { describe, expect, it } from 'vitest';
import type {
  AppState,
  Decision,
  HandoffPacket,
  Message,
  Mutation,
  Requirement,
} from '../src/index';
import {
  APPEND_FIELDS,
  appendMutation,
  applyMutations,
  createInitialAppState,
  ENABLED_APPEND_FIELDS,
  ENABLED_MERGE_BY_ID_FIELDS,
  ENABLED_SET_FIELDS,
  MERGE_BY_ID_FIELDS,
  mergeByIdMutation,
  SET_FIELDS,
  setMutation,
} from '../src/index';

let seq = 0;

function makeMessage(overrides: Partial<Message> = {}): Message {
  seq += 1;
  const n = seq;
  return {
    msgId: `m-${n}`,
    channelId: 'main',
    fromRole: 'CODER',
    type: 'chat',
    payload: {},
    display: `display-${n}`,
    ts: n,
    ...overrides,
  };
}

function makeSubtaskPatch(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: `subtask-${id}`,
    ownerRole: 'CODER',
    dependsOn: [],
    status: 'todo',
    ...overrides,
  };
}

function sortMessages(state: AppState): Message[] {
  return [...state.messages].sort((a, b) => a.msgId.localeCompare(b.msgId));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('applyMutations · append', () => {
  it('commutativity: two appends applied in either order yield the same message set', () => {
    const base = createInitialAppState('t-1', 'goal');
    const first = appendMutation('messages', makeMessage());
    const second = appendMutation('messages', makeMessage());
    const forward = applyMutations(base, [first, second]);
    const backward = applyMutations(base, [second, first]);
    expect(sortMessages(forward)).toEqual(sortMessages(backward));
  });

  it('idempotency: replaying the same mutation leaves a single entry', () => {
    const base = createInitialAppState('t-1', 'goal');
    const mutation = appendMutation('messages', makeMessage());
    const once = applyMutations(base, [mutation]);
    const twice = applyMutations(once, [mutation]);
    expect(twice.messages.length).toBe(1);
    expect(twice.messages[0]).toEqual(once.messages[0]);
  });

  it('producer contract: same identity key with different content is a producer bug and first write stays', () => {
    const base = createInitialAppState('t-1', 'goal');
    const first = appendMutation('messages', makeMessage({ msgId: 'm-fixed', display: 'v1' }));
    const second = appendMutation('messages', makeMessage({ msgId: 'm-fixed', display: 'v2' }));
    const forward = applyMutations(base, [first, second]);
    const backward = applyMutations(base, [second, first]);
    expect(forward.messages.length).toBe(1);
    expect(backward.messages.length).toBe(1);
    expect(forward.messages[0]?.display).toBe('v1');
    expect(backward.messages[0]?.display).toBe('v2');
  });

  it('idempotency falls back to deep equality for values without an identity key', () => {
    const base = createInitialAppState('t-1', 'goal');
    const once = applyMutations(base, [appendMutation('messages', { kind: 'note', text: 'same' })]);
    const twice = applyMutations(once, [
      appendMutation('messages', { kind: 'note', text: 'same' }),
    ]);
    expect(twice.messages.length).toBe(1);
  });
});

describe('applyMutations · mergeById', () => {
  it('does not expose task-level channels after D7 moved the registry to Project', () => {
    expect([...MERGE_BY_ID_FIELDS]).not.toContain('channels');
  });

  it('updates an existing element in place without duplicating it', () => {
    const base = applyMutations(createInitialAppState('t-1', 'goal'), [
      mergeByIdMutation('subtasks', 'st-1', makeSubtaskPatch('st-1')),
    ]);
    const next = applyMutations(base, [
      mergeByIdMutation('subtasks', 'st-1', { status: 'in_progress' }),
    ]);
    expect(next.subtasks.length).toBe(1);
    expect(next.subtasks[0]?.status).toBe('in_progress');
  });

  it('appends a copy when the identity is not found yet', () => {
    const base = createInitialAppState('t-1', 'goal');
    const next = applyMutations(base, [
      mergeByIdMutation('subtasks', 'st-9', makeSubtaskPatch('st-9', { status: 'blocked' })),
    ]);
    expect(next.subtasks.length).toBe(1);
    expect(next.subtasks[0]?.id).toBe('st-9');
    expect(next.subtasks[0]?.status).toBe('blocked');
  });

  it('touches only the targeted element: non-owner fields are unaffected', () => {
    const base = applyMutations(createInitialAppState('t-1', 'goal'), [
      mergeByIdMutation('subtasks', 'st-1', makeSubtaskPatch('st-1')),
      mergeByIdMutation('subtasks', 'st-2', makeSubtaskPatch('st-2', { status: 'done' })),
    ]);
    const before = base.subtasks.find((item) => item.id === 'st-2');
    const next = applyMutations(base, [
      mergeByIdMutation('subtasks', 'st-1', { status: 'in_progress' }),
    ]);
    const untouched = next.subtasks.find((item) => item.id === 'st-2');
    expect(untouched).toEqual(before);
    expect(next.subtasks.length).toBe(2);
  });
});

describe('applyMutations · set', () => {
  it('follows last-write-wins and replays are stable', () => {
    const base = createInitialAppState('t-1', 'goal');
    const coding = setMutation('phase', 'coding');
    const testing = setMutation('phase', 'testing');
    expect(applyMutations(base, [coding, testing]).phase).toBe('testing');
    const once = applyMutations(base, [testing]);
    expect(applyMutations(once, [testing]).phase).toBe('testing');
  });

  it('overwrites testResults as a whole object', () => {
    const base = createInitialAppState('t-1', 'goal');
    const results = { passed: true, total: 3, failed: 0, failures: [] };
    const next = applyMutations(base, [setMutation('testResults', results)]);
    expect(next.testResults).toEqual(results);
  });
});

describe('applyMutations · composition guarantees', () => {
  it('cross-op order independence: append and set commute to an equivalent terminal state', () => {
    const base = createInitialAppState('t-1', 'goal');
    const append = appendMutation('messages', makeMessage());
    const setPhase = setMutation('phase', 'coding');
    const forward = applyMutations(base, [append, setPhase]);
    const backward = applyMutations(base, [setPhase, append]);
    expect(backward.messages).toEqual(forward.messages);
    expect(forward.phase).toBe(backward.phase);
  });

  it('purity: a deeply frozen input state is neither mutated nor causes throws', () => {
    const initial = createInitialAppState('t-1', 'goal');
    const snapshot = JSON.parse(JSON.stringify(initial)) as AppState;
    const frozen = deepFreeze(initial);
    const next = applyMutations(frozen, [
      appendMutation('messages', makeMessage()),
      setMutation('phase', 'coding'),
    ]);
    expect(next.messages.length).toBe(1);
    expect(next.phase).toBe('coding');
    expect(JSON.parse(JSON.stringify(frozen))).toEqual(snapshot);
  });

  it('returns an equivalent but fresh state for an empty mutation list', () => {
    const initial = createInitialAppState('t-1', 'goal');
    const next = applyMutations(initial, []);
    expect(next).toEqual(initial);
    expect(next).not.toBe(initial);
  });
});

describe('applyMutations · stage gating (spec §1 vs Phase 0 slice)', () => {
  it('throws the stage-gate error for every append field outside the Phase 0 slice', () => {
    const disabled = APPEND_FIELDS.filter((field) => !ENABLED_APPEND_FIELDS.includes(field));
    expect(disabled.length).toBeGreaterThan(0);
    for (const field of disabled) {
      const mutation = appendMutation(field, { id: 'x' });
      expect(() => applyMutations(createInitialAppState('t-1', 'goal'), [mutation])).toThrowError(
        `mutation field "${field}" is defined by spec §1 but not enabled in Phase 0`,
      );
    }
  });

  it('throws the stage-gate error for every mergeById field outside the Phase 0 slice', () => {
    const disabled = MERGE_BY_ID_FIELDS.filter(
      (field) => !ENABLED_MERGE_BY_ID_FIELDS.includes(field),
    );
    expect(disabled.length).toBeGreaterThan(0);
    for (const field of disabled) {
      const mutation = mergeByIdMutation(field, 'x', {});
      expect(() => applyMutations(createInitialAppState('t-1', 'goal'), [mutation])).toThrowError(
        `mutation field "${field}" is defined by spec §1 but not enabled in Phase 0`,
      );
    }
  });

  it('throws the stage-gate error for every set field outside the Phase 0 slice', () => {
    const disabled = SET_FIELDS.filter((field) => !ENABLED_SET_FIELDS.includes(field));
    expect(disabled.length).toBeGreaterThan(0);
    for (const field of disabled) {
      const mutation = setMutation(field, null);
      expect(() => applyMutations(createInitialAppState('t-1', 'goal'), [mutation])).toThrowError(
        `mutation field "${field}" is defined by spec §1 but not enabled in Phase 0`,
      );
    }
  });

  it('defensively rejects an unknown op forged past the type system', () => {
    const forged = { field: 'messages', op: 'explode', value: null } as unknown as Mutation;
    expect(() => applyMutations(createInitialAppState('t-1', 'goal'), [forged])).toThrowError();
  });
});

describe('applyMutations · Phase 2 unlocked fields (task 2.2)', () => {
  function makeRequirement(id: string, overrides: Partial<Requirement> = {}): Requirement {
    return {
      id,
      story: `story-${id}`,
      acceptance: [`acc-${id}`],
      nonGoals: [],
      ...overrides,
    };
  }

  it('mergeById(requirements): upserts a new requirement and updates an existing one in place', () => {
    const base = applyMutations(createInitialAppState('t-1', 'goal'), [
      mergeByIdMutation('requirements', 'req-1', { ...makeRequirement('req-1') }),
    ]);
    expect(base.requirements).toHaveLength(1);
    const next = applyMutations(base, [
      mergeByIdMutation('requirements', 'req-1', { story: 'revised' }),
      mergeByIdMutation('requirements', 'req-2', { ...makeRequirement('req-2') }),
    ]);
    expect(next.requirements).toHaveLength(2);
    expect(next.requirements.find((r) => r.id === 'req-1')?.story).toBe('revised');
    expect(next.requirements.find((r) => r.id === 'req-1')?.acceptance).toEqual(['acc-req-1']);
  });

  it('mergeById(requirements): replay is idempotent and unordered writes commute', () => {
    const base = createInitialAppState('t-1', 'goal');
    const first = mergeByIdMutation('requirements', 'req-1', { ...makeRequirement('req-1') });
    const second = mergeByIdMutation('requirements', 'req-2', { ...makeRequirement('req-2') });
    const once = applyMutations(base, [first]);
    expect(applyMutations(once, [first]).requirements).toHaveLength(1);
    const forward = applyMutations(base, [first, second]);
    const backward = applyMutations(base, [second, first]);
    expect([...forward.requirements].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...backward.requirements].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('set(architecture): last-write-wins object overwrite with stable replays', () => {
    const base = createInitialAppState('t-1', 'goal');
    const v1 = { modules: ['cache'] };
    const v2 = { modules: ['cache', 'store'] };
    expect(
      applyMutations(base, [setMutation('architecture', v1), setMutation('architecture', v2)])
        .architecture,
    ).toEqual(v2);
    const once = applyMutations(base, [setMutation('architecture', v1)]);
    expect(applyMutations(once, [setMutation('architecture', v1)]).architecture).toEqual(v1);
  });

  it('set(architecture): rejects non-object values instead of corrupting the design slice', () => {
    const state = createInitialAppState('t-1', 'goal');
    for (const bad of [null, 'design', 42, []] as unknown[]) {
      expect(() => applyMutations(state, [setMutation('architecture', bad)])).toThrow(
        'architecture must be a non-array object',
      );
    }
  });

  it('set(conventions): last-write-wins object overwrite with stable replays', () => {
    const base = createInitialAppState('t-1', 'goal');
    const v1 = { style: 'biome', naming: 'camelCase' };
    const v2 = { style: 'biome-strict' };
    expect(
      applyMutations(base, [setMutation('conventions', v1), setMutation('conventions', v2)])
        .conventions,
    ).toEqual(v2);
    const once = applyMutations(base, [setMutation('conventions', v1)]);
    expect(applyMutations(once, [setMutation('conventions', v1)]).conventions).toEqual(v1);
  });

  it('set(conventions): rejects non-object values instead of corrupting the conventions slice', () => {
    const state = createInitialAppState('t-1', 'goal');
    for (const bad of [null, 'convention', 42, []] as unknown[]) {
      expect(() => applyMutations(state, [setMutation('conventions', bad)])).toThrow(
        'conventions must be a non-array object',
      );
    }
  });

  it('append(reviewComments): identity-keyed dedup keeps replays idempotent', () => {
    const base = createInitialAppState('t-1', 'goal');
    const verdict = { id: 'rc-1', kind: 'verdict', verdict: 'approved' };
    const once = applyMutations(base, [appendMutation('reviewComments', verdict)]);
    const twice = applyMutations(once, [appendMutation('reviewComments', verdict)]);
    expect(twice.reviewComments).toHaveLength(1);
  });

  it('append(reviewComments): same identity with different content is a producer bug, first write stays', () => {
    const base = createInitialAppState('t-1', 'goal');
    const first = appendMutation('reviewComments', { id: 'rc-1', summary: 'v1' });
    const second = appendMutation('reviewComments', { id: 'rc-1', summary: 'v2' });
    const forward = applyMutations(base, [first, second]);
    const backward = applyMutations(base, [second, first]);
    expect(forward.reviewComments).toHaveLength(1);
    expect(backward.reviewComments).toHaveLength(1);
    expect(forward.reviewComments[0]?.summary).toBe('v1');
    expect(backward.reviewComments[0]?.summary).toBe('v2');
  });

  it('createInitialAppState: Phase 2 fields default to empty artifacts so routing signals start clean', () => {
    const state = createInitialAppState('t-1', 'goal');
    expect(state.requirements).toEqual([]);
    expect(state.reviewComments).toEqual([]);
    expect(state.architecture).toBeUndefined();
    expect(state.conventions).toBeUndefined();
  });
});

describe('mutation builders', () => {
  it('mergeByIdMutation normalizes the id so the patch cannot override identity', () => {
    const mutation = mergeByIdMutation('subtasks', 'st-real', { id: 'st-forged', status: 'done' });
    if (mutation.op !== 'mergeById') throw new Error('expected mergeById mutation');
    const value = mutation.value as { id: string; status?: unknown };
    expect(value.id).toBe('st-real');
    expect(value.status).toBe('done');
  });

  it('expose exactly the enabled field sets declared by the active phase slice', () => {
    // Task 2.2 Phase 2 unlock: the three fields feeding conditional routing.
    // Task 2.3 Phase 2 unlock: humanGate carries the iteration-limit escalation (spec §1/§3).
    // Task 2.4 Phase 2 unlock: conventions feeds the §7 projection slice (ARCHITECT/CODER/REVIEWER).
    // Task 3.1 Phase 3 unlock: decisionLedger records decisions with authority levels (spec §1 / blueprint §14).
    // Task 3.2 Phase 3 unlock: handoffPackets carry structured role-switch handoffs (spec §1 / pattern ④).
    // Task 4.1 Phase 4 unlock: complexity.tier feeds adaptive orchestration (spec §3).
    expect([...ENABLED_APPEND_FIELDS]).toEqual([
      'messages',
      'decisionLedger',
      'handoffPackets',
      'reviewComments',
    ]);
    expect([...ENABLED_MERGE_BY_ID_FIELDS]).toEqual(['subtasks', 'requirements']);
    expect([...ENABLED_SET_FIELDS]).toEqual([
      'testResults',
      'phase',
      'nextRole',
      'iterationCount',
      'humanGate',
      'architecture',
      'conventions',
      'complexity',
    ]);
  });

  it('applies set("iterationCount") with last-write-wins semantics for the orchestration loop counter', () => {
    const state = createInitialAppState('t-1', 'goal');
    const once = applyMutations(state, [setMutation('iterationCount', 1)]);
    const twice = applyMutations(once, [setMutation('iterationCount', 2)]);
    expect(once.iterationCount).toBe(1);
    expect(twice.iterationCount).toBe(2);
    expect(state.iterationCount).toBe(0);
  });

  it('rejects non-non-negative-integer iterationCount values instead of corrupting the loop counter', () => {
    const state = createInitialAppState('t-1', 'goal');
    for (const bad of [undefined, NaN, 1.5, -1] as unknown[]) {
      expect(() => applyMutations(state, [setMutation('iterationCount', bad)])).toThrow(
        'iterationCount must be a non-negative integer',
      );
      expect(state.iterationCount).toBe(0);
    }
  });
});

describe('applyMutations · humanGate escalation field (task 2.3, spec §1/§3)', () => {
  function escalation(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      reason: 'iteration_limit',
      options: ['extend', 'take-over', 'abort'],
      phase: 'testing',
      ...overrides,
    };
  }

  it('createInitialAppState leaves humanGate unset so tasks start unescalated', () => {
    expect(createInitialAppState('t-1', 'goal').humanGate).toBeUndefined();
  });

  it('applies set("humanGate") with the §1 shape {reason, options, phase}', () => {
    const state = createInitialAppState('t-1', 'goal');
    const next = applyMutations(state, [setMutation('humanGate', escalation())]);
    expect(next.humanGate).toEqual(escalation());
    expect(state.humanGate).toBeUndefined();
  });

  it('keeps last-write-wins semantics so a re-escalation replaces the stale gate', () => {
    const state = createInitialAppState('t-1', 'goal');
    const first = applyMutations(state, [
      setMutation('humanGate', escalation({ phase: 'testing' })),
    ]);
    const second = applyMutations(first, [
      setMutation('humanGate', escalation({ phase: 'review' })),
    ]);
    expect(first.humanGate?.phase).toBe('testing');
    expect(second.humanGate?.phase).toBe('review');
  });

  it('rejects malformed humanGate values instead of storing an unroutable gate', () => {
    const state = createInitialAppState('t-1', 'goal');
    const malformed: unknown[] = [
      null,
      'iteration_limit',
      ['iteration_limit'],
      escalation({ reason: 42 }),
      escalation({ options: 'extend' }),
      escalation({ options: ['extend', 7] }),
      escalation({ phase: 99 }),
      escalation({ phase: 'bogus' }),
      {},
    ];
    for (const bad of malformed) {
      expect(() => applyMutations(state, [setMutation('humanGate', bad)])).toThrow(
        'humanGate must be { reason: string; options: string[]; phase: Phase }',
      );
      expect(state.humanGate).toBeUndefined();
    }
  });
});

describe('applyMutations · Phase 3 unlocked field (task 3.1)', () => {
  function makeDecisionEntry(id: string, overrides: Partial<Decision> = {}): Decision {
    return {
      id,
      topic: `topic-${id}`,
      decision: `decision-${id}`,
      rationale: `rationale-${id}`,
      authority: 'agent',
      by: 'PM',
      ts: 1,
      ...overrides,
    };
  }

  it('append(decisionLedger): two appends commute to the same ledger set', () => {
    const base = createInitialAppState('t-1', 'goal');
    const first = appendMutation('decisionLedger', makeDecisionEntry('dec-1'));
    const second = appendMutation('decisionLedger', makeDecisionEntry('dec-2'));
    const forward = applyMutations(base, [first, second]);
    const backward = applyMutations(base, [second, first]);
    const sortById = (ledger: Decision[]) => [...ledger].sort((a, b) => a.id.localeCompare(b.id));
    expect(sortById(forward.decisionLedger)).toEqual(sortById(backward.decisionLedger));
  });

  it('append(decisionLedger): replaying the same mutation is idempotent via the identity key', () => {
    const base = createInitialAppState('t-1', 'goal');
    const mutation = appendMutation('decisionLedger', makeDecisionEntry('dec-1'));
    const once = applyMutations(base, [mutation]);
    const twice = applyMutations(once, [mutation]);
    expect(twice.decisionLedger).toHaveLength(1);
    expect(twice.decisionLedger[0]).toEqual(once.decisionLedger[0]);
  });

  it('append(decisionLedger): same id with different content is a producer bug, first write stays', () => {
    const base = createInitialAppState('t-1', 'goal');
    const first = appendMutation('decisionLedger', makeDecisionEntry('dec-1', { decision: 'v1' }));
    const second = appendMutation('decisionLedger', makeDecisionEntry('dec-1', { decision: 'v2' }));
    const forward = applyMutations(base, [first, second]);
    const backward = applyMutations(base, [second, first]);
    expect(forward.decisionLedger).toHaveLength(1);
    expect(backward.decisionLedger).toHaveLength(1);
    expect(forward.decisionLedger[0]?.decision).toBe('v1');
    expect(backward.decisionLedger[0]?.decision).toBe('v2');
  });

  it('append(decisionLedger): rejects a malformed entry at the reducer boundary (set-field precedent)', () => {
    const base = createInitialAppState('t-1', 'goal');
    const mutation = appendMutation('decisionLedger', { id: 'dec-1' });
    expect(() => applyMutations(base, [mutation])).toThrow('invalid decision');
  });

  it('append(decisionLedger): an agent-level entry cannot supersede a leader-level one at the reducer boundary (blueprint §14)', () => {
    const base = createInitialAppState('t-1', 'goal');
    const leader = appendMutation(
      'decisionLedger',
      makeDecisionEntry('dec-1', { authority: 'leader', by: 'leader' }),
    );
    const agentOverride = appendMutation(
      'decisionLedger',
      makeDecisionEntry('dec-2', { authority: 'agent', supersedes: 'dec-1' }),
    );
    const afterLeader = applyMutations(base, [leader]);
    expect(() => applyMutations(afterLeader, [agentOverride])).toThrow(
      'only the leader may override',
    );
  });

  it('append(decisionLedger): rejects supersedes pointing at an unknown decision id', () => {
    const base = createInitialAppState('t-1', 'goal');
    const mutation = appendMutation(
      'decisionLedger',
      makeDecisionEntry('dec-2', { supersedes: 'dec-ghost' }),
    );
    expect(() => applyMutations(base, [mutation])).toThrow('unknown decision id');
  });

  it('createInitialAppState: decisionLedger starts empty so the ledger is append-only from a clean slate', () => {
    expect(createInitialAppState('t-1', 'goal').decisionLedger).toEqual([]);
  });
});

describe('applyMutations · Phase 3 unlocked field (task 3.2, spec §1 / pattern ④)', () => {
  function makeHandoffEntry(overrides: Partial<HandoffPacket> = {}): HandoffPacket {
    return {
      fromRole: 'CODER',
      toRole: 'TESTER',
      done: 'LRU cache implemented and self-tested',
      keyDecisions: [],
      openIssues: [],
      fileRefs: [],
      ts: 1,
      ...overrides,
    };
  }

  function makeLedgerDecision(id: string): Decision {
    return {
      id,
      topic: `topic-${id}`,
      decision: `decision-${id}`,
      rationale: `rationale-${id}`,
      authority: 'agent',
      by: 'PM',
      ts: 1,
    };
  }

  it('append(handoffPackets): two appends commute to the same packet set (no identity key — normalize by ts)', () => {
    const base = createInitialAppState('t-1', 'goal');
    const first = appendMutation(
      'handoffPackets',
      makeHandoffEntry({ fromRole: 'CODER', toRole: 'TESTER', ts: 1 }),
    );
    const second = appendMutation(
      'handoffPackets',
      makeHandoffEntry({ fromRole: 'TESTER', toRole: 'REVIEWER', ts: 2 }),
    );
    const forward = applyMutations(base, [first, second]);
    const backward = applyMutations(base, [second, first]);
    const sortByTs = (packets: HandoffPacket[]) => [...packets].sort((a, b) => a.ts - b.ts);
    expect(sortByTs(forward.handoffPackets)).toEqual(sortByTs(backward.handoffPackets));
  });

  it('append(handoffPackets): replaying the same packet is idempotent via deep-equal dedup (no id field in spec §1)', () => {
    const base = createInitialAppState('t-1', 'goal');
    const mutation = appendMutation('handoffPackets', makeHandoffEntry());
    const once = applyMutations(base, [mutation]);
    const twice = applyMutations(once, [mutation]);
    expect(twice.handoffPackets).toHaveLength(1);
    expect(twice.handoffPackets[0]).toEqual(once.handoffPackets[0]);
  });

  it('append(handoffPackets): two distinct packets are both kept — deep-equal dedup must not conflate them', () => {
    const base = createInitialAppState('t-1', 'goal');
    const coderHandoff = appendMutation(
      'handoffPackets',
      makeHandoffEntry({ fromRole: 'CODER', toRole: 'TESTER', ts: 1 }),
    );
    const testerHandoff = appendMutation(
      'handoffPackets',
      makeHandoffEntry({ fromRole: 'TESTER', toRole: 'REVIEWER', ts: 2 }),
    );
    const next = applyMutations(base, [coderHandoff, testerHandoff]);
    expect(next.handoffPackets).toHaveLength(2);
  });

  it('append(handoffPackets): rejects a malformed packet at the reducer boundary (3.1 boundary-validation precedent)', () => {
    const base = createInitialAppState('t-1', 'goal');
    const mutation = appendMutation('handoffPackets', { fromRole: 'CODER' });
    expect(() => applyMutations(base, [mutation])).toThrow('invalid handoff packet');
  });

  it('append(handoffPackets): rejects fileRefs that paste code instead of path:line references (iron rule 2)', () => {
    const base = createInitialAppState('t-1', 'goal');
    const mutation = appendMutation(
      'handoffPackets',
      makeHandoffEntry({ fileRefs: ['const x = 1; // full source'] }),
    );
    expect(() => applyMutations(base, [mutation])).toThrow('invalid handoff packet');
  });

  it('append(handoffPackets): rejects keyDecisions referencing an unknown decision id (traceability, blueprint §14)', () => {
    const base = createInitialAppState('t-1', 'goal');
    const mutation = appendMutation(
      'handoffPackets',
      makeHandoffEntry({ keyDecisions: ['dec-ghost'] }),
    );
    expect(() => applyMutations(base, [mutation])).toThrow('unknown decision id');
  });

  it('append(handoffPackets): accepts keyDecisions referencing decisions already recorded in the ledger', () => {
    const base = createInitialAppState('t-1', 'goal');
    const seed = appendMutation('decisionLedger', makeLedgerDecision('dec-1'));
    const handoff = appendMutation('handoffPackets', makeHandoffEntry({ keyDecisions: ['dec-1'] }));
    const next = applyMutations(base, [seed, handoff]);
    expect(next.handoffPackets).toHaveLength(1);
    expect(next.handoffPackets[0]?.keyDecisions).toEqual(['dec-1']);
  });

  it('createInitialAppState: handoffPackets starts empty so handoffs are append-only from a clean slate', () => {
    expect(createInitialAppState('t-1', 'goal').handoffPackets).toEqual([]);
  });
});

describe('applyMutations · Phase 4 unlocked field (task 4.1, spec §1/§3)', () => {
  it('applies set("complexity") with the §1 shape {tier, signals}', () => {
    const state = applyMutations(createInitialAppState('t-1', 'goal'), [
      setMutation('complexity', { tier: 0, signals: { rule: 'tier0.single_entity' } }),
    ]);
    expect(state.complexity).toEqual({ tier: 0, signals: { rule: 'tier0.single_entity' } });
  });

  it('set(complexity): last-write-wins overwrite with stable replays', () => {
    const initial = createInitialAppState('t-1', 'goal');
    const once = applyMutations(initial, [
      setMutation('complexity', { tier: 0, signals: { rule: 'tier0.single_entity' } }),
    ]);
    const twice = applyMutations(once, [
      setMutation('complexity', { tier: 2, signals: { rule: 'tier2.multi_module' } }),
    ]);
    expect(once.complexity?.tier).toBe(0);
    expect(twice.complexity?.tier).toBe(2);
    const replay = applyMutations(initial, [
      setMutation('complexity', { tier: 0, signals: { rule: 'tier0.single_entity' } }),
      setMutation('complexity', { tier: 2, signals: { rule: 'tier2.multi_module' } }),
    ]);
    expect(replay.complexity).toEqual(twice.complexity);
  });

  it('rejects malformed complexity values instead of storing an unroutable tier', () => {
    const state = createInitialAppState('t-1', 'goal');
    const bad = [
      null,
      ['tier', 0],
      { tier: 0 },
      { signals: {} },
      { tier: 3, signals: {} },
      { tier: 1.5, signals: {} },
      { tier: '1', signals: {} },
      { tier: 1, signals: [] },
      { tier: 1, signals: 'none' },
    ] as unknown[];
    for (const value of bad) {
      expect(() => applyMutations(state, [setMutation('complexity', value)])).toThrow(
        'complexity must be { tier: 0 | 1 | 2; signals: Record<string, unknown> }',
      );
      expect(state.complexity).toBeUndefined();
    }
  });

  it('createInitialAppState leaves complexity unset so the entry node evaluates it exactly once', () => {
    expect('complexity' in createInitialAppState('t-1', 'goal')).toBe(false);
  });

  it('cross-op commutativity: set(complexity) and append(messages) commute to an equivalent terminal state', () => {
    const initial = createInitialAppState('t-1', 'goal');
    const message = makeMessage();
    const setThenAppend = applyMutations(initial, [
      setMutation('complexity', { tier: 1, signals: { rule: 'tier1.default' } }),
      appendMutation('messages', message),
    ]);
    const appendThenSet = applyMutations(initial, [
      appendMutation('messages', message),
      setMutation('complexity', { tier: 1, signals: { rule: 'tier1.default' } }),
    ]);
    expect(setThenAppend.complexity).toEqual(appendThenSet.complexity);
    expect(sortMessages(setThenAppend)).toEqual(sortMessages(appendThenSet));
  });
});
