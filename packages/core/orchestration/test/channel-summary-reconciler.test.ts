import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageBus } from '@agora/comm-bus';
import { JsonProjectChannelStore, type ProjectChannelStore } from '@agora/comm-channels';
import {
  type ChannelSummary,
  createInitialAppState,
  createMainChannel,
  type Message,
  type SubChannel,
} from '@agora/core-domain';
import type { ChannelSummaryGenerator } from '@agora/runtime-executor';
import { JsonTaskStateStore } from '@agora/runtime-state';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelSummaryReconciler, MessageService } from '../src/index';

const roots: string[] = [];
const scope = { projectId: 'project-a', taskId: 'task-a' };
const roles = ['COORDINATOR', 'CODER'] as const;

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'agora-channel-reconcile-'));
  roots.push(root);
  return root;
}

function sub(overrides: Partial<SubChannel> = {}): SubChannel {
  return {
    channelId: 'sub-task-a',
    kind: 'sub',
    taskId: scope.taskId,
    threadId: 'thread-a',
    topic: 'Agree on storage ordering',
    createdBy: 'CODER',
    participants: ['leader', 'CODER'],
    closed: true,
    ...overrides,
  };
}

function sourceMessage(): Message {
  return {
    msgId: 'source-1',
    channelId: 'sub-task-a',
    fromRole: 'CODER',
    type: 'feedback',
    payload: { reason: 'message_first' },
    display: 'do not project this',
    ts: 1,
  };
}

class RecordingBus implements MessageBus {
  published: string[] = [];
  fail = false;

  async publish(event: { message: Message }): Promise<void> {
    this.published.push(event.message.msgId);
    if (this.fail) throw new Error('publish failed');
  }
}

class FakeGenerator implements ChannelSummaryGenerator {
  calls = 0;
  constructor(readonly value: ChannelSummary) {}

  async generate(): Promise<ChannelSummary> {
    this.calls += 1;
    return structuredClone(this.value);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { bus?: RecordingBus; channels?: ProjectChannelStore } = {}) {
  const root = await temporaryRoot();
  const state = new JsonTaskStateStore(root);
  const actualChannels = new JsonProjectChannelStore(root, roles);
  const channels = options.channels ?? actualChannels;
  await actualChannels.initialize(scope.projectId, [createMainChannel(roles), sub()]);
  await state.initialize(scope, {
    ...createInitialAppState(scope.taskId, 'goal', scope.projectId),
    messages: [sourceMessage()],
  });
  const bus = options.bus ?? new RecordingBus();
  const messages = new MessageService(state, bus, channels);
  return { root, state, actualChannels, channels, bus, messages };
}

function generatedSummary(): ChannelSummary {
  return {
    conclusion: 'Commit the message before its reference.',
    keyDecisions: [{ decision: 'Message first', rationale: 'State is first-write-stays.' }],
    openQuestions: [],
    sourceMsgIds: ['source-1'],
  };
}

describe('ChannelSummaryReconciler', () => {
  it('writes the stable main fact before the reference and is idempotent', async () => {
    const context = await fixture();
    const generator = new FakeGenerator(generatedSummary());
    const reconciler = new ChannelSummaryReconciler({
      channels: context.channels,
      messages: context.messages,
      state: context.state,
      generator,
      clock: () => 10,
    });

    await reconciler.reconcile(scope);
    await reconciler.reconcile(scope);

    const state = await context.state.load(scope);
    const snapshot = await context.channels.load(scope.projectId);
    expect(generator.calls).toBe(1);
    expect(state?.messages.at(-1)).toMatchObject({
      msgId: 'channel-bubble:sub-task-a',
      threadId: 'thread-a',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      display: generatedSummary().conclusion,
      payload: { kind: 'channel_summary', summary: generatedSummary() },
    });
    expect(snapshot?.channels[1]).toMatchObject({
      bubbledSummaryRef: { taskId: scope.taskId, msgId: 'channel-bubble:sub-task-a' },
    });
    expect(context.bus.published).toEqual(['channel-bubble:sub-task-a']);
  });

  it('recovers after publish failure without regenerating or overwriting the first message', async () => {
    const bus = new RecordingBus();
    bus.fail = true;
    const context = await fixture({ bus });
    const first = new FakeGenerator(generatedSummary());
    const firstReconciler = new ChannelSummaryReconciler({
      channels: context.channels,
      messages: context.messages,
      state: context.state,
      generator: first,
    });

    await expect(firstReconciler.reconcile(scope)).rejects.toThrow('publish failed');
    expect((await context.channels.load(scope.projectId))?.channels[1]).not.toHaveProperty(
      'bubbledSummaryRef',
    );

    bus.fail = false;
    const second = new FakeGenerator({ ...generatedSummary(), conclusion: 'must not replace' });
    await new ChannelSummaryReconciler({
      channels: context.channels,
      messages: context.messages,
      state: context.state,
      generator: second,
    }).reconcile(scope);

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
    expect((await context.state.load(scope))?.messages.at(-1)?.display).toBe(
      generatedSummary().conclusion,
    );
  });

  it('reloads and retries a concurrent channel revision conflict', async () => {
    const root = await temporaryRoot();
    const state = new JsonTaskStateStore(root);
    const actual = new JsonProjectChannelStore(root, roles);
    await actual.initialize(scope.projectId, [createMainChannel(roles), sub()]);
    await state.initialize(scope, {
      ...createInitialAppState(scope.taskId, 'goal', scope.projectId),
      messages: [sourceMessage()],
    });
    let conflicted = false;
    const channels: ProjectChannelStore = {
      initialize: (...args) => actual.initialize(...args),
      load: (...args) => actual.load(...args),
      commit: async (projectId, expectedRevision, next) => {
        if (!conflicted) {
          conflicted = true;
          await actual.commit(projectId, expectedRevision, [
            ...next.map((channel) => {
              if (channel.kind !== 'sub') return channel;
              const { bubbledSummaryRef: _ignored, ...withoutRef } = channel;
              return withoutRef;
            }),
            sub({ channelId: 'sub-other', threadId: 'other' }),
          ]);
        }
        return actual.commit(projectId, expectedRevision, next);
      },
    };
    const bus = new RecordingBus();
    const generator = new FakeGenerator(generatedSummary());
    await new ChannelSummaryReconciler({
      channels,
      messages: new MessageService(state, bus, channels),
      state,
      generator,
    }).reconcile(scope);

    expect(conflicted).toBe(true);
    expect((await actual.load(scope.projectId))?.channels[1]).toHaveProperty(
      'bubbledSummaryRef.msgId',
      'channel-bubble:sub-task-a',
    );
  });

  it('migrates legacy localContext and bubbledSummary without invoking the model', async () => {
    const root = await temporaryRoot();
    const state = new JsonTaskStateStore(root);
    const channels = new JsonProjectChannelStore(root, roles);
    await state.initialize(scope, createInitialAppState(scope.taskId, 'goal', scope.projectId));
    const path = join(root, 'projects', scope.projectId, 'channels.json');
    await writeFile(
      path,
      `${JSON.stringify({
        projectId: scope.projectId,
        revision: 2,
        channels: [
          { ...createMainChannel(roles), localContext: [] },
          {
            ...sub(),
            localContext: [{ taskId: scope.taskId, msgId: 'old' }],
            bubbledSummary: 'Legacy conclusion.',
          },
        ],
      })}\n`,
      'utf8',
    );
    await channels.initialize(scope.projectId, [createMainChannel(roles)]);
    const generator = new FakeGenerator(generatedSummary());
    await new ChannelSummaryReconciler({
      channels,
      messages: new MessageService(state, new RecordingBus(), channels),
      state,
      generator,
      legacySummaries: (projectId) => channels.legacyBubbledSummaries(projectId),
      acknowledgeLegacySummary: (projectId, channelId) =>
        channels.acknowledgeLegacyBubbledSummary(projectId, channelId),
    }).reconcile(scope);

    expect(generator.calls).toBe(0);
    expect((await state.load(scope))?.messages[0]?.display).toBe('Legacy conclusion.');
    const persisted = await readFile(
      join(root, 'projects', scope.projectId, 'collaboration.json'),
      'utf8',
    );
    expect(persisted).not.toContain('localContext');
    expect(persisted).not.toContain('bubbledSummary"');
    expect(persisted).toContain('bubbledSummaryRef');
    await expect(
      readFile(join(root, 'projects', scope.projectId, 'legacy-channel-summaries.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
