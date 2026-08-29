import { describe, expect, it } from 'vitest';
import type { Decision } from '../src/index';
import { addDecision } from '../src/index';

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-1',
    topic: 'topic-1',
    decision: 'decision-1',
    rationale: 'rationale-1',
    authority: 'agent',
    by: 'PM',
    ts: 1,
    ...overrides,
  };
}

describe('addDecision · append semantics (spec §1)', () => {
  it('appends a decision and returns a fresh ledger without touching the input', () => {
    const ledger = [makeDecision()];
    const snapshot = ledger.map((entry) => ({ ...entry }));
    const incoming = makeDecision({ id: 'dec-2', topic: 'topic-2' });
    const result = addDecision(ledger, incoming);
    expect(result.ledger).toHaveLength(2);
    expect(result.ledger[1]).toEqual(incoming);
    expect(ledger).toEqual(snapshot);
  });

  it('replays idempotently: same id with deep-equal content returns the ledger unchanged', () => {
    const decision = makeDecision();
    const once = addDecision([], decision);
    const twice = addDecision(once.ledger, { ...decision });
    expect(twice.ledger).toEqual(once.ledger);
    expect(twice.ledger).toHaveLength(1);
    expect(twice.conflicts).toEqual([]);
  });

  it('rejects the same id with different content as a producer contract violation (spec §1: first write stays)', () => {
    const decision = makeDecision();
    const once = addDecision([], decision);
    expect(() => addDecision(once.ledger, { ...decision, decision: 'revised' })).toThrow(
      'already exists with different content',
    );
  });

  it('rejects malformed decisions instead of storing an unroutable ledger entry', () => {
    const malformed: Decision[] = [
      makeDecision({ id: '' }),
      makeDecision({ topic: '' }),
      makeDecision({ decision: '' }),
      makeDecision({ rationale: '' }),
      makeDecision({ by: '' }),
      makeDecision({ authority: 'pm' as unknown as Decision['authority'] }),
      makeDecision({ ts: Number.NaN }),
    ];
    for (const bad of malformed) {
      expect(() => addDecision([], bad)).toThrow('invalid decision');
    }
  });
});

describe('addDecision · authority levels (blueprint §14)', () => {
  it('an agent-level decision cannot supersede a leader-level one: only the leader may override it', () => {
    const ledger = [makeDecision({ id: 'dec-1', authority: 'leader', by: 'leader' })];
    const incoming = makeDecision({ id: 'dec-2', authority: 'agent', supersedes: 'dec-1' });
    expect(() => addDecision(ledger, incoming)).toThrow('only the leader may override');
  });

  it('the leader may override an agent-level decision', () => {
    const ledger = [makeDecision({ id: 'dec-1', authority: 'agent' })];
    const incoming = makeDecision({
      id: 'dec-2',
      authority: 'leader',
      by: 'leader',
      supersedes: 'dec-1',
    });
    const result = addDecision(ledger, incoming);
    expect(result.ledger).toHaveLength(2);
  });

  it('same-level overrides are allowed (agent→agent and leader→leader)', () => {
    const agentLedger = [makeDecision({ id: 'dec-1', authority: 'agent' })];
    const agentOverride = makeDecision({ id: 'dec-2', authority: 'agent', supersedes: 'dec-1' });
    expect(addDecision(agentLedger, agentOverride).ledger).toHaveLength(2);

    const leaderLedger = [makeDecision({ id: 'dec-1', authority: 'leader', by: 'leader' })];
    const leaderOverride = makeDecision({
      id: 'dec-2',
      authority: 'leader',
      by: 'leader',
      supersedes: 'dec-1',
    });
    expect(addDecision(leaderLedger, leaderOverride).ledger).toHaveLength(2);
  });

  it('rejects supersedes pointing at an unknown decision id', () => {
    expect(() => addDecision([], makeDecision({ id: 'dec-2', supersedes: 'dec-ghost' }))).toThrow(
      'unknown decision id',
    );
  });
});

describe('addDecision · conflict detection (raw signal, classification deferred to Phase 8)', () => {
  it('surfaces a conflict for an existing decision on the same topic', () => {
    const ledger = [makeDecision({ id: 'dec-1', topic: 'auth' })];
    const incoming = makeDecision({ id: 'dec-2', topic: 'auth' });
    const result = addDecision(ledger, incoming);
    expect(result.conflicts).toEqual([{ existingId: 'dec-1', incomingId: 'dec-2', topic: 'auth' }]);
  });

  it('excludes the explicitly superseded entry from conflicts (it is the formal override)', () => {
    const ledger = [makeDecision({ id: 'dec-1', topic: 'auth' })];
    const incoming = makeDecision({ id: 'dec-2', topic: 'auth', supersedes: 'dec-1' });
    expect(addDecision(ledger, incoming).conflicts).toEqual([]);
  });

  it('reports no conflicts for distinct topics', () => {
    const ledger = [makeDecision({ id: 'dec-1', topic: 'auth' })];
    const result = addDecision(ledger, makeDecision({ id: 'dec-2', topic: 'caching' }));
    expect(result.conflicts).toEqual([]);
  });
});
