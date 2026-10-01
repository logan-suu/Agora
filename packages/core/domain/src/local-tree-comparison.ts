import { compareLocalDelivery, type DeliveryFile } from './local-delivery-comparison';
import { isWorkspaceRelativePath } from './local-workspace';

/** Complete logical contents only. Physical identity, metadata, authority and
 * native transaction receipts remain the execution layer's responsibility. */
export interface DeliveryTree {
  files: DeliveryFile[];
  directories: string[];
}
export type DeliveryNode = { kind: 'directory' } | { kind: 'file'; file: DeliveryFile };
export interface TreeOperation {
  op: 'remove' | 'rmdir' | 'mkdir' | 'put';
  path: string;
  before: DeliveryNode | null;
  after: DeliveryNode | null;
}
export type TreeComparison =
  | { status: 'conflict'; conflicts: string[]; candidate: null; operations: null }
  | {
      status: 'matches_artifact' | 'requires_validation';
      conflicts: [];
      candidate: DeliveryTree;
      operations: TreeOperation[];
    };
function invalid(): never {
  throw Error('invalid_delivery_tree');
}
function array(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 4096 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    invalid();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return value;
}
const parent = (path: string) => path.split('/').slice(0, -1).join('/');
const related = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const reserved = (path: string) =>
  path.split('/').some((part) => {
    const name = part.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    return (
      name === '.git' || name === '.agora-operations' || name === '.env' || name.startsWith('.env.')
    );
  });
function paths(value: unknown, visible: boolean): string[] {
  const result = array(value).map((path) => {
    if (!isWorkspaceRelativePath(path) || (visible && reserved(path))) invalid();
    return path;
  });
  if (new Set(result).size !== result.length) invalid();
  return result.sort();
}
function tree(input: DeliveryTree): Map<string, DeliveryNode> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 2 ||
    !['files', 'directories'].every((key) => {
      const d = Object.getOwnPropertyDescriptor(input, key);
      return d?.enumerable && Object.hasOwn(d, 'value');
    })
  )
    invalid();
  const directories = paths(input.directories, true);
  let files: DeliveryFile[];
  try {
    const normalized = compareLocalDelivery([], input.files, []);
    if (!normalized.candidate) invalid();
    files = normalized.candidate;
  } catch {
    return invalid();
  }
  if (files.length + directories.length > 4096 || files.some((f) => reserved(f.path))) invalid();
  const result = new Map<string, DeliveryNode>(
    directories.map((path) => [path, { kind: 'directory' }]),
  );
  for (const file of files) {
    if (result.has(file.path)) invalid();
    result.set(file.path, { kind: 'file', file });
  }
  for (const path of result.keys()) {
    const ancestor = parent(path);
    if (ancestor && result.get(ancestor)?.kind !== 'directory') invalid();
  }
  return result;
}
function same(a: DeliveryNode | null, b: DeliveryNode | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'directory' || b.kind === 'directory') return true;
  return (
    a.file.sha256 === b.file.sha256 &&
    a.file.size === b.file.size &&
    a.file.executable === b.file.executable
  );
}
const copy = (node: DeliveryNode | null): DeliveryNode | null =>
  node?.kind === 'file'
    ? { kind: 'file', file: { ...node.file } }
    : node
      ? { kind: 'directory' }
      : null;
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const depth = (path: string) => path.split('/').length;

/** Complete a verified Git file merge with independently fixed directory facts.
 * Git remains responsible for ordinary file merges; it cannot attest empty directories. */
export function completeLocalMergeTree(
  baseline: DeliveryTree,
  target: DeliveryTree,
  source: DeliveryTree,
  mergedFiles: DeliveryFile[],
): { kind: 'merged'; tree: DeliveryTree } | { kind: 'conflict'; paths: string[] } {
  const b = tree(baseline),
    t = tree(target),
    s = tree(source);
  let files: DeliveryFile[];
  try {
    const normalized = compareLocalDelivery([], mergedFiles, []);
    if (!normalized.candidate) invalid();
    files = normalized.candidate;
  } catch {
    return invalid();
  }
  // Inferred parents validate only the supplied Git tree, never supply directory facts.
  const required = new Set<string>();
  for (const file of files)
    for (let path = parent(file.path); path; path = parent(path)) required.add(path);
  const git = tree({ files, directories: [...required] });
  const all = [...new Set([...b.keys(), ...t.keys(), ...s.keys(), ...git.keys()])].sort();
  if (all.length > 4096) invalid();
  const chosen = new Map<string, DeliveryNode>(
    files.map((file) => [file.path, { kind: 'file', file }]),
  );
  const conflicts = new Set<string>();
  for (const path of all) {
    const before = b.get(path) ?? null,
      ours = t.get(path) ?? null,
      theirs = s.get(path) ?? null;
    if (![before, ours, theirs].some((node) => node?.kind === 'directory')) continue;
    let selected: DeliveryNode | null;
    if (same(theirs, before) || same(ours, theirs)) selected = ours;
    else if (same(ours, before)) selected = theirs;
    else {
      conflicts.add(path);
      continue;
    }
    const merged = chosen.get(path) ?? null;
    if (selected?.kind === 'directory') {
      if (merged) conflicts.add(path);
      else chosen.set(path, selected);
    } else if (!same(selected, merged)) conflicts.add(path);
  }
  for (const path of chosen.keys())
    for (let ancestor = parent(path); ancestor; ancestor = parent(ancestor))
      if (chosen.get(ancestor)?.kind !== 'directory') {
        conflicts.add(path);
        conflicts.add(ancestor);
      }
  if (conflicts.size) return { kind: 'conflict', paths: [...conflicts].sort() };
  return {
    kind: 'merged',
    tree: {
      files,
      directories: [...chosen]
        .filter(([, node]) => node.kind === 'directory')
        .map(([path]) => path)
        .sort(),
    },
  };
}

/** B/A/U reconciliation followed by structural validation. A conflict yields no
 * executable prefix, and a combined tree never inherits the artifact's approval. */
export function compareLocalTrees(
  baseline: DeliveryTree,
  artifact: DeliveryTree,
  current: DeliveryTree,
  protectedPaths: readonly string[] = [],
): TreeComparison {
  const b = tree(baseline),
    a = tree(artifact),
    u = tree(current);
  const protectedSet = paths(protectedPaths, false);
  for (const path of protectedSet) {
    const ancestor = parent(path);
    if (
      u.has(path) ||
      (ancestor && u.get(ancestor)?.kind !== 'directory') ||
      protectedSet.some((other) => other !== path && related(path, other))
    )
      invalid();
  }
  const all = [...new Set([...b.keys(), ...a.keys(), ...u.keys()])].sort();
  if (all.length + protectedSet.length > 4096) invalid();
  const chosen = new Map<string, DeliveryNode>();
  const conflicts = new Set<string>();
  for (const path of all) {
    const before = b.get(path) ?? null,
      tested = a.get(path) ?? null,
      user = u.get(path) ?? null;
    let result: DeliveryNode | null;
    if (same(tested, before) || same(user, tested)) result = user;
    else if (same(user, before)) result = tested;
    else {
      conflicts.add(path);
      continue;
    }
    if (result) chosen.set(path, result);
  }
  for (const path of chosen.keys()) {
    for (let ancestor = parent(path); ancestor; ancestor = parent(ancestor)) {
      if (chosen.get(ancestor)?.kind !== 'directory') {
        conflicts.add(path);
        conflicts.add(ancestor);
      }
    }
  }
  const operations: TreeOperation[] = [];
  const add = (
    op: TreeOperation['op'],
    path: string,
    before: DeliveryNode | null,
    after: DeliveryNode | null,
  ) => operations.push({ op, path, before: copy(before), after: copy(after) });
  for (const path of all) {
    const before = u.get(path) ?? null,
      after = chosen.get(path) ?? null;
    if (same(before, after) || conflicts.has(path)) continue;
    if (protectedSet.some((protectedPath) => related(path, protectedPath))) conflicts.add(path);
    if (before?.kind === 'file' && after?.kind !== 'file') add('remove', path, before, null);
    if (before?.kind === 'directory' && after?.kind !== 'directory')
      add('rmdir', path, before, null);
    if (after?.kind === 'directory' && before?.kind !== 'directory')
      add('mkdir', path, null, after);
    if (after?.kind === 'file') add('put', path, before?.kind === 'file' ? before : null, after);
  }
  if (conflicts.size)
    return {
      status: 'conflict',
      conflicts: [...conflicts].sort(),
      candidate: null,
      operations: null,
    };
  const rank = { remove: 0, rmdir: 1, mkdir: 2, put: 3 };
  operations.sort(
    (x, y) =>
      rank[x.op] - rank[y.op] ||
      (x.op === 'rmdir'
        ? depth(y.path) - depth(x.path)
        : x.op === 'mkdir'
          ? depth(x.path) - depth(y.path)
          : 0) ||
      order(x.path, y.path),
  );
  const candidate: DeliveryTree = { directories: [], files: [] };
  for (const path of [...chosen.keys()].sort()) {
    const node = chosen.get(path);
    if (node?.kind === 'file') candidate.files.push({ ...node.file });
    else candidate.directories.push(path);
  }
  if (candidate.files.reduce((total, file) => total + file.size, 0) > 256 * 1024 * 1024) invalid();
  const matches = all.every((path) => same(chosen.get(path) ?? null, a.get(path) ?? null));
  return {
    status: matches ? 'matches_artifact' : 'requires_validation',
    conflicts: [],
    candidate,
    operations,
  };
}
