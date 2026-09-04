// Mock reason (R11): only the paid external LLM response is replaced. This test
// runs the real HarnessExecutor, LocalTempSandbox, Web composition root,
// TaskStateStore, MessageService, WorkerRuntime, SSE bus, and D4 suspend path.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppState } from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { project } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';

const ROLE_REPLIES: Readonly<Record<string, string>> = {
  PM: JSON.stringify([
    {
      id: 'req-1',
      story: 'Persist every accepted change before publishing it.',
      acceptance: ['A published objection already exists in durable task state.'],
      nonGoals: [],
    },
  ]),
  ARCHITECT: JSON.stringify({
    architecture: { persistence: 'state-before-stream' },
    conventions: { messageIds: 'stable' },
  }),
  CODER:
    'The requested shortcut conflicts with the confirmed durability requirement.\n' +
    '<agora-objection>{"claim":"contradiction","target":{"kind":"requirement","id":"req-1"},"argument":"Publishing before persistence violates the confirmed acceptance criterion."}</agora-objection>',
};

class ObjectionLlmAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* textChunks(ROLE_REPLIES[projectionRole(options)] ?? 'done');
  }
}

function projectionRole(options: GenerateOptions): string {
  const first = options.messages[0];
  const text = first?.content.find((block) => block.type === 'text');
  if (text?.type !== 'text') throw new Error('expected projected role input');
  const parsed = JSON.parse(text.text) as { role?: unknown };
  if (typeof parsed.role !== 'string') throw new Error('expected projected role');
  return parsed.role;
}

function* textChunks(value: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: value };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 8 objection dual track', () => {
  it('atomically persists a blocking objection, streams its display, and suspends at a complete D4 gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase8-objection-'));
    roots.push(root);
    const scope = { projectId: 'phase8-project', taskId: 'phase8-objection-task' };
    const stream = new ChannelStream();
    const messages = createMessageRuntime(root, stream);
    const statesObservedAtDelivery: Promise<AppState | undefined>[] = [];
    const delivered: Array<Record<string, unknown>> = [];
    const unsubscribe = stream.subscribe({ ...scope, channelId: 'main' }, (event) => {
      if (event.type !== 'message' || typeof event.data !== 'object' || event.data === null) return;
      const envelope = event.data as Record<string, unknown>;
      delivered.push(envelope);
      if (envelope.type === 'objection') statesObservedAtDelivery.push(messages.store.load(scope));
    });
    const sandbox = new LocalTempSandbox();
    const runtime = new TaskOrchestrationRuntime(
      messages,
      createWebTaskCompositionFactory({
        sandbox,
        dataRoot: root,
        executorOptions: {
          adapter: new ObjectionLlmAdapter(),
          provider: 'agora-phase8-objection',
          deepseek: false,
        },
      }),
    );

    try {
      const started = await runtime.start({
        ...scope,
        requestId: 'phase8-objection-request',
        goal: 'Implement a durable publish flow and reject any conflicting shortcut.',
      });
      expect(started.startOutcome).toBe('started');
      await runtime.waitForIdle(scope);

      await expect(runtime.summary(scope)).resolves.toMatchObject({
        runStatus: 'needs_attention',
        phase: 'coding',
      });
      const state = await messages.store.load(scope);
      const objection = state?.objections[0];
      expect(objection).toMatchObject({
        threadId: objection?.id,
        fromRole: 'CODER',
        target: { kind: 'requirement', id: 'req-1' },
        claim: 'contradiction',
        track: 'blocking',
      });
      expect(state?.messages.find((message) => message.msgId === objection?.id)).toMatchObject({
        threadId: objection?.id,
        fromRole: 'CODER',
        type: 'objection',
        display: 'The requested shortcut conflicts with the confirmed durability requirement.',
      });
      expect(state?.humanGate).toMatchObject({
        reason: `blocking_objection:${objection?.id}`,
        options: ['accept_objection', 'reject_objection'],
        phase: 'coding',
      });
      expect(state?.humanGate?.safePointRefs).toHaveLength(1);

      expect(delivered).toContainEqual({
        msgId: objection?.id,
        channelId: 'main',
        fromRole: 'CODER',
        type: 'objection',
        display: 'The requested shortcut conflicts with the confirmed durability requirement.',
        ts: objection?.ts,
      });
      expect(delivered.find((entry) => entry.type === 'objection')).not.toHaveProperty('payload');
      expect(statesObservedAtDelivery).toHaveLength(1);
      const stateAtDelivery = await statesObservedAtDelivery[0];
      expect(stateAtDelivery?.objections.some((entry) => entry.id === objection?.id)).toBe(true);
      expect(stateAtDelivery?.messages.some((message) => message.msgId === objection?.id)).toBe(
        true,
      );

      messages.bindHumanGateLifecyclePort({
        suspend: async () => {
          throw new Error('unexpected second suspend');
        },
        resume: async () => undefined,
      });
      const resolution = await createPostMessage(messages)(
        new Request('http://localhost/api/messages', {
          method: 'POST',
          body: JSON.stringify({
            ...scope,
            channelId: 'main',
            msgId: 'phase8-objection-resolution',
            display: `/resolve-gate ${state?.humanGate?.gateId} reject_objection The durability requirement remains controlling.`,
            ts: (objection?.ts ?? 0) + 1,
          }),
        }),
      );
      await expect(resolution.json()).resolves.toMatchObject({
        action: { status: 'applied' },
      });
      const resolved = await messages.store.load(scope);
      expect(resolved).not.toHaveProperty('humanGate');
      expect(resolved?.decisionLedger).toContainEqual(
        expect.objectContaining({
          id: 'objection-resolution:phase8-objection-resolution',
          authority: 'leader',
          decision: 'reject_objection',
          objectionResolution: {
            objectionId: objection?.id,
            outcome: 'rejected',
            target: { kind: 'requirement', id: 'req-1' },
          },
        }),
      );
      const coderProjection = project(resolved as AppState, 'CODER', DEFAULT_ROSTER);
      expect(coderProjection.slices.objectionResolutions).toEqual([
        expect.objectContaining({
          id: 'objection-resolution:phase8-objection-resolution',
          rationale: 'The durability requirement remains controlling.',
        }),
      ]);
    } finally {
      unsubscribe();
      await runtime.disposeAll();
    }
  }, 60_000);
});
