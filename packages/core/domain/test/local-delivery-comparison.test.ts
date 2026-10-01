import { describe, expect, it } from 'vitest';
import { compareLocalDelivery, type DeliveryFile } from '../src/local-delivery-comparison';

const file = (path: string, value: string, executable = false): DeliveryFile => ({
  path,
  sha256: value.repeat(64),
  size: 1,
  executable,
});
const b = file('file.txt', 'b');
const a = file('file.txt', 'a');
const u = file('file.txt', 'c');

describe('local delivery comparison', () => {
  it('applies the tested artifact when the user still has the baseline', () => {
    expect(compareLocalDelivery([b], [a], [b])).toEqual({
      status: 'matches_artifact',
      entries: [{ path: b.path, baseline: b, artifact: a, current: b, result: a, action: 'put' }],
      candidate: [a],
    });
  });
  it('recognizes an already applied artifact without scheduling another write', () => {
    expect(compareLocalDelivery([b], [a], [a]).entries[0]?.action).toBe('none');
  });
  it('preserves a user change in a file untouched by the artifact and requires validation', () => {
    const result = compareLocalDelivery([b], [b], [u]);
    expect(result.status).toBe('requires_validation');
    expect(result.candidate).toEqual([u]);
    expect(result.entries[0]?.action).toBe('none');
  });
  it('does not reuse artifact approval for a combination of disjoint changes', () => {
    const extra = file('user.txt', 'd');
    const result = compareLocalDelivery([b], [a], [b, extra]);
    expect(result.status).toBe('requires_validation');
    expect(result.candidate).toEqual([a, extra]);
  });
  it('preserves all three conflicting versions and supplies no candidate', () => {
    const result = compareLocalDelivery([b], [a], [u]);
    expect(result.status).toBe('conflict');
    expect(result.candidate).toBeNull();
    expect(result.entries).toEqual([
      { path: b.path, baseline: b, artifact: a, current: u, result: null, action: 'conflict' },
    ]);
  });
  it.each([
    { baseline: [], artifact: [a], current: [], action: 'put', candidate: [a] },
    { baseline: [b], artifact: [], current: [b], action: 'remove', candidate: [] },
    { baseline: [b], artifact: [], current: [], action: 'none', candidate: [] },
    { baseline: [], artifact: [a], current: [a], action: 'none', candidate: [a] },
  ])('handles creation or deletion using the same three-way rule: $action', (input) => {
    const result = compareLocalDelivery(input.baseline, input.artifact, input.current);
    expect(result.status).toBe('matches_artifact');
    expect(result.entries[0]?.action).toBe(input.action);
    expect(result.candidate).toEqual(input.candidate);
  });
  it('rejects delete versus modify and independently created contents', () => {
    expect(compareLocalDelivery([b], [], [u]).status).toBe('conflict');
    expect(compareLocalDelivery([], [a], [u]).status).toBe('conflict');
  });
  it('treats executable bits as part of the tested content version', () => {
    const executable = { ...b, executable: true };
    expect(compareLocalDelivery([b], [executable], [b]).candidate).toEqual([executable]);
    expect(compareLocalDelivery([b], [a], [executable]).status).toBe('conflict');
  });
  it('blocks a file/directory collision created by combining disjoint changes', () => {
    const result = compareLocalDelivery([], [file('folder', 'a')], [file('folder/user', 'b')]);
    expect(result.status).toBe('conflict');
    expect(result.candidate).toBeNull();
    expect(result.entries.every((entry) => entry.action === 'conflict')).toBe(true);
  });
  it('returns sorted independent data and handles an empty tree', () => {
    const z = file('z.txt', 'e');
    const result = compareLocalDelivery([], [z, a], []);
    expect(result.candidate).toEqual([a, z]);
    if (result.candidate?.[0]) result.candidate[0].sha256 = 'f'.repeat(64);
    expect(a.sha256).toBe('a'.repeat(64));
    expect(compareLocalDelivery([], [], [])).toEqual({
      status: 'matches_artifact',
      entries: [],
      candidate: [],
    });
  });
  it.each(
    [
      [a, a],
      [{ ...a, path: '../outside' }],
      [{ ...a, sha256: 'bad' }],
      [{ ...a, size: -1 }],
      [{ ...a, secret: 'unexpected' }],
      [Object.create(a)],
      [file('folder', 'a'), file('folder/nested', 'b')],
    ].map((entries) => ({ entries })),
  )('rejects invalid or duplicate manifest entries', ({ entries }) => {
    expect(() => compareLocalDelivery([], entries as DeliveryFile[], [])).toThrow(
      'invalid_delivery_manifest',
    );
  });
  it('rejects accessors without evaluating them', () => {
    let read = false;
    const entry = { ...a };
    Object.defineProperty(entry, 'path', {
      enumerable: true,
      get: () => {
        read = true;
        return 'x';
      },
    });
    expect(() => compareLocalDelivery([], [entry], [])).toThrow('invalid_delivery_manifest');
    expect(read).toBe(false);
  });
  it('does not coerce a non-string hash or read a sparse array', () => {
    let coerced = false;
    const entry = {
      ...a,
      sha256: {
        toString: () => {
          coerced = true;
          return a.sha256;
        },
      },
    };
    expect(() => compareLocalDelivery([], [entry as unknown as DeliveryFile], [])).toThrow(
      'invalid_delivery_manifest',
    );
    expect(coerced).toBe(false);
    expect(() => compareLocalDelivery([], new Array<DeliveryFile>(1), [])).toThrow(
      'invalid_delivery_manifest',
    );
  });
});
