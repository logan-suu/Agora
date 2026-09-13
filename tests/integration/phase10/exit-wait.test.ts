import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { waitForExitStage } from './exit-wait';

it.each(['deadline', 'runtime failure'] as const)(
  'rejects an unreachable stage on %s so finally runs',
  async (mode) => {
    let cleaned = false;
    let failure: unknown;
    const work = (async () => {
      try {
        await waitForExitStage(
          new Promise(() => {}),
          'CODERs',
          async () => (mode === 'runtime failure' ? 'failed: PM output rejected' : undefined),
          20,
        );
      } catch (error) {
        failure = error;
      } finally {
        cleaned = true;
      }
    })();
    await Promise.race([work, delay(200)]);
    expect(cleaned).toBe(true);
    expect(String(failure)).toContain(
      mode === 'deadline' ? 'Timed out waiting for CODERs' : 'PM output rejected',
    );
  },
);

it('preserves an error from the runtime status reader', async () => {
  const error = new Error('State read failed');
  const observed = await Promise.race([
    waitForExitStage(
      new Promise(() => {}),
      'TESTER',
      async () => {
        throw error;
      },
      20,
    ).catch((e) => e),
    delay(200, 'hung'),
  ]);
  expect(observed).toBe(error);
});

it('finishes an entered stage and stops checking status', async () => {
  let calls = 0;
  await waitForExitStage(
    Promise.resolve(),
    'REVIEWER',
    async () => {
      calls++;
      return undefined;
    },
    20,
  );
  const settled = calls;
  await delay(40);
  expect(calls).toBe(settled);
});

it.each([false, true])(
  'unwinds an entry wait when cleanup aborts it (already aborted: %s)',
  async (alreadyAborted) => {
    const controller = new AbortController();
    const error = new Error('Fixture cleanup started');
    if (alreadyAborted) controller.abort(error);
    const waiting = waitForExitStage(
      new Promise(() => {}),
      'CODERs',
      async () => undefined,
      1000,
      controller.signal,
    );
    const rejected = expect(waiting).rejects.toBe(error);
    controller.abort(error);
    await rejected;
  },
);
