import { describe, expect, it } from 'vitest';
import { completeLocalMergeTree, type DeliveryTree } from '../src/local-tree-comparison';

const f = (path: string, value = 'a') => ({
  path,
  sha256: value.repeat(64),
  size: 1,
  executable: false,
});
const t = (directories: string[], files: DeliveryTree['files'] = []): DeliveryTree => ({
  directories,
  files,
});
describe('complete Git merge contents with independently recorded directory facts', () => {
  it('keeps empty directories while accepting a real merged file different from both sides', () => {
    expect(
      completeLocalMergeTree(
        t(['keep'], [f('code')]),
        t(['keep', 'ours'], [f('code', 'b')]),
        t(['keep', 'theirs'], [f('code', 'c')]),
        [f('code', 'd')],
      ),
    ).toEqual({ kind: 'merged', tree: t(['keep', 'ours', 'theirs'], [f('code', 'd')]) });
  });
  it.each([
    [t(['old']), t([]), t(['old', 'old/new']), [], ['old', 'old/new']],
    [t(['old']), t([]), t([], [f('old')]), [f('old')], ['old']],
    [t([]), t([], [f('node')]), t(['node']), [f('node')], ['node']],
    [t(['old']), t([]), t(['old'], [f('old/new')]), [f('old/new')], ['old', 'old/new']],
  ] as const)(
    'rejects a structural conflict without returning files %#',
    (base, target, source, files, paths) => {
      expect(completeLocalMergeTree(base, target, source, [...files])).toEqual({
        kind: 'conflict',
        paths: [...paths],
      });
    },
  );
  it.each([
    [t(['old']), t([]), t(['old']), [], t([])],
    [
      t([], [f('node')]),
      t(['node', 'node/empty']),
      t([], [f('node')]),
      [],
      t(['node', 'node/empty']),
    ],
    [t(['node']), t([], [f('node')]), t(['node']), [f('node')], t([], [f('node')])],
    [
      t(['before'], [f('before/code')]),
      t(['after'], [f('after/code')]),
      t(['before']),
      [f('after/code')],
      t(['after'], [f('after/code')]),
    ],
  ] as const)(
    'reconciles supported deletion, conversion and directory movement %#',
    (base, target, source, files, expected) => {
      expect(completeLocalMergeTree(base, target, source, [...files])).toEqual({
        kind: 'merged',
        tree: expected,
      });
    },
  );
  it('rejects a Git file incompatible with the selected directory-sensitive node', () => {
    expect(
      completeLocalMergeTree(t(['node']), t([], [f('node')]), t(['node']), [f('node', 'b')]),
    ).toEqual({ kind: 'conflict', paths: ['node'] });
  });
  it.each([t(['.env']), t(['missing/child']), t(['same'], [f('same')]), t([], [f('.git/config')])])(
    'rejects malformed or protected inputs %#',
    (bad) => {
      expect(() => completeLocalMergeTree(bad, t([]), t([]), [])).toThrow('invalid_delivery_tree');
    },
  );
  it('rejects oversized merged contents and path unions', () => {
    const large = Array.from({ length: 17 }, (_, i) => ({ ...f(`f${i}`), size: 16 * 1024 * 1024 }));
    expect(() => completeLocalMergeTree(t([]), t([]), t([]), large)).toThrow();
    const dirs = Array.from({ length: 2048 }, (_, i) => `a${i}`);
    expect(() =>
      completeLocalMergeTree(
        t(dirs),
        t([...dirs, 'extra']),
        t(Array.from({ length: 2048 }, (_, i) => `b${i}`)),
        [],
      ),
    ).toThrow();
  });
});
