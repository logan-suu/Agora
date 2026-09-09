// Executor, persistence failure and release failure are injected at their ports;
// WorkerRuntime, canonical joins, mutations and scheduler acquisition remain real.
import { applyMutations, createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { GlobalScheduler, type SlotLease } from '../src/global-scheduler';
import { ParallelBatchError, WorkerRuntime } from '../src/worker-runtime';

const execution = new Error('execution cause');
const persistence = new Error('failed state not persisted');
const cleanup = new Error('lease release cause');
class FailedRelease extends GlobalScheduler {
  override async release(lease: SlotLease) {
    await super.release(lease);
    throw cleanup;
  }
}
function setup() {
  let state = createInitialAppState('failure', 'goal');
  let calls = 0;
  const scheduler = new FailedRelease();
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_previous, mutations) => {
        if (
          mutations.some(
            (m) =>
              m.op === 'mergeById' &&
              m.field === 'workers' &&
              'status' in m.value &&
              m.value.status === 'failed',
          )
        )
          throw persistence;
        state = applyMutations(state, mutations);
        return state;
      },
      buildExecutor: () => ({
        async step() {
          calls++;
          throw execution;
        },
        async saveSafePoint() {
          return 'unused';
        },
        async loadSafePoint() {},
        injectInbox() {},
      }),
    },
    scheduler,
  );
  return {
    runtime,
    get state() {
      return state;
    },
    get calls() {
      return calls;
    },
  };
}
describe('worker failure causality', () => {
  it('preserves execution, failed commit and lease causes in sequential runs', async () => {
    const f = setup();
    const failure = await f.runtime
      .runOne(f.state, { workerId: 'worker-failure', role: 'CODER' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ cause: execution }),
      persistence,
      cleanup,
    ]);
    expect(f.state.workers[0]?.status).toBe('running');
    expect(f.calls).toBe(1);
  });
  it('retains distinct failure stages for one parallel worker without authorizing replay', async () => {
    const f = setup();
    const failure = await f.runtime
      .runParallel(f.state, [{ workerId: 'worker-failure', role: 'CODER' }])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ParallelBatchError);
    expect((failure as ParallelBatchError).retryable).toBe(false);
    expect((failure as ParallelBatchError).failures).toEqual([
      expect.objectContaining({
        stage: 'execution',
        cause: expect.objectContaining({ cause: execution }),
      }),
      expect.objectContaining({ stage: 'state_commit', cause: persistence }),
      expect.objectContaining({ stage: 'lease_release', cause: cleanup }),
    ]);
    expect(f.state.workers[0]?.status).toBe('running');
    expect(f.calls).toBe(1);
  });
});
