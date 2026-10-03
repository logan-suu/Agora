/** Pure bounded inverse plan over proved original effects and full current U.
 * Candidate metadata/bytes are fixed; uninstalled identities are never invented. */
import { type FileVersionV1, isFileVersionV1, isWorkspaceRelativePath } from '@agora/core-domain';
import type { EmptyDirectoryBasis, LocalRestorationSource } from './local-file-transaction';
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';
import { type LocalUndoFileEffect, planLocalUndoFile } from './local-undo-file-plan';
import { localFileVersion } from './local-version-store';

type Regular = Extract<FileVersionV1, { kind: 'regular' }>;
export type LocalUndoTreeFile = {
  path: string;
  version: Regular;
  metadata: string;
  content: Buffer;
};
export type LocalUndoTreeDirectory = EmptyDirectoryBasis & { path: string };
export type LocalUndoTreeEffect =
  | (LocalUndoFileEffect & { operation: 'put' })
  | {
      operation: 'remove';
      path: string;
      effect: boolean;
      baseline: LocalUndoTreeFile;
      preserved: LocalRestorationSource;
    }
  | { operation: 'mkdir'; path: string; effect: boolean; installed: LocalUndoTreeDirectory | null }
  | {
      operation: 'rmdir';
      path: string;
      effect: boolean;
      baseline: LocalUndoTreeDirectory;
      preserved: LocalRestorationSource;
    };
export type LocalUndoTreeInput = {
  directories: LocalUndoTreeDirectory[];
  files: LocalUndoTreeFile[];
  protectedPaths?: string[];
};
export type LocalUndoTreeItem = {
  sourceIndex: number;
  path: string;
  operation: 'put' | 'remove' | 'rmdir' | 'restoreFile' | 'restoreDirectory' | 'none';
  expected: FileVersionV1 | EmptyDirectoryBasis | null;
  content: Buffer | null;
  metadata: string | null;
  mode?: number;
  restoreFrom?: LocalRestorationSource;
};
export type LocalUndoTreePlan =
  | {
      kind: 'candidate';
      items: LocalUndoTreeItem[];
      candidate: {
        directories: { path: string; metadata: string }[];
        files: { path: string; content: Buffer; metadata: string }[];
      };
    }
  | { kind: 'conflict'; path: string; reason: string };
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const validPath = (path: string) =>
  isWorkspaceRelativePath(path) && !path.split('/').some(isLocalReservedName);
const parent = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const metadata = (value: unknown) =>
  typeof value === 'string' && /^\d+:\d+:\d+:[a-f0-9]{64}$/.test(value);
function directory(value: EmptyDirectoryBasis | null) {
  return !!value && /^\d+:\d+$/.test(value.identity) && metadata(value.metadata);
}
function file(value: LocalUndoTreeFile) {
  return (
    !!value &&
    validPath(value.path) &&
    isFileVersionV1(value.version) &&
    value.version.kind === 'regular' &&
    Buffer.isBuffer(value.content) &&
    value.content.length <= 16 * 1024 * 1024 &&
    metadata(value.metadata) &&
    same(
      value.version,
      localFileVersion({
        identity: value.version.identity,
        metadata: value.metadata,
        content: value.content,
      }),
    )
  );
}
function source(value: LocalRestorationSource, basis: EmptyDirectoryBasis) {
  return (
    !!value &&
    /^[A-Za-z0-9_-]{1,80}-candidate$/.test(value.candidateName) &&
    value.identity === basis.identity &&
    value.metadata === basis.metadata
  );
}
function fail(): never {
  throw Error('undo_tree_invalid');
}
export function planLocalUndoTree(
  effects: LocalUndoTreeEffect[],
  input: LocalUndoTreeInput,
): LocalUndoTreePlan {
  if (
    !Array.isArray(effects) ||
    effects.length > 4096 ||
    !Array.isArray(input.directories) ||
    !Array.isArray(input.files) ||
    input.directories.length + input.files.length > 4096
  )
    fail();
  if (
    input.protectedPaths &&
    (!Array.isArray(input.protectedPaths) ||
      new Set(input.protectedPaths).size !== input.protectedPaths.length ||
      input.protectedPaths.some((p) => !isWorkspaceRelativePath(p)))
  )
    fail();
  const directories = new Map<string, LocalUndoTreeDirectory>();
  const files = new Map<
    string,
    { path: string; version: Regular | null; metadata: string; content: Buffer }
  >();
  let bytes = 0;
  for (const d of input.directories) {
    if ((d.path !== '' && !validPath(d.path)) || !directory(d) || directories.has(d.path)) fail();
    directories.set(d.path, { ...d });
  }
  if (!directories.has('')) fail();
  for (const f of input.files) {
    if (!file(f) || files.has(f.path) || directories.has(f.path)) fail();
    bytes += f.content.length;
    if (bytes > 256 * 1024 * 1024) fail();
    files.set(f.path, {
      ...f,
      version: structuredClone(f.version),
      content: Buffer.from(f.content),
    });
  }
  for (const path of [...directories.keys(), ...files.keys()])
    if (path !== '' && !directories.has(parent(path))) fail();
  const items: LocalUndoTreeItem[] = [];
  const conflict = (path: string, reason: string): LocalUndoTreePlan => ({
    kind: 'conflict',
    path,
    reason,
  });
  for (let index = effects.length - 1; index >= 0; index--) {
    const effect = effects[index];
    if (
      !effect ||
      !validPath(effect.path) ||
      typeof effect.effect !== 'boolean' ||
      !['put', 'remove', 'mkdir', 'rmdir'].includes(effect.operation)
    )
      fail();
    const path = effect.path,
      current = files.get(path),
      dir = directories.get(path),
      ancestor = directories.get(parent(path));
    const item: LocalUndoTreeItem = {
      sourceIndex: index,
      path,
      operation: 'none',
      expected: null,
      content: null,
      metadata: null,
    };
    if (!effect.effect) {
      items.push(item);
      continue;
    }
    if (
      input.protectedPaths?.some(
        (p) => p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`),
      )
    )
      return conflict(path, 'protected_path');
    if (effect.operation === 'put') {
      if (dir) return conflict(path, 'object_type_changed');
      if (current && !current.version) fail();
      if (!ancestor) {
        if (effect.kind === 'create' && !current) {
          items.push(item);
          continue;
        }
        return conflict(path, 'parent_missing');
      }
      const observed = current
        ? {
            kind: 'regular' as const,
            version: current.version as Regular,
            metadata: current.metadata,
            content: current.content,
          }
        : {
            kind: 'absent' as const,
            version: {
              kind: 'absent' as const,
              parentIdentity: ancestor.identity,
              name: path.split('/').at(-1) as string,
            },
          };
      const plan = planLocalUndoFile(effect, observed);
      if (plan.kind === 'conflict') return conflict(path, plan.reason);
      item.operation = plan.operation;
      item.expected = plan.expected;
      item.content = plan.content;
      item.metadata = plan.metadata;
      if (plan.mode !== undefined) item.mode = plan.mode;
      if (plan.operation === 'remove') files.delete(path);
      if (plan.operation === 'put') {
        if (!plan.content || !plan.metadata) fail();
        files.set(path, {
          path,
          version: null,
          metadata: plan.metadata,
          content: Buffer.from(plan.content),
        });
      }
    } else if (effect.operation === 'mkdir') {
      if (!effect.installed || !directory(effect.installed) || effect.installed.path !== path)
        fail();
      if (current) return conflict(path, 'object_type_changed');
      if (dir) {
        if (
          dir.identity !== effect.installed.identity ||
          dir.metadata !== effect.installed.metadata
        )
          return conflict(path, 'created_object_changed');
        if ([...directories.keys(), ...files.keys()].some((p) => p.startsWith(`${path}/`)))
          return conflict(path, 'directory_not_empty');
        item.operation = 'rmdir';
        item.expected = { identity: dir.identity, metadata: dir.metadata };
        item.metadata = dir.metadata;
        directories.delete(path);
      }
    } else {
      if (current || dir) return conflict(path, 'deleted_path_occupied');
      if (!ancestor) return conflict(path, 'parent_missing');
      item.expected = {
        kind: 'absent',
        parentIdentity: ancestor.identity,
        name: path.split('/').at(-1) as string,
      };
      item.restoreFrom = structuredClone(effect.preserved);
      if (effect.operation === 'remove') {
        if (
          !file(effect.baseline) ||
          effect.baseline.path !== path ||
          !source(effect.preserved, {
            identity: effect.baseline.version.identity,
            metadata: effect.baseline.metadata,
          })
        )
          fail();
        item.operation = 'restoreFile';
        item.metadata = effect.baseline.metadata;
        item.content = Buffer.from(effect.baseline.content);
        files.set(path, {
          ...effect.baseline,
          version: structuredClone(effect.baseline.version),
          content: Buffer.from(effect.baseline.content),
        });
      } else {
        if (
          !directory(effect.baseline) ||
          effect.baseline.path !== path ||
          !source(effect.preserved, effect.baseline)
        )
          fail();
        item.operation = 'restoreDirectory';
        item.metadata = effect.baseline.metadata;
        directories.set(path, { ...effect.baseline });
      }
    }
    items.push(item);
  }
  const order = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  if (
    directories.size + files.size > 4096 ||
    [...files.values()].reduce((n, f) => n + f.content.length, 0) > 256 * 1024 * 1024
  )
    fail();
  return {
    kind: 'candidate',
    items,
    candidate: {
      directories: [...directories.values()]
        .map(({ path, metadata }) => ({ path, metadata }))
        .sort(order),
      files: [...files.values()]
        .map(({ path, metadata, content }) => ({ path, metadata, content: Buffer.from(content) }))
        .sort(order),
    },
  };
}
