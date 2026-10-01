import { isWorkspaceRelativePath } from './local-workspace';

/** Content comparison only. No result constitutes authorization or an applied receipt. */
export interface DeliveryFile {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
}
export interface DeliveryComparisonEntry {
  path: string;
  baseline: DeliveryFile | null;
  artifact: DeliveryFile | null;
  current: DeliveryFile | null;
  result: DeliveryFile | null;
  action: 'none' | 'put' | 'remove' | 'conflict';
}
export type DeliveryComparison = {
  entries: DeliveryComparisonEntry[];
} & (
  | { status: 'conflict'; candidate: null }
  | { status: 'matches_artifact' | 'requires_validation'; candidate: DeliveryFile[] }
);
function invalid(): never {
  throw Error('invalid_delivery_manifest');
}

function manifest(input: readonly DeliveryFile[]): Map<string, DeliveryFile> {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > 4096 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid();
  const result = new Map<string, DeliveryFile>();
  let size = 0;
  for (let i = 0; i < input.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    const value: unknown = descriptor.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    const keys = ['path', 'sha256', 'size', 'executable'];
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(value).length !== keys.length ||
      !keys.every((key) => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return field?.enumerable && Object.hasOwn(field, 'value');
      })
    )
      invalid();
    const file = value as DeliveryFile;
    if (
      !isWorkspaceRelativePath(file.path) ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 16 * 1024 * 1024 ||
      typeof file.executable !== 'boolean' ||
      result.has(file.path)
    )
      invalid();
    size += file.size;
    if (size > 256 * 1024 * 1024) invalid();
    result.set(file.path, { ...file });
  }
  for (const path of result.keys()) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      if (result.has(parts.join('/'))) invalid();
      parts.pop();
    }
  }
  return result;
}
const same = (a: DeliveryFile | null, b: DeliveryFile | null) =>
  a === null || b === null
    ? a === b
    : a.sha256 === b.sha256 && a.size === b.size && a.executable === b.executable;

/** B = baseline, A = tested artifact, U = current user contents.
 * A combination different from A always needs fresh validation and approval. */
export function compareLocalDelivery(
  baseline: readonly DeliveryFile[],
  artifact: readonly DeliveryFile[],
  current: readonly DeliveryFile[],
): DeliveryComparison {
  const b = manifest(baseline),
    a = manifest(artifact),
    u = manifest(current);
  const paths = [...new Set([...b.keys(), ...a.keys(), ...u.keys()])].sort();
  if (paths.length > 4096) invalid();
  const entries: DeliveryComparisonEntry[] = [];
  let conflict = false,
    matchesArtifact = true;
  for (const path of paths) {
    const before = b.get(path) ?? null,
      tested = a.get(path) ?? null,
      user = u.get(path) ?? null;
    let result: DeliveryFile | null;
    let action: DeliveryComparisonEntry['action'];
    if (same(tested, before) || same(user, tested)) {
      result = user;
      action = 'none';
    } else if (same(user, before)) {
      result = tested;
      action = tested ? 'put' : 'remove';
    } else {
      result = null;
      action = 'conflict';
      conflict = true;
    }
    if (!same(result, tested)) matchesArtifact = false;
    entries.push({ path, baseline: before, artifact: tested, current: user, result, action });
  }
  if (conflict) return { status: 'conflict', entries, candidate: null };
  const candidate = entries.flatMap((entry) => (entry.result ? [{ ...entry.result }] : []));
  // Disjoint input trees can still produce a file/directory collision when combined.
  const combined = new Set(candidate.map((entry) => entry.path));
  const collisions = new Set<string>();
  for (const path of combined) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      const parent = parts.join('/');
      if (combined.has(parent)) {
        collisions.add(parent);
        collisions.add(path);
      }
      parts.pop();
    }
  }
  if (collisions.size) {
    for (const entry of entries)
      if (collisions.has(entry.path)) {
        entry.action = 'conflict';
        entry.result = null;
      }
    return { status: 'conflict', entries, candidate: null };
  }
  return {
    status: matchesArtifact ? 'matches_artifact' : 'requires_validation',
    entries,
    candidate,
  };
}
