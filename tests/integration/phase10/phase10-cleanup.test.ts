// Cleanup callbacks inject disposal failures; temporary directories and removal are real.
// This verifies test lifecycle accounting, not a replacement for the real G5 chains.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { finishWithCleanup } from './cleanup';

it('preserves the body and every cleanup failure while attempting later resource cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-cleanup-errors-'));
  const bodyError = new Error('assertion failed');
  const executorError = new Error('executor disposal failed');
  const sandboxError = new Error('sandbox disposal failed');
  const attempted: string[] = [];
  try {
    await expect(
      finishWithCleanup(
        [bodyError],
        [
          () => {
            attempted.push('executor');
            throw executorError;
          },
          async () => {
            attempted.push('sandbox');
            throw sandboxError;
          },
          async () => {
            attempted.push('root');
            await rm(root, { recursive: true });
          },
        ],
      ),
    ).rejects.toMatchObject({ errors: [bodyError, executorError, sandboxError] });
    expect(attempted).toEqual(['executor', 'sandbox', 'root']);
    expect(existsSync(root)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('propagates a sole cleanup failure unchanged and does not skip later cleanup', async () => {
  const failure = new Error('disposal failed');
  let cleaned = false;
  await expect(
    finishWithCleanup(
      [],
      [
        () => {
          throw failure;
        },
        () => {
          cleaned = true;
        },
      ],
    ),
  ).rejects.toBe(failure);
  expect(cleaned).toBe(true);
  await expect(finishWithCleanup([], [() => undefined])).resolves.toBeUndefined();
  await expect(finishWithCleanup([undefined], [])).rejects.toBeUndefined();
});
