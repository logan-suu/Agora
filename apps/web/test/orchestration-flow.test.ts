// Mock reason (R11): these tests replace only the external LLM/Docker composition
// with deterministic Executor-port steps. The real JsonTaskStateStore,
// MessageService, runOrchestration, WorkerRuntime, and SSE bus remain in use;
// task 5.5 G5 separately exercises the production Harness + Docker composition.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  type Message,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import type { Executor, StepResult } from '@agora/runtime-executor';
import { JsonTaskStateStore } from '@agora/runtime-state';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../src/server/channel-stream';
import { createMessageRuntime } from '../src/server/message-runtime';
import { createGetTask, createPostTask } from '../src/server/task-handlers';
import {
  type TaskCompositionFactory,
  TaskGoalConflictError,
  TaskOrchestrationRuntime,
} from '../src/server/task-orchestration-runtime';

const roots: string[] = [];

function agentMessage(role: string, id: string): Message {
  return {
    msgId: id,
    channelId: 'main',
    fromRole: role,
    type: 'chat',
    payload: { kind: 'worker_progress' },
    display: `${role} completed its turn`,
    ts: Date.now(),
  };
}

class OneStepExecutor implements Executor {
  constructor(
    private readonly result: StepResult,
    private readonly wait: Promise<void> = Promise.resolve(),
  ) {}

  async step(): Promise<StepResult> {
    await this.wait;
    return this.result;
  }

  async saveSafePoint(): Promise<string> {
    return 'cursor';
  }

  async loadSafePoint(): Promise<void> {}

  injectInbox(): void {}
}

class FailingExecutor implements Executor {
  async step(): Promise<StepResult> {
    throw new Error('scripted worker failure');
  }

  async saveSafePoint(): Promise<string> {
    return 'cursor';
  }

  async loadSafePoint(): Promise<void> {}

  injectInbox(): void {}
}

function successfulFactory(
  gate: Promise<void>,
  lifecycle: { archived: number; disposed: number } = { archived: 0, disposed: 0 },
  failCoder = false,
): TaskCompositionFactory {
  return async ({ scope, goal, transition }) => {
    const initialState = applyMutations(
      createInitialAppState(scope.taskId, goal, scope.projectId),
      [
        mergeByIdMutation('subtasks', `${scope.taskId}-sub-0`, {
          title: goal,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'todo',
          worktree: '/tmp/agora-demo-artifact',
        }),
      ],
    );
    const workerRuntime = new WorkerRuntime({
      roster: DEFAULT_ROSTER,
      transition,
      buildExecutor: (spec) => {
        if (spec.role === 'CODER') {
          if (failCoder) return new FailingExecutor();
          return new OneStepExecutor(
            {
              kind: 'done',
              output: {},
              reachedSafeBoundary: true,
              mutations: [appendMutation('messages', agentMessage('CODER', 'coder-done'))],
            },
            gate,
          );
        }
        if (spec.role === 'TESTER') {
          return new OneStepExecutor({
            kind: 'done',
            output: {},
            reachedSafeBoundary: true,
            mutations: [
              setMutation('testResults', { passed: true, total: 2, failed: 0, failures: [] }),
              appendMutation('messages', agentMessage('TESTER', 'tester-done')),
            ],
          });
        }
        if (spec.role === 'REVIEWER') {
          return new OneStepExecutor({
            kind: 'done',
            output: {},
            reachedSafeBoundary: true,
            mutations: [
              appendMutation('reviewComments', {
                id: 'review-approved',
                kind: 'verdict',
                verdict: 'approved',
                summary: 'Ready',
              }),
              appendMutation('messages', agentMessage('REVIEWER', 'reviewer-done')),
            ],
          });
        }
        throw new Error(`unexpected role ${spec.role}`);
      },
    });
    return {
      initialState,
      workerRuntime,
      roster: DEFAULT_ROSTER,
      artifactPath: '/tmp/agora-demo-artifact',
      archiveArtifact: async () => {
        lifecycle.archived += 1;
        return `/durable/${scope.projectId}/${scope.taskId}/artifacts/worktree`;
      },
      dispose: async () => {
        lifecycle.disposed += 1;
      },
    };
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TaskOrchestrationRuntime', () => {
  it('starts one persisted run, rejects a different goal, and recovers the completed summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-web-orchestration-test-'));
    roots.push(root);
    const stream = new ChannelStream();
    const messages = createMessageRuntime(root, stream);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = { archived: 0, disposed: 0 };
    const runtime = new TaskOrchestrationRuntime(messages, successfulFactory(gate, lifecycle));
    const published: string[] = [];
    stream.subscribe({ projectId: 'project-a', taskId: 'task-a', channelId: 'main' }, (event) => {
      if (
        event.type === 'message' &&
        typeof event.data === 'object' &&
        event.data !== null &&
        'msgId' in event.data &&
        typeof event.data.msgId === 'string'
      ) {
        published.push(event.data.msgId);
      }
    });

    await expect(
      runtime.start({
        projectId: 'project-a',
        taskId: 'task-a',
        requestId: 'request-1',
        goal: 'Build TTL LRU',
      }),
    ).resolves.toMatchObject({ startOutcome: 'started', runStatus: 'running' });
    await expect(
      runtime.start({
        projectId: 'project-a',
        taskId: 'task-a',
        requestId: 'request-1',
        goal: 'Build TTL LRU',
      }),
    ).resolves.toMatchObject({ startOutcome: 'already_running', runStatus: 'running' });
    await expect(
      runtime.start({
        projectId: 'project-a',
        taskId: 'task-a',
        requestId: 'request-2',
        goal: 'Different goal',
      }),
    ).rejects.toBeInstanceOf(TaskGoalConflictError);

    release();
    await runtime.waitForIdle({ projectId: 'project-a', taskId: 'task-a' });
    await expect(
      runtime.summary({ projectId: 'project-a', taskId: 'task-a' }),
    ).resolves.toMatchObject({
      runStatus: 'completed',
      phase: 'done',
      currentRole: 'REVIEWER',
      testResults: { passed: true },
      artifactPath: '/durable/project-a/task-a/artifacts/worktree',
    });
    expect(published).toContain('coder-done');
    expect(published).toContain('tester-done');
    expect(published).toContain('reviewer-done');
    expect(lifecycle).toEqual({ archived: 1, disposed: 1 });

    const restarted = new TaskOrchestrationRuntime(messages, successfulFactory(Promise.resolve()));
    await expect(
      restarted.summary({ projectId: 'project-a', taskId: 'task-a' }),
    ).resolves.toMatchObject({
      runStatus: 'completed',
      phase: 'done',
      artifactPath: '/durable/project-a/task-a/artifacts/worktree',
    });
  });

  it('reports an unfinished persisted task as interrupted after process restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-web-orchestration-test-'));
    roots.push(root);
    const messages = createMessageRuntime(root, new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await messages.initializeState(scope, createInitialAppState('task-a', 'Goal', 'project-a'));

    const restarted = new TaskOrchestrationRuntime(messages, successfulFactory(Promise.resolve()));

    await expect(restarted.summary(scope)).resolves.toMatchObject({
      runStatus: 'interrupted',
      phase: 'clarifying',
    });
  });

  it('backfills channels when lifecycle start discovers a legacy persisted task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-web-orchestration-test-'));
    roots.push(root);
    const scope = { projectId: 'legacy-project', taskId: 'legacy-task' };
    await new JsonTaskStateStore(root).initialize(
      scope,
      createInitialAppState(scope.taskId, 'Legacy goal', scope.projectId),
    );
    const messages = createMessageRuntime(root, new ChannelStream());
    const restarted = new TaskOrchestrationRuntime(messages, successfulFactory(Promise.resolve()));

    await expect(
      restarted.start({ ...scope, requestId: 'legacy-restart', goal: 'Legacy goal' }),
    ).resolves.toMatchObject({ startOutcome: 'interrupted', runStatus: 'interrupted' });
    await expect(messages.channels.load(scope.projectId)).resolves.toMatchObject({
      revision: 0,
      channels: [{ channelId: 'main' }],
    });
  });

  it('rejects a second active run anywhere in the Phase 5 backend instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-web-orchestration-test-'));
    roots.push(root);
    const messages = createMessageRuntime(root, new ChannelStream());
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new TaskOrchestrationRuntime(messages, successfulFactory(gate));

    await runtime.start({
      projectId: 'project-a',
      taskId: 'task-a',
      requestId: 'request-a',
      goal: 'First goal',
    });

    const post = createPostTask(runtime);
    const response = await post(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'project-b',
          taskId: 'task-b',
          requestId: 'request-b',
          goal: 'Second goal',
        }),
      }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('active'),
    });

    release();
    await runtime.waitForIdle({ projectId: 'project-a', taskId: 'task-a' });
  });

  it('archives available output and disposes resources when a run fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-web-orchestration-test-'));
    roots.push(root);
    const messages = createMessageRuntime(root, new ChannelStream());
    const lifecycle = { archived: 0, disposed: 0 };
    const scope = { projectId: 'project-a', taskId: 'failed-task' };
    const runtime = new TaskOrchestrationRuntime(
      messages,
      successfulFactory(Promise.resolve(), lifecycle, true),
    );

    await runtime.start({ ...scope, requestId: 'request-failed', goal: 'Build TTL LRU' });
    await runtime.waitForIdle(scope);

    await expect(runtime.summary(scope)).resolves.toMatchObject({
      runStatus: 'failed',
      artifactPath: '/durable/project-a/failed-task/artifacts/worktree',
      error: 'scripted worker failure',
    });
    expect(lifecycle).toEqual({ archived: 1, disposed: 1 });
  });

  it('exposes create/start and refresh recovery through the task HTTP handlers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-web-orchestration-test-'));
    roots.push(root);
    const messages = createMessageRuntime(root, new ChannelStream());
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new TaskOrchestrationRuntime(messages, successfulFactory(gate));
    const post = createPostTask(runtime);
    const get = createGetTask(runtime);
    const startBody = {
      projectId: 'project-a',
      taskId: 'task-a',
      requestId: 'request-a',
      goal: 'Build TTL LRU',
    };

    const started = await post(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        body: JSON.stringify(startBody),
      }),
    );
    expect(started.status).toBe(202);
    await expect(started.json()).resolves.toMatchObject({
      startOutcome: 'started',
      runStatus: 'running',
    });

    const conflict = await post(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ ...startBody, goal: 'A different goal' }),
      }),
    );
    expect(conflict.status).toBe(409);

    release();
    await runtime.waitForIdle({ projectId: 'project-a', taskId: 'task-a' });
    const recovered = await get(
      new Request('http://localhost/api/tasks?projectId=project-a&taskId=task-a'),
    );
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      runStatus: 'completed',
      phase: 'done',
      artifactPath: '/durable/project-a/task-a/artifacts/worktree',
    });
  });
});
