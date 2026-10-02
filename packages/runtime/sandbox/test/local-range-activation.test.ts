// Gated callbacks isolate barrier publication versus startup ordering; no OS or
// Harness closure is asserted by this unit fixture.
import { expect, it } from 'vitest';
import { serializeLocalRangeAdmission } from '../src/local-range-activation';

it('orders barrier publication before a queued startup rechecks admission', async () => {
  const owner = {},
    order: string[] = [];
  let release = () => {},
    started = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const beginning = new Promise<void>((r) => {
    started = r;
  });
  let held = false;
  const publish = serializeLocalRangeAdmission(owner, async () => {
    order.push('capture');
    started();
    await gate;
    held = true;
    order.push('barrier');
  });
  await beginning;
  const start = serializeLocalRangeAdmission(owner, async () => {
    order.push('recheck');
    if (!held) order.push('opened');
    return !held;
  });
  expect(order).toEqual(['capture']);
  release();
  await publish;
  expect(await start).toBe(false);
  expect(order).toEqual(['capture', 'barrier', 'recheck']);
});
it('waits for capability preparation to settle before taking a fixed cohort and does not retain a failed queue', async () => {
  const owner = {},
    order: string[] = [];
  let release = () => {},
    started = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const beginning = new Promise<void>((r) => {
    started = r;
  });
  const start = serializeLocalRangeAdmission(owner, async () => {
    order.push('preparing');
    started();
    await gate;
    order.push('active');
  });
  await beginning;
  const publish = serializeLocalRangeAdmission(owner, async () => {
    order.push('snapshot');
  });
  release();
  await start;
  await publish;
  expect(order).toEqual(['preparing', 'active', 'snapshot']);
  await expect(
    serializeLocalRangeAdmission(owner, async () => {
      throw Error('failed');
    }),
  ).rejects.toThrow('failed');
  expect(await serializeLocalRangeAdmission(owner, async () => 7)).toBe(7);
});
it('keeps unrelated backend owners independent', async () => {
  const a = {},
    b = {};
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const pending = serializeLocalRangeAdmission(a, async () => gate);
  expect(await serializeLocalRangeAdmission(b, async () => 'independent')).toBe('independent');
  release();
  await pending;
});
