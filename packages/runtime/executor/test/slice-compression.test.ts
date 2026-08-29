import type { Decision } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import {
  collapseSupersededDecisions,
  compressWhenOverThreshold,
  SLICE_COMPRESSION_THRESHOLD_CHARS,
  type SupersededTombstone,
} from '../src/slice-compression';

// Task 3.4 (spec §7 cross-agent slice compression, self-built side of the
// "long history compression, split in two" rule). Pure data assertions, no
// mocks (R11): the generic threshold primitive and the deterministic
// supersede-collapse strategy. Division of labor: single-agent history
// compression belongs to Harness ctx.compaction and is NOT covered here.
// Rulings (task 3.4 plan, user-approved): projection read-time compression,
// State stays complete; heads never dropped (iron rule 3); threshold is the
// serialized slice char length (default 4000).

const LONG = 'x'.repeat(4200);

function makeDecision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    topic: 'cache-eviction',
    decision: `decision ${id}`,
    rationale: `rationale for ${id}`,
    authority: 'leader',
    by: 'leader',
    ts: 1,
    ...overrides,
  };
}

type Entry = Decision | SupersededTombstone;

function kinds(entries: readonly unknown[]): string[] {
  return entries.map((entry) => ('supersededBy' in (entry as Entry) ? 'tombstone' : 'head'));
}

describe('compressWhenOverThreshold (task 3.4, spec §7)', () => {
  it('below threshold: verbatim content in a new array (the array itself is defensively copied)', () => {
    const entries = [makeDecision('d1'), makeDecision('d2')];
    const out = compressWhenOverThreshold(
      entries,
      SLICE_COMPRESSION_THRESHOLD_CHARS,
      collapseSupersededDecisions,
    );
    expect(out).toEqual(entries);
    expect(out).not.toBe(entries);
  });

  it('exactly at the threshold boundary: still verbatim (<=, not <); one char over triggers collapse', () => {
    const entries = [makeDecision('d1'), makeDecision('d2', { supersedes: 'd1', ts: 2 })];
    const size = JSON.stringify(entries).length;
    expect(compressWhenOverThreshold(entries, size, collapseSupersededDecisions)).toEqual(entries);
    expect(compressWhenOverThreshold(entries, size - 1, collapseSupersededDecisions)).not.toEqual(
      entries,
    );
  });

  it('over threshold: head keeps full fidelity (rationale travels), superseded entry becomes a tombstone', () => {
    const entries = [
      makeDecision('d1', { rationale: `SENTINEL-SUPERSEDED-RATIONALE ${LONG}` }),
      makeDecision('d2', {
        supersedes: 'd1',
        ts: 2,
        rationale: `SENTINEL-HEAD-RATIONALE ${LONG}`,
      }),
    ];
    const out = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    const json = JSON.stringify(out);
    expect(json).toContain('SENTINEL-HEAD-RATIONALE');
    expect(json).not.toContain('SENTINEL-SUPERSEDED-RATIONALE');
    expect(out[0]).toEqual({ id: 'd1', topic: 'cache-eviction', supersededBy: 'd2' });
    expect(out[1]).toEqual(entries[1]);
  });

  it('supersede chain collapses to one head plus one tombstone per superseded entry, original order kept', () => {
    const entries = [
      makeDecision('d1', { rationale: LONG }),
      makeDecision('d2', { supersedes: 'd1', ts: 2, rationale: LONG }),
      makeDecision('d3', { supersedes: 'd2', ts: 3, rationale: LONG }),
    ];
    const out = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    expect(kinds(out)).toEqual(['tombstone', 'tombstone', 'head']);
    expect(out[0]).toEqual({ id: 'd1', topic: 'cache-eviction', supersededBy: 'd2' });
    expect(out[1]).toEqual({ id: 'd2', topic: 'cache-eviction', supersededBy: 'd3' });
    expect(out[2]).toEqual(entries[2]);
  });

  it('topics collapse independently: a supersede in one topic does not touch another', () => {
    const entries = [
      makeDecision('a1', { topic: 'auth', rationale: LONG }),
      makeDecision('a2', { topic: 'auth', supersedes: 'a1', ts: 2, rationale: LONG }),
      makeDecision('b1', { topic: 'cache', rationale: LONG }),
    ];
    const out = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    expect(out[0]).toEqual({ id: 'a1', topic: 'auth', supersededBy: 'a2' });
    expect(out[1]).toEqual(entries[1]);
    expect(out[2]).toEqual(entries[2]);
  });

  it('cross-topic supersede does not collapse: the superseded entry keeps full fidelity (a tombstone must never point outside its topic)', () => {
    const entries = [
      makeDecision('x1', { topic: 'auth', rationale: LONG }),
      makeDecision('x2', { topic: 'cache', supersedes: 'x1', ts: 2, rationale: LONG }),
    ];
    const out = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    expect(kinds(out)).toEqual(['head', 'head']);
    expect(out[0]).toEqual(entries[0]);
    expect(out[1]).toEqual(entries[1]);
  });

  it('same-topic collapse wins over a cross-topic pointer at the same target: only in-topic supersedes record tombstones', () => {
    const entries = [
      makeDecision('a1', { topic: 'auth', rationale: LONG }),
      makeDecision('a2', { topic: 'auth', supersedes: 'a1', ts: 2, rationale: LONG }),
      makeDecision('b1', { topic: 'cache', supersedes: 'a1', ts: 3, rationale: LONG }),
    ];
    const out = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    expect(out[0]).toEqual({ id: 'a1', topic: 'auth', supersededBy: 'a2' });
    expect(out[1]).toEqual(entries[1]);
    expect(out[2]).toEqual(entries[2]);
  });

  it('iron rule 3 bound: over threshold with zero superseded entries keeps every head verbatim (never drops live decisions)', () => {
    const entries = [
      makeDecision('d1', { rationale: LONG }),
      makeDecision('d2', { rationale: LONG, ts: 2 }),
    ];
    const out = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    expect(out).toEqual(entries);
  });

  it('deterministic: identical input yields identical output across calls', () => {
    const entries = [
      makeDecision('d1', { rationale: LONG }),
      makeDecision('d2', { supersedes: 'd1', ts: 2, rationale: LONG }),
    ];
    const first = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    const second = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    expect(first).toEqual(second);
  });

  it('tombstone carries only {id, topic, supersededBy} — no raw-log fields (iron rule 1 interplay)', () => {
    const entries = [
      makeDecision('d1', { rationale: LONG }),
      makeDecision('d2', { supersedes: 'd1', ts: 2, rationale: LONG }),
    ];
    const out = compressWhenOverThreshold(entries, 10, collapseSupersededDecisions);
    const tombstone = out[0] as SupersededTombstone;
    expect(Object.keys(tombstone).sort()).toEqual(['id', 'supersededBy', 'topic']);
    expect(tombstone).not.toHaveProperty('msgId');
    expect(tombstone).not.toHaveProperty('channelId');
    expect(tombstone).not.toHaveProperty('fromRole');
  });

  it('threshold default constant is 4000 chars (serialized-size proxy, ruling ④)', () => {
    expect(SLICE_COMPRESSION_THRESHOLD_CHARS).toBe(4000);
  });
});
