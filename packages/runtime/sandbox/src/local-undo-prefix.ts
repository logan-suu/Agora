/** Exact remaining U plus the actual installed C prefix. The caller must
 * authenticate native effects before supplying an installed object here. */
import { localRecordHash } from './local-registry-records';
import {
  type LocalUndoTreeInput,
  type LocalUndoTreeItem,
  planLocalUndoTree,
} from './local-undo-tree-plan';

const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const parent = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const order = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function clone(input: LocalUndoTreeInput): LocalUndoTreeInput {
  planLocalUndoTree([], input);
  return {
    directories: input.directories
      .map(({ path, identity, metadata }) => ({ path, identity, metadata }))
      .sort(order),
    files: input.files
      .map((f) => ({
        path: f.path,
        metadata: f.metadata,
        version: { ...f.version },
        content: Buffer.from(f.content),
      }))
      .sort(order),
    protectedPaths: [...(input.protectedPaths ?? [])].sort(),
  };
}
function fail(): never {
  throw Error('undo_prefix_conflict');
}
export function assertLocalUndoPrefix(expected: LocalUndoTreeInput, observed: LocalUndoTreeInput) {
  const encoded = (input: LocalUndoTreeInput) => {
    const tree = clone(input);
    return {
      ...tree,
      files: tree.files.map(({ content, ...file }) => ({
        ...file,
        content: content.toString('base64'),
      })),
    };
  };
  if (!same(encoded(expected), encoded(observed))) fail();
}
export function advanceLocalUndoPrefix(
  previous: LocalUndoTreeInput,
  item: LocalUndoTreeItem,
  installed: {
    file?: LocalUndoTreeInput['files'][number];
    directory?: LocalUndoTreeInput['directories'][number];
  },
): LocalUndoTreeInput {
  const next = clone(previous);
  if (item.operation === 'none') {
    if (Object.keys(installed).length) fail();
    return next;
  }
  if (
    next.protectedPaths?.some(
      (p) => p === item.path || p.startsWith(`${item.path}/`) || item.path.startsWith(`${p}/`),
    )
  )
    fail();
  const directory = next.directories.find((d) => d.path === item.path),
    file = next.files.find((f) => f.path === item.path),
    ancestor = next.directories.find((d) => d.path === parent(item.path));
  if (!ancestor || !item.expected) fail();
  if (item.operation === 'rmdir') {
    if (
      !directory ||
      file ||
      !('identity' in item.expected) ||
      directory.identity !== item.expected.identity ||
      !('metadata' in item.expected) ||
      directory.metadata !== item.expected.metadata ||
      next.files.some((f) => f.path.startsWith(`${item.path}/`)) ||
      next.directories.some((d) => d.path.startsWith(`${item.path}/`)) ||
      Object.keys(installed).length
    )
      fail();
    next.directories = next.directories.filter((d) => d.path !== item.path);
  } else if (item.operation === 'remove') {
    if (!file || directory || !same(file.version, item.expected) || Object.keys(installed).length)
      fail();
    next.files = next.files.filter((f) => f.path !== item.path);
  } else if (item.operation === 'put') {
    if (!file || directory || !same(file.version, item.expected)) fail();
    const actual = installed.file;
    if (
      !actual ||
      installed.directory ||
      actual.path !== item.path ||
      !item.content ||
      !actual.content.equals(item.content) ||
      actual.metadata !== item.metadata
    )
      fail();
    next.files = next.files.map((f) => (f.path === item.path ? actual : f));
  } else {
    if (
      file ||
      directory ||
      !('kind' in item.expected) ||
      item.expected.kind !== 'absent' ||
      item.expected.parentIdentity !== ancestor.identity ||
      item.expected.name !== item.path.split('/').at(-1) ||
      !item.restoreFrom
    )
      fail();
    if (item.operation === 'restoreDirectory') {
      const actual = installed.directory;
      if (
        !actual ||
        installed.file ||
        actual.path !== item.path ||
        actual.identity !== item.restoreFrom.identity ||
        actual.metadata !== item.restoreFrom.metadata ||
        actual.metadata !== item.metadata
      )
        fail();
      next.directories.push(actual);
    } else if (item.operation === 'restoreFile') {
      const actual = installed.file;
      if (
        !actual ||
        installed.directory ||
        actual.path !== item.path ||
        !item.content ||
        !actual.content.equals(item.content) ||
        actual.version.identity !== item.restoreFrom.identity ||
        actual.metadata !== item.restoreFrom.metadata ||
        actual.metadata !== item.metadata
      )
        fail();
      next.files.push(actual);
    } else fail();
  }
  return clone(next);
}
