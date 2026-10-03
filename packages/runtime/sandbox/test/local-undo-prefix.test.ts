// Pure evidence bookkeeping; native effects are verified separately.
import { expect, it } from 'vitest';
import { advanceLocalUndoPrefix, assertLocalUndoPrefix } from '../src/local-undo-prefix';
import type { LocalUndoTreeInput, LocalUndoTreeItem } from '../src/local-undo-tree-plan';
import { localFileVersion } from '../src/local-version-store';

const metadata = `420:501:20:${'a'.repeat(64)}`;
const directory = { path: '', identity: '1:2', metadata };
const file = (content: string, identity = '1:3') => {
  const basis = { identity, metadata, content: Buffer.from(content) };
  return { path: 'file.txt', ...basis, version: localFileVersion(basis) };
};
const tree = (): LocalUndoTreeInput => ({ directories: [directory], files: [file('U')] });
const put: LocalUndoTreeItem = {
  sourceIndex: 0,
  operation: 'put',
  path: 'file.txt',
  expected: file('U').version,
  content: Buffer.from('C'),
  metadata,
};
it('accepts only the actual installed identity with the fixed C bytes and metadata', () => {
  const next = advanceLocalUndoPrefix(tree(), put, { file: file('C', '1:4') });
  expect(next.files[0]?.version.identity).toBe('1:4');
  expect(next.files[0]?.content.toString()).toBe('C');
  expect(() => advanceLocalUndoPrefix(tree(), put, { file: file('wrong', '1:4') })).toThrow();
  expect(() => advanceLocalUndoPrefix(tree(), put, {})).toThrow();
  assertLocalUndoPrefix(next, next);
});
it('rejects same bytes at a newer user inode, unlisted files, and directory metadata drift', () => {
  expect(() => assertLocalUndoPrefix(tree(), { ...tree(), files: [file('U', '1:99')] })).toThrow();
  expect(() =>
    assertLocalUndoPrefix(tree(), {
      ...tree(),
      files: [...tree().files, { ...file('new'), path: 'new.txt' }],
    }),
  ).toThrow();
  expect(() =>
    assertLocalUndoPrefix(tree(), {
      ...tree(),
      directories: [{ ...directory, metadata: `448:501:20:${'a'.repeat(64)}` }],
    }),
  ).toThrow();
});
it('keeps unrelated U and excluded names fixed across the proven prefix', () => {
  const original = {
    ...tree(),
    files: [...tree().files, { ...file('user', '1:8'), path: 'other.txt' }],
    protectedPaths: ['.git'],
  };
  const next = advanceLocalUndoPrefix(original, put, { file: file('C', '1:4') });
  expect(next.files[1]?.content.toString()).toBe('user');
  expect(() =>
    assertLocalUndoPrefix(next, { ...next, protectedPaths: ['.git', '.env'] }),
  ).toThrow();
  expect(() =>
    advanceLocalUndoPrefix(original, { ...put, path: '.git' }, { file: file('C') }),
  ).toThrow();
});
it('removes only the exact prior file and never a nonempty directory', () => {
  const remove = { ...put, operation: 'remove' as const, content: null, metadata: null };
  expect(advanceLocalUndoPrefix(tree(), remove, {}).files).toEqual([]);
  expect(() =>
    advanceLocalUndoPrefix(tree(), { ...remove, expected: file('U', '1:99').version }, {}),
  ).toThrow();
  const withDirectory = {
    directories: [directory, { ...directory, path: 'dir', identity: '1:5' }],
    files: [{ ...file('user'), path: 'dir/user.txt' }],
  };
  const targetDirectory = withDirectory.directories[1];
  if (!targetDirectory) throw Error('missing fixture directory');
  expect(() =>
    advanceLocalUndoPrefix(
      withDirectory,
      {
        ...put,
        operation: 'rmdir',
        path: 'dir',
        expected: targetDirectory,
        content: null,
        metadata: null,
      },
      {},
    ),
  ).toThrow();
});
it('restores an absent original directory before its file using proven identities', () => {
  const source = { ...tree(), files: [] };
  const restored = { path: 'dir', identity: '1:5', metadata };
  const dirItem: LocalUndoTreeItem = {
    sourceIndex: 1,
    operation: 'restoreDirectory',
    path: 'dir',
    expected: { kind: 'absent', parentIdentity: '1:2', name: 'dir' },
    content: null,
    metadata,
    restoreFrom: { identity: '1:5', metadata, candidateName: 'old-candidate' },
  };
  const next = advanceLocalUndoPrefix(source, dirItem, { directory: restored });
  const restoredFile = { ...file('B', '1:6'), path: 'dir/file.txt' };
  expect(
    advanceLocalUndoPrefix(
      next,
      {
        ...put,
        operation: 'restoreFile',
        path: restoredFile.path,
        content: Buffer.from('B'),
        expected: { kind: 'absent', parentIdentity: '1:5', name: 'file.txt' },
        restoreFrom: { identity: '1:6', metadata, candidateName: 'file-candidate' },
      },
      { file: restoredFile },
    ).files[0]?.version.identity,
  ).toBe('1:6');
  expect(() => advanceLocalUndoPrefix(next, dirItem, { directory: restored })).toThrow();
});
