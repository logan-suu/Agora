import { describe, expect, it } from 'vitest';

import { GlobalScheduler, type SlotLease } from '../src/index';

function deterministicScheduler(cap: number): GlobalScheduler {
  let sequence = 0;
  return new GlobalScheduler({
    cap,
    newId: () => `lease-${++sequence}`,
    now: () => sequence,
  });
}

async function expectPending<T>(promise: Promise<T>): Promise<void> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe('GlobalScheduler (D17)', () => {
  it('enforces the global cap and grants a queued worker after release', async () => {
    const scheduler = deterministicScheduler(2);
    const first = await scheduler.acquire('project-a', 'task-a', 'worker-a-1');
    const second = await scheduler.acquire('project-a', 'task-a', 'worker-a-2');
    const queued = scheduler.acquire('project-b', 'task-b', 'worker-b-1');

    expect(scheduler.activeCount).toBe(2);
    await expectPending(queued);

    await scheduler.release(first);

    await expect(queued).resolves.toMatchObject({
      projectId: 'project-b',
      workerId: 'worker-b-1',
    });
    expect(scheduler.activeCount).toBe(2);
    await scheduler.release(second);
    await scheduler.release(await queued);
    expect(scheduler.activeCount).toBe(0);
  });

  it('deduplicates active and queued acquire calls by projectId/workerId', async () => {
    const scheduler = deterministicScheduler(1);
    const active = await scheduler.acquire('project-a', 'task-a', 'worker-a');

    await expect(scheduler.acquire('project-a', 'task-a', 'worker-a')).resolves.toBe(active);

    const queued = scheduler.acquire('project-b', 'task-b', 'worker-b');
    const replay = scheduler.acquire('project-b', 'task-b', 'worker-b');
    await expectPending(queued);
    await scheduler.release(active);

    const granted = await queued;
    await expect(replay).resolves.toBe(granted);
    expect(granted.leaseId).toBe('lease-2');
    await scheduler.release(granted);
  });

  it('round-robins waiting projects instead of letting one project monopolize the slot', async () => {
    const scheduler = deterministicScheduler(1);
    const active = await scheduler.acquire('project-a', 'task-a', 'worker-a-0');
    const a1 = scheduler.acquire('project-a', 'task-a', 'worker-a-1');
    const a2 = scheduler.acquire('project-a', 'task-a', 'worker-a-2');
    const b1 = scheduler.acquire('project-b', 'task-b', 'worker-b-1');
    const b2 = scheduler.acquire('project-b', 'task-b', 'worker-b-2');

    await scheduler.release(active);
    const first = await b1;
    expect(first.workerId).toBe('worker-b-1');
    await expectPending(a1);

    await scheduler.release(first);
    const second = await a1;
    expect(second.workerId).toBe('worker-a-1');

    await scheduler.release(second);
    const third = await b2;
    expect(third.workerId).toBe('worker-b-2');

    await scheduler.release(third);
    const fourth = await a2;
    expect(fourth.workerId).toBe('worker-a-2');
    await scheduler.release(fourth);
  });

  it('keeps the round-robin successor when a granted project leaves a multi-slot queue', async () => {
    const scheduler = deterministicScheduler(3);
    const active = await Promise.all([
      scheduler.acquire('project-a', 'task-a', 'worker-a-0'),
      scheduler.acquire('project-a', 'task-a', 'worker-a-1'),
      scheduler.acquire('project-a', 'task-a', 'worker-a-2'),
    ]);
    const a3 = scheduler.acquire('project-a', 'task-a', 'worker-a-3');
    const b1 = scheduler.acquire('project-b', 'task-b', 'worker-b-1');
    const c1 = scheduler.acquire('project-c', 'task-c', 'worker-c-1');

    await scheduler.release(active[0] as SlotLease);
    await expect(b1).resolves.toMatchObject({ projectId: 'project-b' });
    await scheduler.release(active[1] as SlotLease);
    await expect(c1).resolves.toMatchObject({ projectId: 'project-c' });
    await expectPending(a3);

    await scheduler.release(active[2] as SlotLease);
    await scheduler.release(await a3);
    await scheduler.release(await b1);
    await scheduler.release(await c1);
  });

  it('scopes the same workerId independently by projectId/taskId', async () => {
    const scheduler = deterministicScheduler(2);

    const first = await scheduler.acquire('project-a', 'task-a', 'worker:dispatch:0');
    const second = await scheduler.acquire('project-a', 'task-b', 'worker:dispatch:0');

    expect(first).not.toBe(second);
    expect(first.taskId).toBe('task-a');
    expect(second.taskId).toBe('task-b');
    await scheduler.release(first);
    await scheduler.release(second);
  });

  it('makes duplicate release a no-op but rejects a forged or mismatched lease', async () => {
    const scheduler = deterministicScheduler(1);
    const lease = await scheduler.acquire('project-a', 'task-a', 'worker-a');

    await scheduler.release(lease);
    await expect(scheduler.release(lease)).resolves.toBeUndefined();

    const forged: SlotLease = { ...lease, workerId: 'worker-other' };
    await expect(scheduler.release(forged)).rejects.toThrow(/does not match/);
    await expect(scheduler.release({ ...lease })).rejects.toThrow(/does not match/);
  });

  it('removes an aborted queued acquire without consuming a future slot', async () => {
    const scheduler = deterministicScheduler(1);
    const active = await scheduler.acquire('project-a', 'task-a', 'worker-a');
    const controller = new AbortController();
    const cancelled = scheduler.acquire('project-b', 'task-b', 'worker-b', controller.signal);

    controller.abort('leader-cancelled');
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await scheduler.release(active);

    const next = await scheduler.acquire('project-c', 'task-c', 'worker-c');
    expect(next.workerId).toBe('worker-c');
    await scheduler.release(next);
  });

  it('rejects invalid capacity before any lease can be acquired', () => {
    expect(() => new GlobalScheduler({ cap: 0 })).toThrow(/positive integer/);
    expect(() => new GlobalScheduler({ cap: 1.5 })).toThrow(/positive integer/);
  });
});
