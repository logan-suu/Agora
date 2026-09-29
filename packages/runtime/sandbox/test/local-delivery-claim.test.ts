// Pure codec fixtures; no filesystem or runtime authorization is mocked.
import { assertLocalExecutionState, createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { assertLocalRegistryTransition, parseLocalRegistry } from '../src/local-registry-records';
import { linkedRegistryFixture } from './local-linked-registry-fixture';

function fixture() {
  const original = linkedRegistryFixture();
  const workspace = {
    schemaVersion: 'workspace-v1',
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'delivery',
    rootId: 'source',
    grantId: 'grant',
    purpose: 'delivery',
    mode: 'direct',
    baselineManifestId: 'manifest:target',
  };
  const claim = {
    kind: 'delivery',
    claimId: 'claim-delivery',
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'delivery',
    writerEpoch: 5,
    createdActionId: 'apply',
    status: 'active',
    closureReceiptId: null,
    deliveryProposalId: 'proposal:fixed',
    inputHash: 'b'.repeat(64),
    grantRevision: 0,
  };
  return {
    ...original,
    workspaces: [...original.workspaces, workspace],
    claims: [...original.claims, claim],
  };
}
it('keeps a delivery control claim distinct from model and integration writers', () => {
  const value = fixture();
  expect(parseLocalRegistry(value)).toEqual(value);
  expect(value.claims.at(-1)).not.toHaveProperty('workerId');
});
it.each([
  { workerId: 'fake' },
  { integrationId: 'fake' },
  { inputHash: 'bad' },
  { grantRevision: -1 },
  { deliveryProposalId: '' },
  { workspaceId: 'one' },
  { kind: 'integration' },
  { kind: 'worker' },
])('rejects malformed delivery or confused authority %j', (patch) => {
  const value = fixture();
  Object.assign(value.claims.at(-1) as object, patch);
  expect(() => parseLocalRegistry(value)).toThrow();
});
it('rejects model claims on delivery workspaces and duplicate physical ownership', () => {
  const value = fixture();
  const claim = value.claims.at(-1);
  if (!claim) throw Error('fixture');
  value.claims.push({ ...claim, claimId: 'another', writerEpoch: 6 });
  expect(() => parseLocalRegistry(value)).toThrow();
  const forged = fixture();
  const first = forged.claims[0];
  if (!first) throw Error('fixture');
  forged.claims = [{ ...first, workspaceId: 'delivery' }];
  expect(() => parseLocalRegistry(forged)).toThrow();
});
it('freezes proposal identity and never revives a released delivery claim', () => {
  const before = fixture();
  const released = structuredClone(before);
  released.revision++;
  Object.assign(released.claims.at(-1) as object, {
    status: 'released',
    closureReceiptId: 'closed',
  });
  expect(() => assertLocalRegistryTransition(before, released)).not.toThrow();
  for (const patch of [
    { deliveryProposalId: 'other' },
    { inputHash: 'c'.repeat(64) },
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

it('never admits a model binding to a delivery workspace', () => {
  const registry = parseLocalRegistry(fixture());
  const workspace = registry.workspaces.find((w) => w.purpose === 'delivery');
  if (!workspace) throw Error('fixture');
  const state = createInitialAppState('task', 'fixed', 'project');
  state.workers = [
    { workerId: 'reader', role: 'REVIEWER', executor: 'harness', status: 'done', startedTs: 0 },
  ];
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['source'],
    workspaces: [workspace],
    bindings: [{ workerId: 'reader', workspaceId: workspace.workspaceId, receiptId: 'binding' }],
    receipts: [
      { receiptId: 'binding', actionId: 'bind', inputHash: 'a'.repeat(64), registryRevision: 1 },
    ],
  };
  expect(() => assertLocalExecutionState(state)).toThrow('invalid_local_worker_binding');
});
