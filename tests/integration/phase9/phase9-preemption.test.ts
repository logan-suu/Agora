// Mock reason (R11): only the paid external LLM response is deterministic. This
// test uses real Harness Context/Agent instances, official JSONL persistence,
// LocalTempSandbox recovery, JsonTaskStateStore, WorkerRuntime, GlobalScheduler,
// MessageRuntime, and the production Web task composition.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor, project } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';

class ReplyAdapter extends LlmAdapter {
  constructor(private readonly reply: string) {
    super();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: this.reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 9 cooperative preemption real chain', () => {
  it('forks every paused Harness worker from its own durable safe point and releases leases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase9-preemption-'));
    roots.push(root);
    const scope = { projectId: 'phase9-project', taskId: 'phase9-task' };
    const sandbox = new LocalTempSandbox();
    const worktree = await sandbox.createWorktree(scope.taskId, 'shared');
    await sandbox.write(
      worktree,
      'test-results.json',
      JSON.stringify({ passed: true, total: 1, failed: 0, failures: [] }),
    );
    const base = applyMutations(
      createInitialAppState(scope.taskId, 'Resume two workers', scope.projectId),
      [
        setMutation('phase', 'coding'),
        setMutation('iterationCount', 8),
        mergeByIdMutation('subtasks', 'work-a', {
          title: 'Work A',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
          worktree: worktree.path,
        }),
        mergeByIdMutation('subtasks', 'work-b', {
          title: 'Work B',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'todo',
          worktree: worktree.path,
        }),
      ],
    );
    const coder = DEFAULT_ROSTER.find((entry) => entry.role === 'CODER');
    if (coder === undefined) throw new Error('CODER role is missing');
    const sessionRoot = join(
      root,
      'projects',
      scope.projectId,
      'tasks',
      scope.taskId,
      'harness-sessions',
    );
    const safePoints: string[] = [];
    for (const source of ['source-a', 'source-b']) {
      const executor = new HarnessExecutor(coder, {
        adapter: new ReplyAdapter(source),
        provider: 'agora',
        sessionPersistence: {
          root: sessionRoot,
          cwd: worktree.path,
          projectId: scope.projectId,
          taskId: scope.taskId,
        },
      });
      await executor.step({
        sessionId: `phase9-${source}`,
        view: project(base, 'CODER', DEFAULT_ROSTER),
      });
      safePoints.push(await executor.saveSafePoint());
      await executor.dispose();
    }
    await sandbox.suspend(scope.taskId);

    const gated = applyMutations(base, [
      mergeByIdMutation('workers', 'worker-a', {
        workerId: 'worker-a',
        role: 'CODER',
        executor: 'harness',
        status: 'paused',
        subtaskId: 'work-a',
        worktree: worktree.path,
        sessionId: 'phase9-source-a',
        safePoint: safePoints[0],
        startedTs: 1,
      }),
      mergeByIdMutation('workers', 'worker-b', {
        workerId: 'worker-b',
        role: 'CODER',
        executor: 'harness',
        status: 'paused',
        subtaskId: 'work-b',
        worktree: worktree.path,
        sessionId: 'phase9-source-b',
        safePoint: safePoints[1],
        startedTs: 2,
      }),
      setMutation('humanGate', {
        gateId: 'human-gate:phase9-limit',
        reason: 'iteration_limit',
        options: ['continue'],
        phase: 'coding',
        openedTs: 3,
        safePointRefs: [safePoints[1] as string, safePoints[0] as string],
      }),
    ]);
    const messages = createMessageRuntime(root, new ChannelStream());
    await messages.initializeState(scope, gated);
    const scheduler = new GlobalScheduler({ cap: 3 });
    const runtime = new TaskOrchestrationRuntime(
      messages,
      createWebTaskCompositionFactory({
        sandbox,
        scheduler,
        dataRoot: root,
        executorOptions: {
          adapter: new ReplyAdapter(
            '[{"id":"phase9-approved","kind":"verdict","verdict":"approved","summary":"fork verified"}]',
          ),
          provider: 'agora',
          deepseek: false,
        },
      }),
    );

    const response = await createPostMessage(messages)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: 'resolve-phase9-limit',
          display: '/resolve-gate human-gate:phase9-limit continue',
        }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ action: { status: 'applied' } });
    await runtime.waitForIdle(scope);

    const state = await messages.store.load(scope);
    const resolution = state?.messages.find((message) => message.msgId === 'resolve-phase9-limit');
    expect(resolution?.payload.resolution).toMatchObject({
      workerResumes: [
        {
          workerId: 'worker-a',
          sourceSafePointRef: safePoints[0],
          resumeSessionId: 'human-gate-resume:resolve-phase9-limit:worker-a',
        },
        {
          workerId: 'worker-b',
          sourceSafePointRef: safePoints[1],
          resumeSessionId: 'human-gate-resume:resolve-phase9-limit:worker-b',
        },
      ],
    });
    expect(state?.workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workerId: 'worker-a',
          status: 'done',
          sessionId: 'human-gate-resume:resolve-phase9-limit:worker-a',
        }),
        expect.objectContaining({
          workerId: 'worker-b',
          status: 'done',
          sessionId: 'human-gate-resume:resolve-phase9-limit:worker-b',
        }),
      ]),
    );
    expect(await runtime.summary(scope)).toMatchObject({
      runStatus: 'needs_attention',
    });
    expect(state?.humanGate?.reason).toBe('completion_confirmation:phase9-approved');
    expect(scheduler.activeCount).toBe(0);

    await runtime.disposeAll();
    await sandbox.teardown(scope.taskId);
  });
});
