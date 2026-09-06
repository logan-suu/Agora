// R11/G5: only the external paid LLM stream is scripted. HTTP intent handling,
// JSON TaskStateStore/ProjectCollaborationStore, MessageService, D13 selection,
// project(), WorkerRuntime, and HarnessExecutor all use their real implementations.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerRuntime } from '@agora/core-orchestration';
import { HarnessExecutor } from '@agora/runtime-executor';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';

class CapturingAdapter extends LlmAdapter {
  readonly inputs: string[] = [];

  async *stream(options: Parameters<LlmAdapter['stream']>[0]): AsyncIterable<StreamChunk> {
    this.inputs.push(
      options.messages
        .flatMap((message) => message.content)
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('\n'),
    );
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Handoff accepted and testing started.' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Handoff accepted and testing started.' },
    };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function postBody(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('Phase 7 role onboarding real execution chain', () => {
  it('rebuilds persisted handoff context after restart and feeds it through D1 to Harness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase7-onboarding-'));
    roots.push(root);
    const scope = { projectId: 'phase7-project', taskId: 'phase7-task' };
    const firstRuntime = createMessageRuntime(root, new ChannelStream());
    await firstRuntime.initialize(scope, 'Take over cache verification');
    const post = createPostMessage(firstRuntime);

    await post(
      postBody({
        ...scope,
        channelId: 'main',
        msgId: 'remove-coder-g5',
        display: '/role remove CODER to TESTER',
      }),
    );
    const onboarded = await post(
      postBody({
        ...scope,
        channelId: 'main',
        msgId: 'onboard-tester-g5',
        display: '/role onboard TESTER',
      }),
    );
    await expect(onboarded.json()).resolves.toMatchObject({
      action: { status: 'applied' },
    });

    const restarted = createMessageRuntime(root, new ChannelStream());
    const persisted = await restarted.store.load(scope);
    if (persisted === undefined) throw new Error('expected persisted onboarding state');
    const adapter = new CapturingAdapter();
    const executors: HarnessExecutor[] = [];
    const worker = new WorkerRuntime({
      roster: [],
      loadRoster: () => restarted.enabledRoleSpecs(scope.projectId),
      buildChannelContext: (state, role) => restarted.channelContextFor(state, role),
      transition: async (_state, mutations) =>
        (await restarted.commitMutations(scope, mutations)).state,
      transitionStep: async (_state, role, mutations) =>
        (await restarted.commitWorkerStepMutations(scope, role, mutations)).state,
      buildExecutor: (spec) => {
        const executor = new HarnessExecutor(spec, { adapter, provider: 'agora' });
        executors.push(executor);
        return executor;
      },
    });

    try {
      const final = await worker.runOne(persisted, {
        workerId: 'worker:phase7-onboarding:tester',
        role: 'TESTER',
      });
      expect(adapter.inputs).toHaveLength(1);
      expect(adapter.inputs[0]).toContain('"onboardingContext"');
      expect(adapter.inputs[0]).toContain('"actionId":"onboard-tester-g5"');
      expect(adapter.inputs[0]).toContain('"msgId":"role-departure:remove-coder-g5"');
      expect(adapter.inputs[0]).toContain('"fromRole":"CODER"');
      expect(adapter.inputs[0]).not.toContain('/role onboard TESTER');
      expect(adapter.inputs[0]).not.toContain('Role CODER handoff is ready');
      expect(final.messages.at(-1)).toMatchObject({
        fromRole: 'TESTER',
        display: 'Handoff accepted and testing started.',
      });
      await expect(restarted.store.load(scope)).resolves.toMatchObject({
        nextRole: 'TESTER',
        messages: expect.arrayContaining([
          expect.objectContaining({ msgId: 'onboard-tester-g5' }),
          expect.objectContaining({
            fromRole: 'TESTER',
            display: 'Handoff accepted and testing started.',
          }),
        ]),
      });
    } finally {
      await Promise.all(executors.map((executor) => executor.dispose()));
    }
  });
});
