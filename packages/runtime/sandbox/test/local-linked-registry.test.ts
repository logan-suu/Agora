// Pure record fixtures exercise the production codec; no filesystem authority is mocked.
import { describe, expect, it } from 'vitest';
import { assertLocalRegistryTransition, parseLocalRegistry } from '../src/local-registry-records';
import {
  linkedRegistryFixture as fixture,
  linkedPhysicalFixture as physical,
} from './local-linked-registry-fixture';

function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (!value) throw Error('missing fixture');
  return value;
}
describe('linked-worktree registry boundaries', () => {
  it('keeps independent coder and writable tester claims under the original grant', () => {
    const value = fixture();
    expect(parseLocalRegistry(value)).toEqual(value);
    expect(value.roots).toHaveLength(1);
    expect(value.grants).toHaveLength(1);
  });
  it('rejects linked references without physical binding evidence', () => {
    const { linkedRoots: _, ...value } = fixture();
    value.claims = [];
    expect(() => parseLocalRegistry(value)).toThrow('invalid_local_registry_records');
  });
  it.each(['projectId', 'taskId', 'rootId', 'grantId', 'bindingReceiptId'])(
    'rejects borrowed %s',
    (field) => {
      const value = fixture();
      Object.assign(at(value.linkedRoots, 0), { [field]: 'other' });
      expect(() => parseLocalRegistry(value)).toThrow('invalid_local_registry_records');
    },
  );
  it('rejects a source root disguised as a private worktree', () => {
    const value = fixture();
    Object.assign(at(value.linkedRoots, 0), physical('/source', '2'));
    expect(() => parseLocalRegistry(value)).toThrow();
  });
  it('rejects aliases, nested worktrees and mismatched staging volumes', () => {
    for (const change of [
      (v: ReturnType<typeof fixture>) =>
        Object.assign(at(v.linkedRoots, 1), physical('/alias', '10')),
      (v: ReturnType<typeof fixture>) =>
        Object.assign(at(v.linkedRoots, 1), {
          ...physical('/initial/nested', '20'),
          chain: [...at(v.linkedRoots, 0).chain, { path: '/initial/nested', identity: '1:20' }],
        }),
      (v: ReturnType<typeof fixture>) => {
        at(v.linkedRoots, 1).staging.identity = '2:21';
      },
    ]) {
      const value = fixture();
      change(value);
      expect(() => parseLocalRegistry(value)).toThrow();
    }
  });
  it('rejects invalid common-dir identity and metadata outside its control domain', () => {
    const badId = fixture();
    at(badId.linkedRoots, 0).commonDir.id = 'unproven';
    expect(() => parseLocalRegistry(badId)).toThrow();
    const badMeta = fixture();
    at(badMeta.linkedRoots, 0).metadata.path = '/foreign/worktrees/one';
    expect(() => parseLocalRegistry(badMeta)).toThrow();
  });
  it('requires separate native initialization and Git creation evidence', () => {
    const missing = fixture();
    Object.assign(at(missing.linkedRoots, 0), { initialization: null });
    expect(() => parseLocalRegistry(missing)).toThrow();
    const reused = fixture();
    at(reused.linkedRoots, 1).creation = at(reused.linkedRoots, 0).creation;
    expect(() => parseLocalRegistry(reused)).toThrow();
  });
  it('rejects multiple claims for the same physical worktree', () => {
    const value = fixture();
    value.claims.push({
      ...at(value.claims, 0),
      claimId: 'another',
      workerId: 'other',
      writerEpoch: 4,
    });
    expect(() => parseLocalRegistry(value)).toThrow();
  });
  it('preserves all published physical bindings across registry revisions', () => {
    const before = fixture();
    expect(() => assertLocalRegistryTransition(before, { ...before, revision: 5 })).not.toThrow();
    const after = structuredClone(before);
    after.revision++;
    at(after.linkedRoots, 0).creation.receiptHash = 'f'.repeat(64);
    expect(() => assertLocalRegistryTransition(before, after)).toThrow();
  });
});
