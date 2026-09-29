// Pure record fixtures exercise the production codec; no runtime authority is mocked.
import { expect, it } from 'vitest';
import { assertLocalRegistryTransition, parseLocalRegistry } from '../src/local-registry-records';
import { linkedRegistryFixture } from './local-linked-registry-fixture';

function fixture() {
  const value = linkedRegistryFixture();
  const worker = value.claims.find((c) => c.workspaceId === 'one');
  if (!worker) throw Error('missing worker');
  const { workerId: _, ...base } = worker;
  const integration = {
    ...base,
    claimId: 'integration-claim',
    workspaceId: 'initial',
    kind: 'integration',
    integrationId: 'integration',
    waveId: 'wave',
    planHash: 'a'.repeat(64),
    grantRevision: 0,
    writerEpoch: 4,
  };
  return {
    ...value,
    claims: [...value.claims.filter((c) => c.workspaceId !== 'initial'), integration],
  };
}
it('keeps a distinct integration writer beside worker claims', () => {
  const value = fixture();
  expect(parseLocalRegistry(value)).toEqual(value);
  expect(value.claims.at(-1)).not.toHaveProperty('workerId');
});
it.each(['kind', 'integrationId', 'waveId', 'planHash', 'grantRevision'])(
  'requires the complete integration identity: %s',
  (field) => {
    const value = fixture();
    Reflect.deleteProperty(value.claims.at(-1) as object, field);
    expect(() => parseLocalRegistry(value)).toThrow('invalid_local_registry_records');
  },
);
it.each([
  { workerId: 'fake' },
  { kind: 'worker' },
  { planHash: 'unknown' },
  { grantRevision: -1 },
  { grantRevision: Number.MAX_SAFE_INTEGER + 1 },
  { workspaceId: 'one' },
  { taskId: 'other' },
  { writerEpoch: Number.MAX_SAFE_INTEGER + 1 },
])('rejects invalid or mixed control identity: %j', (patch) => {
  const value = fixture();
  Object.assign(value.claims.at(-1) as object, patch);
  expect(() => parseLocalRegistry(value)).toThrow('invalid_local_registry_records');
});
it('rejects disguising integration as an ordinary worker', () => {
  const value = fixture();
  const existing = value.claims[0];
  if (!existing) throw Error('missing claim');
  value.claims = [{ ...existing, workspaceId: 'initial' }];
  expect(() => parseLocalRegistry(value)).toThrow('invalid_local_registry_records');
});
it('shares physical conflict checks with workers and other integration claims', () => {
  const value = fixture();
  const claim = value.claims.at(-1);
  if (!claim) throw Error('missing claim');
  value.claims.push({ ...claim, claimId: 'other', writerEpoch: 5 });
  expect(() => parseLocalRegistry(value)).toThrow('invalid_local_registry_records');
});
it('freezes the plan identity and never revives a released integration writer', () => {
  const before = fixture();
  const released = structuredClone(before);
  released.revision++;
  Object.assign(released.claims.at(-1) as object, {
    status: 'released',
    closureReceiptId: 'closure',
  });
  expect(() => assertLocalRegistryTransition(before, released)).not.toThrow();
  for (const patch of [
    { planHash: 'b'.repeat(64) },
    { integrationId: 'other' },
    { waveId: 'other' },
    { grantRevision: 1 },
  ]) {
    const changed = structuredClone(before);
    changed.revision++;
    Object.assign(changed.claims.at(-1) as object, patch);
    expect(() => assertLocalRegistryTransition(before, changed)).toThrow();
  }
  const revived = structuredClone(released);
  revived.revision++;
  Object.assign(revived.claims.at(-1) as object, { status: 'active', closureReceiptId: null });
  expect(() => assertLocalRegistryTransition(released, revived)).toThrow();
});
