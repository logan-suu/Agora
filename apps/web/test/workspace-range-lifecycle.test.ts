// External composition/LLM doubles isolate host capacity and cleanup failures.
// The canonical store, message runtime, WorkerRuntime and orchestrator are real;
// native/Harness protections require the separate Phase 12 G5 tests.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState } from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect, it } from 'vitest';
import { ChannelStream } from '../src/server/channel-stream';
import { createMessageRuntime } from '../src/server/message-runtime';
import {
  type TaskCompositionFactory,
  TaskOrchestrationRuntime,
} from '../src/server/task-orchestration-runtime';

async function fixture(
  work: (f: {
    runtime: TaskOrchestrationRuntime;
    counts(): { created: number; suspended: number; archived: number };
    fail(): void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'agora-range-lifecycle-')),
    messages = createMessageRuntime(root, new ChannelStream());
  let created = 0,
    suspended = 0,
    archived = 0,
    fail = false;
  const factory: TaskCompositionFactory = async ({ scope, goal, transition, loadState }) => {
    created++;
    const initialState = createInitialAppState(scope.taskId, goal, scope.projectId);
    initialState.phase = 'coding';
    return {
      initialState,
      workerRuntime: new WorkerRuntime({
        roster: DEFAULT_ROSTER,
        loadState,
        transition,
        rangeAdmission: { isBlocked: async () => true, canAcquire: async () => false },
        buildExecutor: () => {
          throw Error('blocked_range_must_not_execute');
        },
      }),
      roster: DEFAULT_ROSTER,
      artifactPath: '/unused',
      saveSafePoints: async () => [],
      suspend: async () => {
        suspended++;
        if (fail) throw Error('actual_cleanup_failed');
      },
      dispose: async () => {
        throw Error('range_must_suspend');
      },
      archiveArtifact: async () => {
        archived++;
        throw Error('range_must_not_archive');
      },
    };
  };
  const runtime = new TaskOrchestrationRuntime(messages, factory, { maxActiveCompositions: 1 });
  try {
    await work({
      runtime,
      counts: () => ({ created, suspended, archived }),
      fail: () => {
        fail = true;
      },
    });
  } finally {
    await runtime.disposeAll();
    await rm(root, { recursive: true, force: true });
  }
}
it('suspends a fully range-blocked settled run and releases composition capacity without archival or ordinary restart', async () =>
  fixture(async (f) => {
    const first = {
      projectId: 'project',
      taskId: 'first',
      goal: 'Held workspace',
      requestId: 'start-first',
    };
    await f.runtime.start(first);
    await f.runtime.waitForIdle(first);
    expect(f.counts()).toEqual({ created: 1, suspended: 1, archived: 0 });
    expect((await f.runtime.summary(first))?.runStatus).toBe('needs_attention');
    expect((await f.runtime.start(first)).startOutcome).toBe('needs_attention');
    expect(f.counts().created).toBe(1);
    const second = { ...first, taskId: 'second', requestId: 'start-second' };
    await f.runtime.start(second);
    await f.runtime.waitForIdle(second);
    expect(f.counts()).toEqual({ created: 2, suspended: 2, archived: 0 });
  }));
it('retains composition capacity when range suspension fails', async () =>
  fixture(async (f) => {
    f.fail();
    const first = {
      projectId: 'project',
      taskId: 'first',
      goal: 'Held workspace',
      requestId: 'start-first',
    };
    await f.runtime.start(first);
    await f.runtime.waitForIdle(first);
    expect(f.counts()).toEqual({ created: 1, suspended: 1, archived: 0 });
    await expect(f.runtime.start({ ...first, taskId: 'second' })).rejects.toThrow('capacity');
    expect(f.counts().created).toBe(1);
  }));
