import { describe, expect, it } from 'vitest';
import type { DeliveryFile } from '../src/local-delivery-comparison';
import { compareLocalTrees, type DeliveryTree } from '../src/local-tree-comparison';

const file = (path: string, hash = 'a', executable = false): DeliveryFile => ({
  path,
  sha256: hash.repeat(64),
  size: 1,
  executable,
});
const tree = (directories: string[] = [], files: DeliveryFile[] = []): DeliveryTree => ({
  directories,
  files,
});
const empty = tree();
const steps = (b: DeliveryTree, a: DeliveryTree, u = b) => {
  const result = compareLocalTrees(b, a, u);
  expect(result.status).not.toBe('conflict');
  return result.operations?.map(({ op, path }) => `${op}:${path}`);
};

describe('complete local tree reconciliation', () => {
  it('preserves empty directories and creates parents before descendants', () => {
    const a = tree(['z', 'a/b', 'a'], [file('a/b/code')]);
    const result = compareLocalTrees(empty, a, empty);
    expect(result.status).toBe('matches_artifact');
    expect(result.candidate).toEqual(tree(['a', 'a/b', 'z'], [file('a/b/code')]));
    expect(steps(empty, a)).toEqual(['mkdir:a', 'mkdir:z', 'mkdir:a/b', 'put:a/b/code']);
  });
  it('removes files before child-first empty directory removal', () => {
    const b = tree(['a', 'a/b', 'z'], [file('a/b/code'), file('z/file')]);
    expect(steps(b, empty)).toEqual([
      'remove:a/b/code',
      'remove:z/file',
      'rmdir:a/b',
      'rmdir:a',
      'rmdir:z',
    ]);
  });
  it('expands file to directory replacement into independent effects', () => {
    expect(steps(tree([], [file('x')]), tree(['x'], [file('x/y')]))).toEqual([
      'remove:x',
      'mkdir:x',
      'put:x/y',
    ]);
  });
  it('expands directory to file replacement without a recursive delete', () => {
    expect(steps(tree(['x', 'x/empty'], [file('x/y')]), tree([], [file('x', 'b')]))).toEqual([
      'remove:x/y',
      'rmdir:x/empty',
      'rmdir:x',
      'put:x',
    ]);
  });
  it('preserves independent user directories but requires validation of the combination', () => {
    const result = compareLocalTrees(empty, tree(['artifact']), tree(['user/empty', 'user']));
    expect(result.status).toBe('requires_validation');
    expect(result.candidate).toEqual(tree(['artifact', 'user', 'user/empty']));
    expect(result.operations?.map((s) => s.path)).toEqual(['artifact']);
  });
  it('does not resurrect a removed directory to hide a concurrent user addition', () => {
    const result = compareLocalTrees(tree(['x']), empty, tree(['x'], [file('x/new')]));
    expect(result.status).toBe('conflict');
    expect(result.candidate).toBeNull();
    expect(result.operations).toBeNull();
    expect(result.conflicts).toEqual(['x', 'x/new']);
  });
  it('rejects replacing a directory that gained a user descendant', () => {
    expect(
      compareLocalTrees(tree(['x']), tree([], [file('x')]), tree(['x'], [file('x/user')])).status,
    ).toBe('conflict');
  });
  it('rejects a new artifact descendant under a user-replaced ancestor', () => {
    expect(
      compareLocalTrees(tree(['x']), tree(['x'], [file('x/new')]), tree([], [file('x')])).status,
    ).toBe('conflict');
  });
  it('retains current excluded entries without exposing or deleting their parent', () => {
    const b = tree(['x']);
    expect(compareLocalTrees(b, b, b, ['x/.env']).operations).toEqual([]);
    const result = compareLocalTrees(b, empty, b, ['x/.env']);
    expect(result.status).toBe('conflict');
    expect(result.conflicts).toContain('x');
    expect(result.operations).toBeNull();
  });
  it('rejects writes overlapping a protected subtree, but permits siblings', () => {
    expect(
      compareLocalTrees(empty, tree(['cache'], [file('cache/a')]), empty, ['cache']).status,
    ).toBe('conflict');
    expect(compareLocalTrees(empty, tree([], [file('safe')]), empty, ['cache']).status).toBe(
      'matches_artifact',
    );
  });
  it('treats executable mode and content changes as file versions', () => {
    const b = tree([], [file('a')]);
    const a = tree([], [file('a', 'a', true)]);
    expect(steps(b, a)).toEqual(['put:a']);
    expect(compareLocalTrees(b, a, tree([], [file('a', 'b')])).status).toBe('conflict');
  });
  it('replays an already matching artifact without generating another effect', () => {
    const a = tree(['empty', 'x'], [file('x/code')]);
    expect(compareLocalTrees(empty, a, a).operations).toEqual([]);
  });
  it('preserves user deletions where the artifact made no change', () => {
    const b = tree(['x'], [file('x/code')]);
    expect(compareLocalTrees(b, b, empty)).toMatchObject({
      status: 'requires_validation',
      candidate: empty,
      operations: [],
    });
  });
  it('rejects delete versus modify without scheduling unaffected writes', () => {
    const b = tree(['x'], [file('x/code')]);
    const result = compareLocalTrees(
      b,
      tree([], [file('other')]),
      tree(['x'], [file('x/code', 'b')]),
    );
    expect(result.operations).toBeNull();
    expect(result.conflicts).toContain('x/code');
  });
  it('returns deterministic detached data', () => {
    const a = tree(['z', 'x'], [file('z/code'), file('x/code')]);
    const first = compareLocalTrees(empty, a, empty);
    expect(
      compareLocalTrees(empty, tree(['x', 'z'], [file('x/code'), file('z/code')]), empty),
    ).toEqual(first);
    const firstFile = first.candidate?.files[0];
    if (firstFile) firstFile.sha256 = 'f'.repeat(64);
    expect(a.files[1]?.sha256).toBe('a'.repeat(64));
    const put = first.operations?.find((s) => s.op === 'put');
    expect(put?.after?.kind === 'file' && put.after.file.sha256).toBe('a'.repeat(64));
  });
  it.each([
    tree(['x/y']),
    tree(['x', 'x']),
    tree(['x'], [file('x')]),
    tree([], [file('x/y')]),
    tree(['../outside']),
    tree(['']),
    tree(['.git']),
    tree(['.ENV']),
    tree(['.env.\n']),
    tree(['x', 'x/.eNv.local']),
    tree([], [file('.agora-operations')]),
    { ...empty, extra: true },
    {
      directories: [],
      files: [],
      get ignored() {
        throw Error('accessor executed');
      },
    },
  ])('rejects malformed or reserved trees', (bad) => {
    expect(() => compareLocalTrees(empty, bad as DeliveryTree, empty)).toThrow(
      'invalid_delivery_tree',
    );
  });
  it('rejects accessors and sparse arrays before invoking getters', () => {
    let reads = 0;
    const bad = Object.defineProperty({}, 'directories', {
      enumerable: true,
      get() {
        reads++;
        return [];
      },
    });
    Object.defineProperty(bad, 'files', { enumerable: true, value: [] });
    expect(() => compareLocalTrees(empty, bad as DeliveryTree, empty)).toThrow(
      'invalid_delivery_tree',
    );
    expect(() => compareLocalTrees(empty, tree(new Array(1)), empty)).toThrow(
      'invalid_delivery_tree',
    );
    expect(reads).toBe(0);
  });
  it('does not confuse an ordinary name with a reserved prefix', () => {
    expect(compareLocalTrees(empty, tree([], [file('.github')]), empty).status).toBe(
      'matches_artifact',
    );
  });
  it.each([['x/.env'], ['x', 'x'], ['../outside'], ['x', 'x/nested']].map((paths) => ({ paths })))(
    'rejects malformed protected sets',
    ({ paths }) => {
      expect(() => compareLocalTrees(empty, empty, empty, paths)).toThrow('invalid_delivery_tree');
    },
  );
  it('rejects a protected path represented as visible current content', () => {
    const u = tree(['x']);
    expect(() => compareLocalTrees(empty, empty, u, ['x'])).toThrow('invalid_delivery_tree');
  });
  it('orders every valid result of a small tree matrix as legal single-node effects', () => {
    const samples = [
      empty,
      tree([], [file('x')]),
      tree([], [file('x', 'b')]),
      tree(['x']),
      tree(['x'], [file('x/y')]),
      tree(['x', 'x/y']),
      tree(['x', 'x/y'], [file('x/y/z')]),
      tree([], [file('other')]),
    ];
    for (const baseline of samples)
      for (const artifact of samples)
        for (const current of samples) {
          const result = compareLocalTrees(baseline, artifact, current);
          if (result.status === 'conflict') continue;
          const directories = new Set(current.directories);
          const files = new Map(current.files.map((f) => [f.path, f]));
          for (const step of result.operations) {
            const parent = step.path.split('/').slice(0, -1).join('/');
            expect(!parent || directories.has(parent)).toBe(true);
            if (step.op === 'remove') {
              expect(files.has(step.path)).toBe(true);
              files.delete(step.path);
            } else if (step.op === 'rmdir') {
              expect(directories.has(step.path)).toBe(true);
              expect(
                [...directories, ...files.keys()].some((p) => p.startsWith(`${step.path}/`)),
              ).toBe(false);
              directories.delete(step.path);
            } else if (step.op === 'mkdir') {
              expect(files.has(step.path) || directories.has(step.path)).toBe(false);
              directories.add(step.path);
            } else {
              expect(directories.has(step.path)).toBe(false);
              if (step.after?.kind !== 'file') throw Error('missing resulting file');
              expect(step.before === null).toBe(!files.has(step.path));
              files.set(step.path, step.after.file);
            }
          }
          expect([...directories].sort()).toEqual(result.candidate.directories);
          expect([...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual(
            result.candidate.files,
          );
        }
  });
  it('enforces the combined file and directory bound', () => {
    const dirs = Array.from({ length: 4096 }, (_, i) => `d${i}`);
    expect(compareLocalTrees(empty, tree(dirs), empty).operations).toHaveLength(4096);
    expect(() => compareLocalTrees(empty, tree(dirs, [file('extra')]), empty)).toThrow(
      'invalid_delivery_tree',
    );
    expect(() => compareLocalTrees(empty, tree(dirs), tree(['extra']))).toThrow(
      'invalid_delivery_tree',
    );
  });
  it('rejects a disjoint combination exceeding the aggregate byte bound', () => {
    const group = (prefix: string) =>
      Array.from({ length: 16 }, (_, i) => ({
        ...file(`${prefix}${i}`),
        size: 16 * 1024 * 1024,
      }));
    expect(() => compareLocalTrees(empty, tree([], group('a')), tree([], group('u')))).toThrow(
      'invalid_delivery_tree',
    );
  });
});
