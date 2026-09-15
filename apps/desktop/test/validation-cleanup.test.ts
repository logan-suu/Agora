// Real no-model child processes exercise validation cleanup, not product G5 substitutes.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { cleanupChild } from '../scripts/validation-cleanup.mjs';

it('returns immediately for a child that already exited by signal', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBe('SIGTERM');
  expect(await cleanupChild(child, 50)).toBe(false);
  expect(child.listenerCount('exit')).toBe(0);
});

it('waits for actual forced exit of an unresponsive no-model child', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  expect(await cleanupChild(child, 50)).toBe(true);
  expect(child.signalCode).toBe('SIGKILL');
  expect(child.listenerCount('exit')).toBe(0);
});
