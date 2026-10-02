/** Pure, bounded three-way inverse. Distinct optimal line alignments are a
 * conflict; no arbitrary LCS tie or heuristic is used to discard user edits. */
export type LocalUndoTextResult =
  | { kind: 'merged'; content: string }
  | {
      kind: 'conflict';
      reason: 'ambiguous_text' | 'overlapping_changes' | 'unsupported_text' | 'comparison_limit';
    };
type Hunk = { start: number; end: number; lines: string[] };
type Difference =
  | { kind: 'changes'; hunks: Hunk[] }
  | Extract<LocalUndoTextResult, { kind: 'conflict' }>;
const maxCells = 262144;
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function difference(a: string[], b: string[]): Difference {
  const columns = b.length + 1,
    cells = (a.length + 1) * columns;
  if (cells > maxCells) return { kind: 'conflict', reason: 'comparison_limit' };
  const length = new Uint32Array(cells),
    first = new Uint32Array(cells),
    second = new Uint32Array(cells);
  // Persistent match chains make path identity exact without copying whole
  // alignments per cell. Each diagonal creates at most two bounded nodes.
  const nodes: { i: number; j: number; next: number }[] = [{ i: -1, j: -1, next: 0 }];
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) {
      const at = i * columns + j,
        down = at + columns,
        right = at + 1,
        diag = down + 1;
      const best = Math.max(
        length[down] ?? 0,
        length[right] ?? 0,
        a[i] === b[j] ? (length[diag] ?? 0) + 1 : 0,
      );
      length[at] = best;
      if (best === 0) continue;
      const ids = new Set<number>();
      if (a[i] === b[j] && (length[diag] ?? 0) + 1 === best) {
        for (const next of [first[diag] ?? 0, ...(second[diag] ? [second[diag] as number] : [])]) {
          nodes.push({ i, j, next });
          ids.add(nodes.length - 1);
        }
      }
      for (const neighbor of [down, right])
        if (length[neighbor] === best) {
          ids.add(first[neighbor] ?? 0);
          if (second[neighbor]) ids.add(second[neighbor] as number);
        }
      const candidates = [...ids];
      first[at] = candidates[0] ?? 0;
      second[at] = candidates[1] ?? 0;
    }
  if (second[0]) return { kind: 'conflict', reason: 'ambiguous_text' };
  const hunks: Hunk[] = [];
  let i = 0,
    j = 0,
    node = first[0] ?? 0;
  while (node) {
    const match = nodes[node];
    if (!match) throw Error('invalid_undo_alignment');
    if (i !== match.i || j !== match.j)
      hunks.push({ start: i, end: match.i, lines: b.slice(j, match.j) });
    i = match.i + 1;
    j = match.j + 1;
    node = match.next;
  }
  if (i !== a.length || j !== b.length) hunks.push({ start: i, end: a.length, lines: b.slice(j) });
  return { kind: 'changes', hunks };
}
const same = (a: Hunk, b: Hunk) =>
  a.start === b.start &&
  a.end === b.end &&
  a.lines.length === b.lines.length &&
  a.lines.every((s, i) => s === b.lines[i]);
function overlap(a: Hunk, b: Hunk) {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}
export function mergeLocalUndoText(
  installed: string,
  original: string,
  current: string,
): LocalUndoTextResult {
  if ([installed, original, current].some((s) => s.includes('\0') || s.length > 16 * 1024 * 1024))
    return { kind: 'conflict', reason: 'unsupported_text' };
  if (current === installed) return { kind: 'merged', content: original };
  if (original === installed) return { kind: 'merged', content: current };
  if (current === original) return { kind: 'merged', content: current };
  const a = lines(installed),
    inverse = difference(a, lines(original)),
    user = difference(a, lines(current));
  if (inverse.kind === 'conflict') return inverse;
  if (user.kind === 'conflict') return user;
  const merged = [...user.hunks];
  for (const hunk of inverse.hunks) {
    if (
      user.hunks.some(
        (u) =>
          same(hunk, u) ||
          (u.start <= hunk.start &&
            u.end >= hunk.end &&
            u.lines.length === u.end - u.start &&
            hunk.lines.length === hunk.end - hunk.start &&
            hunk.lines.every((line, index) => line === u.lines[hunk.start - u.start + index])),
      )
    )
      continue;
    if (user.hunks.some((u) => overlap(hunk, u)))
      return { kind: 'conflict', reason: 'overlapping_changes' };
    merged.push(hunk);
  }
  merged.sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of merged) {
    out.push(a.slice(cursor, hunk.start).join(''), hunk.lines.join(''));
    cursor = hunk.end;
  }
  out.push(a.slice(cursor).join(''));
  return { kind: 'merged', content: out.join('') };
}
