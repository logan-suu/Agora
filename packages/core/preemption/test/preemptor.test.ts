// R11: this unit test uses an in-memory lifecycle port because Preemptor is a pure
// coordinator; WorkerRuntime/Harness/StateStore integration is covered separately.
import { describe, expect, it } from 'vitest';

import {
  type PauseLifecyclePort,
  type PauseRequest,
  Preemptor,
  type WorkerPauseReceipt,
} from '../src/index';

function request(overrides: Partial<PauseRequest> = {}): PauseRequest {
  return {
    scope: { projectId: 'project-a', taskId: 'task-a' },
    actionId: 'change-1',
    reason: 'requirement_change',
    mode: 'reproject',
    ...overrides,
  };
}

function port(active = ['worker-b', 'worker-a']): PauseLifecyclePort & {
  events: string[];
} {
  const events: string[] = [];
  return {
    events,
    activeWorkerIds: () => [...active],
    cancelQueued: async (_scope, actionId) => {
      events.push(`cancel:${actionId}`);
    },
    pauseWorker: async (_scope, workerId, actionId, mode): Promise<WorkerPauseReceipt> => {
      events.push(`pause:${workerId}:${actionId}:${mode}`);
      return { workerId, status: 'paused', safePointRef: `safe:${workerId}` };
    },
    resumeReprojected: async (_scope, workerIds, actionId) => {
      events.push(`reproject:${actionId}:${workerIds.join(',')}`);
    },
    suspendPaused: async (_scope, workerIds, actionId) => {
      events.push(`suspend:${actionId}:${workerIds.join(',')}`);
    },
    abortPause: async (_scope, workerIds, actionId) => {
      events.push(`abort:${actionId}:${workerIds.join(',')}`);
    },
  };
}

describe('Preemptor', () => {
  it('freezes a stable sorted active cohort and reuses an identical action replay', async () => {
    const lifecycle = port();
    const preemptor = new Preemptor(lifecycle);
    const first = preemptor.requestPause(request());
    const replay = preemptor.requestPause({
      mode: 'reproject',
      reason: 'requirement_change',
      actionId: 'change-1',
      scope: { taskId: 'task-a', projectId: 'project-a' },
    });

    expect(replay).toBe(first);
    await expect(first).resolves.toEqual({
      scope: { projectId: 'project-a', taskId: 'task-a' },
      actionId: 'change-1',
      reason: 'requirement_change',
      mode: 'reproject',
      cohort: ['worker-a', 'worker-b'],
      workers: [
        { workerId: 'worker-a', status: 'paused', safePointRef: 'safe:worker-a' },
        { workerId: 'worker-b', status: 'paused', safePointRef: 'safe:worker-b' },
      ],
    });
    expect(lifecycle.events).toEqual([
      'cancel:change-1',
      'pause:worker-a:change-1:reproject',
      'pause:worker-b:change-1:reproject',
    ]);
  });

  it('rejects mismatched action reuse and a competing active epoch', async () => {
    let release: (() => void) | undefined;
    const lifecycle = port(['worker-a']);
    lifecycle.pauseWorker = async (_scope, workerId) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { workerId, status: 'paused', safePointRef: `safe:${workerId}` };
    };
    const preemptor = new Preemptor(lifecycle);
    const active = preemptor.requestPause(request());
    await Promise.resolve();
    await expect(preemptor.requestPause(request({ reason: 'decision_change' }))).rejects.toThrow(
      /conflicts/,
    );
    await expect(preemptor.requestPause(request({ actionId: 'change-2' }))).rejects.toThrow(
      /active pause epoch/,
    );
    release?.();
    await active;
  });

  it('allows an empty cohort to reach the barrier immediately', async () => {
    const lifecycle = port([]);
    const receipt = await new Preemptor(lifecycle).requestPause(request());
    expect(receipt.cohort).toEqual([]);
    expect(receipt.workers).toEqual([]);
    expect(lifecycle.events).toEqual(['cancel:change-1']);
  });

  it('closes an epoch once in the requested recovery mode and can abort failures', async () => {
    const lifecycle = port(['worker-a']);
    const preemptor = new Preemptor(lifecycle);
    const reproject = await preemptor.requestPause(request());
    await preemptor.complete(reproject);
    await preemptor.complete(reproject);
    expect(lifecycle.events.filter((event) => event.startsWith('reproject:'))).toEqual([
      'reproject:change-1:worker-a',
    ]);

    const suspend = await preemptor.requestPause(
      request({ actionId: 'gate-1', mode: 'human_gate', reason: 'iteration_limit' }),
    );
    await preemptor.complete(suspend);
    expect(lifecycle.events).toContain('suspend:gate-1:worker-a');

    const failed = await preemptor.requestPause(request({ actionId: 'change-3' }));
    await preemptor.abort(failed);
    expect(lifecycle.events).toContain('abort:change-3:worker-a');
  });

  it('rejects a forged receipt without closing the canonical pause epoch', async () => {
    const lifecycle = port(['worker-a']);
    const preemptor = new Preemptor(lifecycle);
    const receipt = await preemptor.requestPause(request());

    await expect(preemptor.complete({ ...receipt, cohort: [], workers: [] })).rejects.toThrow(
      /does not match its canonical barrier result/,
    );
    await preemptor.complete(receipt);
    expect(lifecycle.events).toContain('reproject:change-1:worker-a');
  });

  it('keeps failed complete and abort terminal operations retryable', async () => {
    const lifecycle = port(['worker-a']);
    let completeAttempts = 0;
    lifecycle.resumeReprojected = async (_scope, workerIds, actionId) => {
      lifecycle.events.push(`reproject:${actionId}:${workerIds.join(',')}`);
      completeAttempts += 1;
      if (completeAttempts === 1) throw new Error('transient reproject failure');
    };
    let abortAttempts = 0;
    lifecycle.abortPause = async (_scope, workerIds, actionId) => {
      lifecycle.events.push(`abort:${actionId}:${workerIds.join(',')}`);
      abortAttempts += 1;
      if (abortAttempts === 1) throw new Error('transient abort failure');
    };
    const preemptor = new Preemptor(lifecycle);

    const completing = await preemptor.requestPause(request());
    await expect(preemptor.complete(completing)).rejects.toThrow('transient reproject failure');
    await expect(preemptor.complete(completing)).resolves.toBeUndefined();

    const aborting = await preemptor.requestPause(request({ actionId: 'change-2' }));
    await expect(preemptor.abort(aborting)).rejects.toThrow('transient abort failure');
    await expect(preemptor.abort(aborting)).resolves.toBeUndefined();

    expect(completeAttempts).toBe(2);
    expect(abortAttempts).toBe(2);
  });
});
