import { describe, expect, it } from 'vitest';
import type { Decision, HandoffPacket } from '../src/index';
import { assertAppendableHandoff, assertValidHandoff } from '../src/index';

function makeDecision(id: string, overrides: Partial<Decision> = {}): Decision {
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

function makeHandoffPacket(overrides: Partial<HandoffPacket> = {}): HandoffPacket {
  return {
    fromRole: 'CODER',
    toRole: 'TESTER',
    done: 'Implemented the LRU cache with TTL eviction',
    keyDecisions: [],
    openIssues: [],
    fileRefs: ['src/lru.ts:12-48'],
    ts: 1,
    ...overrides,
  };
}

describe('assertValidHandoff · shape validation (spec §1)', () => {
  it('accepts a well-formed handoff packet', () => {
    expect(() => assertValidHandoff(makeHandoffPacket())).not.toThrow();
  });

  it('rejects empty fromRole, toRole, or done — the packet must be routable and informative', () => {
    const malformed: HandoffPacket[] = [
      makeHandoffPacket({ fromRole: '' }),
      makeHandoffPacket({ toRole: '' }),
      makeHandoffPacket({ done: '' }),
    ];
    for (const bad of malformed) {
      expect(() => assertValidHandoff(bad)).toThrow('invalid handoff packet');
    }
  });

  it('rejects non-string elements in keyDecisions, openIssues, or fileRefs', () => {
    const malformed: HandoffPacket[] = [
      makeHandoffPacket({ keyDecisions: [42] as unknown as string[] }),
      makeHandoffPacket({ openIssues: [null] as unknown as string[] }),
      makeHandoffPacket({ fileRefs: [{}] as unknown as string[] }),
      makeHandoffPacket({ keyDecisions: 'dec-1' as unknown as string[] }),
    ];
    for (const bad of malformed) {
      expect(() => assertValidHandoff(bad)).toThrow('invalid handoff packet');
    }
  });

  it('rejects a non-finite ts', () => {
    expect(() => assertValidHandoff(makeHandoffPacket({ ts: Number.NaN }))).toThrow(
      'invalid handoff packet',
    );
    expect(() => assertValidHandoff(makeHandoffPacket({ ts: Number.POSITIVE_INFINITY }))).toThrow(
      'invalid handoff packet',
    );
  });

  it('rejects null/undefined/non-object packets instead of storing an unroutable entry', () => {
    const malformed: unknown[] = [null, undefined, 'handoff', 42, []];
    for (const bad of malformed) {
      expect(() => assertValidHandoff(bad as unknown as HandoffPacket)).toThrow(
        'invalid handoff packet',
      );
    }
  });

  it('does not mutate its inputs (pure function, L1 domain)', () => {
    const ledger = [makeDecision('dec-1')];
    const ledgerSnapshot = ledger.map((entry) => ({ ...entry }));
    const packet = makeHandoffPacket({ keyDecisions: ['dec-1'] });
    const packetSnapshot = {
      ...packet,
      keyDecisions: [...packet.keyDecisions],
      openIssues: [...packet.openIssues],
      fileRefs: [...packet.fileRefs],
    };
    assertAppendableHandoff(ledger, packet);
    expect(ledger).toEqual(ledgerSnapshot);
    expect(packet).toEqual(packetSnapshot);
  });
});

describe('assertAppendableHandoff · keyDecisions referential integrity (3.1 supersedes precedent)', () => {
  it('accepts a packet whose keyDecisions all reference existing decisionLedger ids', () => {
    const ledger = [makeDecision('dec-1'), makeDecision('dec-2')];
    const packet = makeHandoffPacket({ keyDecisions: ['dec-1', 'dec-2'] });
    expect(() => assertAppendableHandoff(ledger, packet)).not.toThrow();
  });

  it('accepts a packet with empty keyDecisions (nothing to trace)', () => {
    expect(() => assertAppendableHandoff([], makeHandoffPacket())).not.toThrow();
  });

  it('rejects keyDecisions referencing an unknown decision id', () => {
    const ledger = [makeDecision('dec-1')];
    const packet = makeHandoffPacket({ keyDecisions: ['dec-1', 'dec-ghost'] });
    expect(() => assertAppendableHandoff(ledger, packet)).toThrow('unknown decision id');
  });
});
