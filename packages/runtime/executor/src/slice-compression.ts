import type { Decision } from '@agora/core-domain';

/**
 * Cross-agent projection-slice compression (task 3.4, spec §7 "long history
 * compression, split in two").
 *
 * Division of labor: single-agent history compression is delegated to Harness
 * ctx.compaction (never self-built); cross-agent slice compression — this
 * module — replaces oversized slice entries with summaries while keeping a
 * retrieval entry (the decision id here; msgId/fileRef once channel slices
 * land in Phase 6).
 *
 * Task 3.4 rulings (user-approved): compression happens at projection read
 * time — State stays the complete append-only truth, so R1 mutation
 * semantics, the supersedes-chain validation, and the first-write-stays
 * producer contract are untouched, and State size never reaches model context
 * (R2). Heads are never dropped (iron rule 3: rationale travels with the
 * decision), so the collapsed slice is the deterministic size floor; when it
 * still exceeds the threshold it is returned as-is (best effort). LLM-backed
 * summarization and channel localContext adoption are Phase 6 R9 upgrade
 * points.
 */

/** Serialized-slice char budget that triggers compression (ruling ④). */
export const SLICE_COMPRESSION_THRESHOLD_CHARS = 4000;

/** Retrieval stub for a superseded entry: its id stays addressable (§7). */
export interface SupersededTombstone {
  id: string;
  topic: string;
  supersededBy: string;
}

export type SliceSummarizer<T> = (entries: readonly T[]) => readonly unknown[];

/**
 * Generic slice-compression primitive (ruling ①): verbatim defensive array
 * copy while the serialized slice fits the budget, the injected summarizer
 * takes over past it. Pure and deterministic.
 */
export function compressWhenOverThreshold<T>(
  entries: readonly T[],
  thresholdChars: number,
  summarize: SliceSummarizer<T>,
): readonly unknown[] {
  if (JSON.stringify(entries).length <= thresholdChars) return [...entries];
  return summarize(entries);
}

/**
 * Deterministic supersede-chain collapse for the decision ledger (ruling ③):
 * every entry superseded by another entry in the slice becomes a tombstone
 * keeping its retrieval id; heads keep full fidelity. Original append order
 * is preserved (no regrouping). An agent entry can never supersede a leader
 * entry (ledger.ts), so pointers between slice members are self-contained.
 */
export function collapseSupersededDecisions(
  entries: readonly Decision[],
): readonly (Decision | SupersededTombstone)[] {
  const supersededBy = new Map<string, string>();
  for (const entry of entries) {
    if (entry.supersedes !== undefined) supersededBy.set(entry.supersedes, entry.id);
  }
  return entries.map((entry) => {
    const by = supersededBy.get(entry.id);
    return by === undefined ? entry : { id: entry.id, topic: entry.topic, supersededBy: by };
  });
}
