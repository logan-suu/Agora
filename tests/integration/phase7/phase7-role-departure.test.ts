// R11/G5: only the external paid LLM stream is scripted. HarnessExecutor, WorkerRuntime,
// HTTP intent handling, JSON stores, MessageService, roster CAS, safe-point persistence,
// handoff construction, and responsibility transfer all use their real implementations.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyMutations, createInitialAppState, mergeByIdMutation } from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor } from '@agora/runtime-executor';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';

class GatedAdapter extends LlmAdapter {
  readonly started: Promise<void>;
  private markStarted = () => {};
  private releaseStream = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseStream = resolve;
  });

  constructor() {
    super();
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  release(): void {
    this.releaseStream();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.markStarted();
    await this.gate;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Current coding step committed.' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Current coding step committed.' },
    };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 7 role departure real execution chain', () => {
  it('lets an in-flight Harness step commit before safe-point drain and deterministic handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase7-departure-'));
    roots.push(root);
    const scope = { projectId: 'phase7-project', taskId: 'phase7-task' };
    const messages = createMessageRuntime(root, new ChannelStream());
    const initial = applyMutations(
      createInitialAppState(scope.taskId, 'Finish and transfer coding', scope.projectId),
      [
        mergeByIdMutation('subtasks', 'coding-work', {
          title: 'Complete current coding work',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ],
    );
    await messages.initializeState(scope, initial);
    const adapter = new GatedAdapter();
    const executors: HarnessExecutor[] = [];
    const worker = new WorkerRuntime({
      roster: DEFAULT_ROSTER,
      loadRoster: () => messages.enabledRoleSpecs(scope.projectId),
      buildChannelContext: (state, role) => messages.workerStepChannelContextFor(state, role),
      transition: async (_state, mutations) =>
        (await messages.commitMutations(scope, mutations)).state,
      transitionStep: async (_state, role, mutations) =>
        (await messages.commitWorkerStepMutations(scope, role, mutations)).state,
      buildExecutor: (spec) => {
        const executor = new HarnessExecutor(spec, {
          adapter,
          provider: 'agora',
          sessionPersistence: {
            root: join(root, 'harness-sessions'),
            cwd: root,
            projectId: scope.projectId,
            taskId: scope.taskId,
          },
        });
        executors.push(executor);
        return executor;
      },
    });
    messages.bindRoleDrainPort({
      awaitSafePoint: async (_scope, role) => worker.awaitRoleSafePoint(role),
    });

    try {
      const running = worker.runOne(initial, {
        workerId: 'worker:phase7-departure:coder',
        role: 'CODER',
        subtaskId: 'coding-work',
      });
      await adapter.started;
      const responsePromise = createPostMessage(messages)(
        new Request('http://localhost/api/messages', {
          method: 'POST',
          body: JSON.stringify({
            ...scope,
            channelId: 'main',
            msgId: 'remove-coder-g5',
            display: '/role remove CODER to TESTER',
          }),
        }),
      );
      await expect
        .poll(
          async () =>
            (await messages.collaboration.load(scope.projectId))?.roster.find(
              (entry) => entry.spec.role === 'CODER',
            )?.status,
        )
        .toBe('departing');
      adapter.release();

      const [workerState, response] = await Promise.all([running, responsePromise]);
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ action: { status: 'applied' } });
      expect(workerState.messages.at(-1)).toMatchObject({
        fromRole: 'CODER',
        display: 'Current coding step committed.',
      });
      await expect(messages.store.load(scope)).resolves.toMatchObject({
        subtasks: [{ id: 'coding-work', ownerRole: 'TESTER' }],
        messages: expect.arrayContaining([
          expect.objectContaining({ fromRole: 'CODER' }),
          expect.objectContaining({ msgId: 'role-departure:remove-coder-g5' }),
        ]),
      });
      await expect(messages.collaboration.load(scope.projectId)).resolves.toMatchObject({
        roster: expect.arrayContaining([
          expect.objectContaining({
            spec: expect.objectContaining({ role: 'CODER' }),
            status: 'departed',
          }),
        ]),
      });
    } finally {
      adapter.release();
      await Promise.all(executors.map((executor) => executor.dispose()));
    }
  });
});
