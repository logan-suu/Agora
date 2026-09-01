import {
  type AppState,
  createInitialAppState,
  type Message,
  PHASE0_ROSTER,
} from '@agora/core-domain';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';
import { project } from '../src/project';

// Mock 原因（R11）：本文件注入 FakeLlmAdapter 隔离真实 LLM 调用，
// 仅验证 HarnessExecutor 的编排逻辑（pre-step 覆写 / 模型路由 / mutations 聚合 /
// done 收敛）。真实执行链路（真实 provider）的 G5 实测留待任务 0.6/0.7。
class FakeLlmAdapter extends LlmAdapter {
  public readonly calls: { provider: string; model: string; messagesText: string }[] = [];

  constructor(private readonly reply = 'fake reply') {
    super();
  }

  async *stream(options: Parameters<LlmAdapter['stream']>[0]): AsyncIterable<StreamChunk> {
    const messagesText = options.messages
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''))
      .join('\n---\n');
    this.calls.push({
      provider: options.provider,
      model: options.model,
      messagesText,
    });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: this.reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const CODER_SPEC = PHASE0_ROSTER.find((r) => r.role === 'CODER');
if (CODER_SPEC === undefined) throw new Error('CODER spec missing from PHASE0_ROSTER');

function codingState(): AppState {
  return {
    ...createInitialAppState('t-1', 'g'),
    phase: 'coding',
    iterationCount: 1,
  };
}

describe('HarnessExecutor (Phase 0 thin executor over DeepSeek Harness)', () => {
  it('runs one turn per step, emits a done StepResult, and folds the reply into a messages append mutation', async () => {
    const fake = new FakeLlmAdapter();
    const executor = new HarnessExecutor(CODER_SPEC, { adapter: fake, provider: 'agora' });
    try {
      const state = codingState();
      const view = project(state, 'CODER', PHASE0_ROSTER);

      const result = await executor.step({ sessionId: 'ses-1', view });

      expect(result.kind).toBe('done');
      expect(result.reachedSafeBoundary).toBe(true);
      expect(result.output).toEqual({ text: 'fake reply' });
      expect(result.mutations).toHaveLength(1);
      expect(result.mutations[0]).toMatchObject({ field: 'messages', op: 'append' });
    } finally {
      await executor.dispose();
    }
  });

  it('extracts one strict final channel action into output and payload while stripping it from display', async () => {
    const fake = new FakeLlmAdapter(
      'I need a focused test thread.\n<agora-channel-action>{"kind":"open_sub_channel","threadId":"cache-investigation","requestedRoles":["TESTER"],"topic":"Reproduce cache race"}</agora-channel-action>',
    );
    const executor = new HarnessExecutor(CODER_SPEC, { adapter: fake, provider: 'agora' });
    try {
      const result = await executor.step({
        sessionId: 'ses-channel-action',
        view: project(codingState(), 'CODER', PHASE0_ROSTER),
      });
      const mutation = result.mutations[0];
      if (mutation?.op !== 'append' || mutation.field !== 'messages') {
        throw new Error('expected assistant message mutation');
      }
      const message = mutation.value as Message;

      expect(result.output).toEqual({
        text: 'I need a focused test thread.',
        channelAction: {
          kind: 'open_sub_channel',
          actionId: message.msgId,
          threadId: 'cache-investigation',
          requestedRoles: ['TESTER'],
          topic: 'Reproduce cache race',
        },
      });
      expect(message.display).toBe('I need a focused test thread.');
      expect(message.payload).toEqual({ channelAction: result.output.channelAction });
    } finally {
      await executor.dispose();
    }
  });

  it('keeps a control-only audit message with a deterministic nonempty display', async () => {
    const fake = new FakeLlmAdapter(
      '<agora-channel-action>{"kind":"close_sub_channel","channelId":"sub-cache"}</agora-channel-action>',
    );
    const executor = new HarnessExecutor(CODER_SPEC, { adapter: fake, provider: 'agora' });
    try {
      const result = await executor.step({
        sessionId: 'ses-control-only',
        view: project(codingState(), 'CODER', PHASE0_ROSTER),
      });
      const mutation = result.mutations[0];
      if (mutation?.op !== 'append' || mutation.field !== 'messages') {
        throw new Error('expected assistant message mutation');
      }
      const message = mutation.value as Message;

      expect(message.display).toBe('Requested closing sub-channel sub-cache.');
      expect(message.display).not.toContain('agora-channel-action');
      expect(message.payload).toEqual({ channelAction: result.output.channelAction });
    } finally {
      await executor.dispose();
    }
  });

  it.each([
    {
      name: 'malformed JSON',
      reply: 'text\n<agora-channel-action>{broken}</agora-channel-action>',
    },
    {
      name: 'an unknown action kind',
      reply: 'text\n<agora-channel-action>{"kind":"archive"}</agora-channel-action>',
    },
    {
      name: 'multiple action blocks',
      reply:
        '<agora-channel-action>{"kind":"close_sub_channel","channelId":"sub-a"}</agora-channel-action>\n<agora-channel-action>{"kind":"close_sub_channel","channelId":"sub-b"}</agora-channel-action>',
    },
    {
      name: 'trailing nonempty text',
      reply:
        '<agora-channel-action>{"kind":"close_sub_channel","channelId":"sub-a"}</agora-channel-action>\nmore',
    },
  ])('fails the step for $name', async ({ reply }) => {
    const executor = new HarnessExecutor(CODER_SPEC, {
      adapter: new FakeLlmAdapter(reply),
      provider: 'agora',
    });
    try {
      await expect(
        executor.step({
          sessionId: 'ses-invalid-channel-action',
          view: project(codingState(), 'CODER', PHASE0_ROSTER),
        }),
      ).rejects.toThrow('invalid agora channel action');
    } finally {
      await executor.dispose();
    }
  });

  it('feeds the projection slice to the LLM via the pre-step overwrite (decision D1)', async () => {
    const fake = new FakeLlmAdapter();
    const executor = new HarnessExecutor(CODER_SPEC, { adapter: fake, provider: 'agora' });
    try {
      const state = {
        ...codingState(),
        subtasks: [
          {
            id: 's-1',
            title: 'write LRU',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress' as const,
          },
        ],
      };
      const view = project(state, 'CODER', PHASE0_ROSTER);

      await executor.step({ sessionId: 'ses-2', view });

      const call = fake.calls[0];
      expect(call?.messagesText).toContain('"role":"CODER"');
      expect(call?.messagesText).toContain('write LRU');
    } finally {
      await executor.dispose();
    }
  });

  it('routes the model per RoleSpec.model, falling back to env AGORA_MODEL', async () => {
    const fake = new FakeLlmAdapter();
    const spec = { ...CODER_SPEC, model: 'deepseek-coder-model' };
    const executor = new HarnessExecutor(spec, { adapter: fake, provider: 'agora' });
    try {
      const view = project(codingState(), 'CODER', PHASE0_ROSTER);

      await executor.step({ sessionId: 'ses-3', view });

      expect(fake.calls[0]).toMatchObject({ provider: 'agora', model: 'deepseek-coder-model' });
    } finally {
      await executor.dispose();
    }
  });

  it('injectInbox updates the projection used by the next pre-step overwrite', async () => {
    const fake = new FakeLlmAdapter();
    const executor = new HarnessExecutor(CODER_SPEC, { adapter: fake, provider: 'agora' });
    try {
      const initial = {
        ...codingState(),
        subtasks: [
          {
            id: 's-1',
            title: 'first plan',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress' as const,
          },
        ],
      };
      await executor.step({ sessionId: 'ses-4', view: project(initial, 'CODER', PHASE0_ROSTER) });

      const updated = {
        ...initial,
        subtasks: [
          {
            id: 's-1',
            title: 'revised plan',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress' as const,
          },
        ],
      };
      // injectInbox must take effect on the next step even when step() is
      // called with a stale view: the injected projection wins (preemption seam).
      executor.injectInbox(project(updated, 'CODER', PHASE0_ROSTER));
      await executor.step({ sessionId: 'ses-4', view: project(initial, 'CODER', PHASE0_ROSTER) });

      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0]?.messagesText).toContain('first plan');
      expect(fake.calls[1]?.messagesText).toContain('revised plan');
    } finally {
      await executor.dispose();
    }
  });

  it('keeps distinct session ids on distinct agents so turns do not cross-read each other', async () => {
    const fake = new FakeLlmAdapter();
    const executor = new HarnessExecutor(CODER_SPEC, { adapter: fake, provider: 'agora' });
    try {
      const first = {
        ...codingState(),
        subtasks: [
          {
            id: 's-a',
            title: 'task-for-session-a',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress' as const,
          },
        ],
      };
      const second = {
        ...codingState(),
        subtasks: [
          {
            id: 's-b',
            title: 'task-for-session-b',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress' as const,
          },
        ],
      };
      await executor.step({ sessionId: 'ses-a', view: project(first, 'CODER', PHASE0_ROSTER) });
      await executor.step({ sessionId: 'ses-b', view: project(second, 'CODER', PHASE0_ROSTER) });

      expect(fake.calls).toHaveLength(2);
      // Fresh session: the second agent's history must not contain the first session's view.
      expect(fake.calls[1]?.messagesText).toContain('task-for-session-b');
      expect(fake.calls[1]?.messagesText).not.toContain('task-for-session-a');
    } finally {
      await executor.dispose();
    }
  });

  it('saveSafePoint returns the live session id and loadSafePoint is a Phase 0 no-op', async () => {
    const fake = new FakeLlmAdapter();
    const executor = new HarnessExecutor(CODER_SPEC, { adapter: fake, provider: 'agora' });
    try {
      const view = project(codingState(), 'CODER', PHASE0_ROSTER);
      await executor.step({ sessionId: 'ses-safe', view });

      const cursor = await executor.saveSafePoint();
      expect(cursor).toBe('ses-safe');

      await expect(executor.loadSafePoint(cursor)).resolves.toBeUndefined();
    } finally {
      await executor.dispose();
    }
  });
});
