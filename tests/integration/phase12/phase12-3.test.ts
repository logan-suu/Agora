// Real APFS operations and a Seatbelt-confined native process; no test doubles.
// This feasibility gate precedes the production workspace/MCP implementation.
import { expect, it } from 'vitest';
import { probeLocalFileBoundary } from './local-boundary-fixture';

it('preserves both versions in a normal confined APFS exchange', async () => {
  const result = await probeLocalFileBoundary('stationary');
  expect(result.filesystem).toBe('apfs');
  expect(result.ready).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(result.target).toBe('candidate');
  expect(result.backup).toBe('original');
}, 30_000);

it('refuses an exchange after the opened parent moves outside the authorized root', async () => {
  const result = await probeLocalFileBoundary('move-parent');
  expect(result.ready).toBe(true);
  expect(result.target).toBe('original');
  expect(result.backup).toBe('candidate');
  expect(result.exitCode).not.toBe(0);
}, 30_000);

it('refuses an exchange after the opened root moves away from its authorized path', async () => {
  const result = await probeLocalFileBoundary('move-root');
  expect(result.ready).toBe(true);
  expect(result.target).toBe('original');
  expect(result.backup).toBe('candidate');
  expect(result.exitCode).not.toBe(0);
}, 30_000);

it('can prepare a transaction file through an opened handle inside the authorized root', async () => {
  const result = await probeLocalFileBoundary('stationary', 'write-open-file');
  expect(result.ready).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(result.backup).toBe('prepared!');
  expect(result.target).toBe('original');
}, 30_000);

// The old instantaneous-fd-revocation assertion is archived with its failed evidence.
// Actual stop/invalidation/preservation requirements run in phase12-3-transaction.test.ts.
it('distinguishes a refused new open from the original file handle after root movement', async () => {
  const result = await probeLocalFileBoundary('move-root', 'write-open-file');
  expect(result.ready).toBe(true);
  expect(result.target).toBe('original');
  const events = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events.find((event) => 'reopenErrno' in event)?.reopenErrno).toBe(1);
  // Either OS behavior is acceptable for the original object; neither is an applied receipt.
  if (result.exitCode === 0) {
    expect(result.backup).toBe('prepared!');
    expect(events.some((event) => event.wrotePreparedFile === true)).toBe(true);
  } else {
    expect(result.backup).toBe('candidate');
  }
}, 30_000);
