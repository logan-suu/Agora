// Fixed pure byte/identity/metadata facts, without authority or OS doubles.
// Native source production, current-root checks and inverse effects are G5.
import { expect, it } from 'vitest';
import { planLocalUndoTree } from '../src/local-undo-tree-plan';
import { localFileVersion } from '../src/local-version-store';

const meta = `33188:501:20:${'a'.repeat(64)}`,
  dm = `16877:501:20:${'a'.repeat(64)}`;
const file = (path: string, content: string, identity: string) => ({
  path,
  metadata: meta,
  content: Buffer.from(content),
  version: localFileVersion({ identity, metadata: meta, content: Buffer.from(content) }),
});
const directory = (path: string, identity: string) => ({ path, identity, metadata: dm });
const source = (candidateName: string, identity: string, metadata: string) => ({
  candidateName,
  identity,
  metadata,
});
it('reverses the actual operation prefix while preserving independent user files and restoring original directories', () => {
  const created = file('new/code', 'A', '1:50'),
    deleted = file('old/code', 'B', '1:10');
  const effects = [
    {
      operation: 'remove' as const,
      path: deleted.path,
      effect: true,
      baseline: deleted,
      preserved: source('delete-file-candidate', '1:10', meta),
    },
    {
      operation: 'rmdir' as const,
      path: 'old',
      effect: true,
      baseline: directory('old', '1:11'),
      preserved: source('delete-dir-candidate', '1:11', dm),
    },
    { operation: 'mkdir' as const, path: 'new', effect: true, installed: directory('new', '1:51') },
    {
      operation: 'put' as const,
      path: created.path,
      effect: true,
      kind: 'create' as const,
      baselineVersion: { kind: 'absent' as const, parentIdentity: '1:51', name: 'code' },
      baselineMetadata: null,
      baseline: Buffer.alloc(0),
      installedVersion: created.version,
      installedMetadata: meta,
      installed: created.content,
    },
  ];
  const current = {
    directories: [directory('', '1:1'), directory('new', '1:51')],
    files: [created, file('user.txt', 'user', '1:99')],
  };
  const result = planLocalUndoTree(effects, current);
  expect(result.kind).toBe('candidate');
  if (result.kind !== 'candidate') throw Error('missing plan');
  expect(result.items.map((i) => i.operation)).toEqual([
    'remove',
    'rmdir',
    'restoreDirectory',
    'restoreFile',
  ]);
  expect(result.candidate.files.map((f) => f.path)).toEqual(['old/code', 'user.txt']);
  expect(result.candidate.files.find((f) => f.path === 'old/code')?.content.toString()).toBe('B');
  expect(result.candidate.files.find((f) => f.path === 'user.txt')?.content.toString()).toBe(
    'user',
  );
  expect(result.candidate.directories.map((d) => d.path)).toEqual(['', 'old']);
  expect(result.items.at(-1)?.expected).toEqual({
    kind: 'absent',
    parentIdentity: '1:11',
    name: 'code',
  });
  const blocked = planLocalUndoTree(effects, {
    ...current,
    files: [...current.files, file('new/user.txt', 'keep', '1:98')],
  });
  expect(blocked).toMatchObject({ kind: 'conflict', path: 'new', reason: 'directory_not_empty' });
});
it('requires original directory identity and never overwrites an occupied deleted path', () => {
  const effect = {
    operation: 'mkdir' as const,
    path: 'new',
    effect: true,
    installed: directory('new', '1:2'),
  };
  expect(
    planLocalUndoTree([effect], {
      directories: [directory('', '1:1'), directory('new', '1:3')],
      files: [],
    }),
  ).toMatchObject({ kind: 'conflict', reason: 'created_object_changed' });
  const deleted = file('file', 'old', '1:10');
  expect(
    planLocalUndoTree(
      [
        {
          operation: 'remove' as const,
          path: 'file',
          effect: true,
          baseline: deleted,
          preserved: source('delete-candidate', '1:10', meta),
        },
      ],
      { directories: [directory('', '1:1')], files: [file('file', 'new', '1:20')] },
    ),
  ).toMatchObject({ kind: 'conflict', reason: 'deleted_path_occupied' });
});
it('rejects a missing parent or a current content/version mismatch before publishing a candidate', () => {
  const current = {
    directories: [directory('', '1:1')],
    files: [file('lost/file', 'bytes', '1:2')],
  };
  expect(() => planLocalUndoTree([], current)).toThrow('undo_tree_invalid');
  const valid = file('file', 'a', '1:2');
  expect(() =>
    planLocalUndoTree([], {
      directories: [directory('', '1:1')],
      files: [{ ...valid, content: Buffer.from('b') }],
    }),
  ).toThrow('undo_tree_invalid');
});
it('preserves excluded descendants when reversing a created directory', () => {
  expect(
    planLocalUndoTree(
      [{ operation: 'mkdir', path: 'new', effect: true, installed: directory('new', '1:2') }],
      {
        directories: [directory('', '1:1'), directory('new', '1:2')],
        files: [],
        protectedPaths: ['new/.env'],
      },
    ),
  ).toMatchObject({ kind: 'conflict', path: 'new', reason: 'protected_path' });
});
