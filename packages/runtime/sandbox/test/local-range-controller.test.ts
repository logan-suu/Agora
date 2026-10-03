// Task/control/object doubles isolate saga order and crash boundaries. They do
// not prove native writers, official Harness closure, or G5.
import { applyMutations, createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { localRangeSourceKey } from '../src/local-range-evidence';
import { fixture } from './local-range-control-fixture';

it('publishes a durable barrier before the canonical message and does not wait for worker closure inside commit', async () => {
  const f = fixture();
  const state = await f.controller.commit(f.scope, f.message);
  expect(state.messages).toEqual([f.message]);
  expect(f.events.indexOf('prepared:requested')).toBeLessThan(
    f.events.indexOf('canonical-message'),
  );
  expect(f.events).not.toContain('close-workers');
  expect((await f.control.snapshot()).rangeHolds?.[0]).toMatchObject({
    stage: 'requested',
    controlStage: 'committed',
  });
  expect(await f.objects.getReference(localRangeSourceKey(f.hold.plan))).toBeTruthy();
  await f.controller.hold('takeover:take');
  expect((await f.control.snapshot()).rangeHolds?.[0]).toMatchObject({ stage: 'heldByLeader' });
});

it('replays the original immutable control facts without closing a worker again', async () => {
  const f = fixture();
  await f.controller.commit(f.scope, f.message);
  await f.controller.hold('takeover:take');
  const before = [...f.events];
  await f.controller.commit(f.scope, { ...f.message, ts: 999 });
  expect(f.events.slice(before.length)).not.toContain('close-workers');
  expect((await f.control.snapshot()).rangeHolds?.[0]?.plan.sourceMessage.ts).toBe(1);
});

it('records a post-barrier task commit failure and never treats the unfinished saga as editable', async () => {
  const f = fixture();
  f.tasks.compareAndCommit = async () => {
    throw Error('disk-failure-private');
  };
  await expect(f.controller.commit(f.scope, f.message)).rejects.toThrow(
    'range_control_needs_attention',
  );
  const hold = (await f.control.snapshot()).rangeHolds?.[0];
  expect(hold).toMatchObject({ stage: 'requested', controlStage: 'prepared' });
  expect(hold?.evidence.at(-1)?.phase).toBe('needs_attention');
  expect(await f.controller.view('takeover:take')).toMatchObject({
    editable: false,
    needsAttention: true,
  });
});

it('retains the barrier on closure failure and replay does not retry an unknown close outcome', async () => {
  const f = fixture();
  await f.controller.commit(f.scope, f.message);
  f.lifecycle.closeWorkers = async () => {
    f.events.push('close-workers');
    throw Error('native-unknown');
  };
  await expect(f.controller.hold('takeover:take')).rejects.toThrow('range_control_needs_attention');
  expect((await f.control.snapshot()).rangeHolds?.[0]).toMatchObject({ stage: 'requested' });
  await f.controller.commit(f.scope, f.message);
  expect(f.events.filter((e) => e === 'close-workers')).toHaveLength(1);
  expect(await f.controller.view('takeover:take')).toMatchObject({ needsAttention: true });
});

it('refuses a swapped cohort proof rather than advancing to held', async () => {
  const f = fixture();
  await f.controller.commit(f.scope, f.message);
  const close = f.lifecycle.closeWorkers;
  f.lifecycle.closeWorkers = async (h, s) =>
    (await close(h, s)).map((p) => ({ ...p, workerId: 'other' }));
  await expect(f.controller.hold('takeover:take')).rejects.toThrow('range_control_needs_attention');
  expect((await f.control.snapshot()).rangeHolds?.[0]?.stage).toBe('requested');
  expect(f.events).not.toContain('prove-writers');
});

it('rejects a changed action or noncanonical transport before installing a barrier', async () => {
  const f = fixture();
  await expect(f.controller.commit({ ...f.scope, taskId: 'other' }, f.message)).rejects.toThrow();
  expect((await f.control.snapshot()).rangeHolds).toEqual([]);
  expect(f.events).toEqual([]);
});

it('rejects a previously used canonical action before publishing a new range barrier', async () => {
  const f = fixture();
  const original = createInitialAppState('task', 'test', 'project');
  f.setState(applyMutations(original, [{ op: 'append', field: 'messages', value: f.message }]));
  await expect(f.controller.commit(f.scope, f.message)).rejects.toThrow('range_control_conflict');
  expect(f.events).toEqual([]);
  expect((await f.control.snapshot()).rangeHolds).toEqual([]);
});
it('rejects a replay with missing original source proof and never repeats worker closure', async () => {
  const f = fixture();
  await f.controller.commit(f.scope, f.message);
  f.refs.delete(localRangeSourceKey(f.hold.plan));
  await expect(f.controller.commit(f.scope, f.message)).rejects.toThrow(
    'range_control_needs_attention',
  );
  expect(f.events).not.toContain('close-workers');
});
