// Real Seatbelt-confined native transactions; no mocks or replacement filesystem.
import { expect, it } from 'vitest';
import { exerciseLocalTransaction } from './local-transaction-fixture';

it('enumerates a pinned directory without following links or reading excluded content', async () => {
  const result = await exerciseLocalTransaction('directory-list');
  expect(result.directoryEntries).toMatchObject({
    entries: [
      { name: '.agora-operations', kind: 'excluded' },
      { name: '.env', kind: 'excluded' },
      { name: 'external-link', kind: 'unsupported' },
      { name: 'moving', kind: 'directory' },
    ],
  });
  expect(result.directoryLinkError).toBe('root_identity_changed');
  expect(result.sentinel).toBe('external-secret');
});

for (const scenario of ['binary', 'binary-replay', 'binary-input-mutation'] as const) {
  it(`preserves exact binary bytes and snapshots inputs before admission: ${scenario}`, async () => {
    const result = await exerciseLocalTransaction(scenario);
    expect(result.receipt.stage).toBe('applied');
    expect(result.receipt.exchanged).toBe(true);
    expect(result.receipt.quiescent).toBe(true);
    expect(result.targetHex).toBe('ff00812a0a');
    expect(result.candidateHex).toBe(result.targetHex);
    expect(result.preservedHex).toBe('00ff800a002a');
    expect(result.baselineHex).toBe(result.preservedHex);
    if (scenario === 'binary-replay') expect(result.replayedReceipt).toEqual(result.receipt);
  });
}

it('durably preserves the baseline and exchanged inode before reporting applied', async () => {
  const result = await exerciseLocalTransaction('normal');
  expect(result.receipt.stage).toBe('applied');
  expect(result.receipt.quiescent).toBe(true);
  expect(result.target).toBe('replacement');
  expect(result.preserved).toBe('original');
  expect(result.sentinel).toBe('external-secret');
  expect(result.journalStages).toEqual(['prepared', 'applied']);
  expect(result.metadataPreserved).toBe(true);
}, 30_000);

for (const scenario of [
  'move-root-before-write',
  'move-parent-before-swap',
  'replace-root',
] as const) {
  it(`closes the operation without touching source or external objects: ${scenario}`, async () => {
    const result = await exerciseLocalTransaction(scenario);
    expect(result.receipt.stage).toBe('recoveryRequired');
    expect(result.receipt.reason).toBe('root_identity_changed');
    expect(result.receipt.quiescent).toBe(true);
    expect(result.target).toBe('original');
    expect(result.sentinel).toBe('external-secret');
    expect(result.receipt.exchanged).toBe(false);
  }, 30_000);
}

it('invalidates a completed exchange after root movement without undoing the actual result', async () => {
  const result = await exerciseLocalTransaction('move-root-after-swap');
  expect(result.receipt.stage).toBe('recoveryRequired');
  expect(result.receipt.exchanged).toBe(true);
  expect(result.receipt.quiescent).toBe(true);
  expect(result.target).toBe('replacement');
  expect(result.preserved).toBe('original');
  expect(result.sentinel).toBe('external-secret');
}, 30_000);

it('preserves a competing user edit and refuses a stale baseline', async () => {
  const result = await exerciseLocalTransaction('edit-before-swap');
  expect(result.receipt.stage).toBe('conflict');
  expect(result.receipt.reason).toBe('file_version_conflict');
  expect(result.target).toBe('user-edit');
  expect(result.receipt.exchanged).toBe(false);
  expect(result.sentinel).toBe('external-secret');
}, 30_000);

for (const scenario of ['symlink-target', 'hardlink-target'] as const) {
  it(`refuses linked external objects: ${scenario}`, async () => {
    const result = await exerciseLocalTransaction(scenario);
    expect(result.receipt.stage).not.toBe('applied');
    expect(result.receipt.exchanged).toBe(false);
    expect(result.sentinel).toBe('external-secret');
  }, 30_000);
}

it('does not repeat a filesystem mutation when replaying an identical action', async () => {
  const result = await exerciseLocalTransaction('replay');
  expect(result.receipt.stage).toBe('applied');
  expect(result.replayedReceipt).toEqual(result.receipt);
  expect(result.journalStages).toEqual(['prepared', 'applied']);
  expect(result.target).toBe('replacement');
}, 30_000);

it('checks root identity after the final asynchronous authorization check', async () => {
  const result = await exerciseLocalTransaction('move-root-completion');
  expect(result.receipt.stage).toBe('recoveryRequired');
  expect(result.receipt.reason).toBe('root_identity_changed');
  expect(result.receipt.exchanged).toBe(true);
  expect(result.target).toBe('replacement');
  expect(result.preserved).toBe('original');
}, 30_000);

it('also invalidates a parent moved during completion authorization', async () => {
  const result = await exerciseLocalTransaction('move-parent-completion');
  expect(result.receipt.stage).toBe('recoveryRequired');
  expect(result.receipt.reason).toBe('root_identity_changed');
  expect(result.target).toBe('replacement');
  expect(result.preserved).toBe('original');
}, 30_000);

it('refuses a metadata-only edit after the baseline read', async () => {
  const result = await exerciseLocalTransaction('metadata-before-swap');
  expect(result.receipt.stage).toBe('conflict');
  expect(result.receipt.reason).toBe('file_version_conflict');
  expect(result.receipt.exchanged).toBe(false);
  expect(result.target).toBe('original');
}, 30_000);

for (const scenario of ['revoke-before-write', 'revoke-before-swap'] as const) {
  it(`honors trusted authorization closure: ${scenario}`, async () => {
    const result = await exerciseLocalTransaction(scenario);
    expect(result.receipt.stage).toBe('recoveryRequired');
    expect(result.receipt.reason).toBe('authorization_closed');
    expect(result.receipt.quiescent).toBe(true);
    expect(result.receipt.exchanged).toBe(false);
    expect(result.target).toBe('original');
    expect(result.sentinel).toBe('external-secret');
  }, 30_000);
}

for (const scenario of [
  'replay-different-input',
  'replay-corrupt-receipt',
  'replay-missing-receipt',
] as const) {
  it(`refuses unsafe journal replay: ${scenario}`, async () => {
    const result = await exerciseLocalTransaction(scenario);
    expect(result.replayError).toBe(
      scenario === 'replay-different-input' ? 'operation_conflict' : 'recovery_required',
    );
    expect(result.target).toBe('replacement');
    expect(result.preserved).toBe('original');
  }, 30_000);
}
