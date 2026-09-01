import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMutation, createMainChannel, type Message, setMutation } from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageBus, MessageCommitted } from '../../../comm/bus/src/index';
import { JsonProjectChannelStore } from '../../../comm/channels/src/index';
import { JsonTaskStateStore, type TaskScope } from '../../../runtime/state/src/index';

import { MessageService } from '../src/index';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-message-service-test-'));
  roots.push(root);
  return root;
}

const scope: TaskScope = { projectId: 'project-a', taskId: 'task-a' };

function message(overrides: Partial<Message> = {}): Message {
  return {
    msgId: 'message-1',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    payload: { intent: 'chat' },
    display: 'Please implement the task.',
    ts: 42,
    ...overrides,
  };
}

class RecordingBus implements MessageBus {
  readonly events: MessageCommitted[] = [];
  onPublish?: (event: MessageCommitted) => Promise<void>;

  async publish(event: MessageCommitted): Promise<void> {
    if (this.onPublish !== undefined) await this.onPublish(event);
    this.events.push(event);
  }
}

async function createService(store: JsonTaskStateStore, bus: MessageBus): Promise<MessageService> {
  const channels = new JsonProjectChannelStore(await temporaryRoot(), [
    'COORDINATOR',
    'CODER',
    'TESTER',
    'REVIEWER',
  ]);
  await channels.initialize(scope.projectId, [
    createMainChannel(['COORDINATOR', 'CODER', 'TESTER', 'REVIEWER']),
  ]);
  return new MessageService(store, bus, channels);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MessageService', () => {
  it('persists a message before publishing its committed event', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus = new RecordingBus();
    const service = await createService(store, bus);
    await service.initialize(scope, 'Build the message flow');
    bus.onPublish = async () => {
      const persisted = await store.load(scope);
      expect(persisted?.messages.map((item) => item.msgId)).toEqual(['message-1']);
    };

    await expect(service.commitMessage(scope, message())).resolves.toMatchObject({
      published: true,
    });
    expect(bus.events).toEqual([{ ...scope, message: message() }]);
  });

  it('does not publish an idempotent msgId replay twice', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus = new RecordingBus();
    const service = await createService(store, bus);
    await service.initialize(scope, 'Build the message flow');

    const first = await service.commitMessage(scope, message());
    const replay = await service.commitMessage(scope, message());

    expect(first.published).toBe(true);
    expect(replay.published).toBe(false);
    expect(bus.events).toHaveLength(1);
  });

  it('commits a planned leader message and its action mutations before publishing', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus = new RecordingBus();
    const service = await createService(store, bus);
    await service.initialize(scope, 'Build the message flow');
    const leaderMessage = message({
      display: '@CODER implement the cache',
      payload: { kind: 'leader_intent', action: { status: 'applied' } },
    });
    bus.onPublish = async () => {
      await expect(store.load(scope)).resolves.toMatchObject({
        nextRole: 'CODER',
        messages: [leaderMessage],
      });
    };

    const result = await service.commitPlannedMessage(scope, leaderMessage.msgId, () => ({
      message: leaderMessage,
      mutations: [setMutation('nextRole', 'CODER')],
    }));

    expect(result).toMatchObject({ published: true, message: leaderMessage });
    expect(result.state.nextRole).toBe('CODER');
    expect(bus.events).toEqual([{ ...scope, message: leaderMessage }]);
  });

  it('does not re-plan or reapply actions when a committed msgId is retried later', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus = new RecordingBus();
    const service = await createService(store, bus);
    await service.initialize(scope, 'Build the message flow');
    const leaderMessage = message({ display: '@CODER implement the cache' });

    await service.commitPlannedMessage(scope, leaderMessage.msgId, () => ({
      message: leaderMessage,
      mutations: [setMutation('nextRole', 'CODER')],
    }));
    await store.commit(scope, [setMutation('nextRole', 'TESTER')]);

    let replanned = false;
    const replay = await service.commitPlannedMessage(scope, leaderMessage.msgId, () => {
      replanned = true;
      return { message: leaderMessage, mutations: [setMutation('nextRole', 'CODER')] };
    });

    expect(replanned).toBe(false);
    expect(replay).toMatchObject({ published: false, message: leaderMessage });
    expect(replay.state.nextRole).toBe('TESTER');
    expect(bus.events).toHaveLength(1);
  });

  it('serializes concurrent retries so a logical leader action is planned once', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus = new RecordingBus();
    const service = await createService(store, bus);
    await service.initialize(scope, 'Build the message flow');
    const leaderMessage = message({ display: '@CODER implement the cache' });
    let plans = 0;
    const plan = () => {
      plans += 1;
      return { message: leaderMessage, mutations: [setMutation('nextRole', 'CODER')] };
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.commitPlannedMessage(scope, leaderMessage.msgId, plan),
      ),
    );

    expect(plans).toBe(1);
    expect(results.filter((result) => result.published)).toHaveLength(1);
    expect(bus.events).toHaveLength(1);
    await expect(store.load(scope)).resolves.toMatchObject({ nextRole: 'CODER' });
  });

  it('keeps the committed snapshot when downstream delivery fails', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus: MessageBus = {
      publish: async () => {
        throw new Error('delivery unavailable');
      },
    };
    const service = await createService(store, bus);
    await service.initialize(scope, 'Build the message flow');

    await expect(service.commitMessage(scope, message())).rejects.toThrow('delivery unavailable');
    await expect(store.load(scope)).resolves.toMatchObject({ messages: [message()] });
  });

  it('commits orchestration mutations before publishing every newly appended agent message', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus = new RecordingBus();
    const service = await createService(store, bus);
    await service.initialize(scope, 'Build the message flow');
    const first = message({
      msgId: 'agent-1',
      fromRole: 'CODER',
      display: 'Implementation ready.',
    });
    const second = message({ msgId: 'agent-2', fromRole: 'TESTER', display: 'Tests passed.' });
    bus.onPublish = async (event) => {
      const persisted = await store.load(scope);
      expect(persisted?.phase).toBe('testing');
      expect(persisted?.messages.map((item) => item.msgId)).toEqual(['agent-1', 'agent-2']);
      expect(persisted?.messages.some((item) => item.msgId === event.message.msgId)).toBe(true);
    };

    const result = await service.commitMutations(scope, [
      appendMutation('messages', first),
      setMutation('phase', 'testing'),
      appendMutation('messages', second),
    ]);

    expect(result.changed).toBe(true);
    expect(result.publishedMessages).toEqual([first, second]);
    expect(bus.events).toEqual([
      { ...scope, message: first },
      { ...scope, message: second },
    ]);
  });

  it('does not republish an idempotent orchestration message replay', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus = new RecordingBus();
    const service = await createService(store, bus);
    await service.initialize(scope, 'Build the message flow');
    const agentMessage = message({ msgId: 'agent-1', fromRole: 'COORDINATOR' });
    const mutations = [appendMutation('messages', agentMessage)] as const;

    const first = await service.commitMutations(scope, mutations);
    const replay = await service.commitMutations(scope, mutations);

    expect(first.publishedMessages).toEqual([agentMessage]);
    expect(replay.changed).toBe(false);
    expect(replay.publishedMessages).toEqual([]);
    expect(bus.events).toHaveLength(1);
  });

  it('rejects a message addressed to a channel missing from the project registry', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const service = await createService(store, new RecordingBus());
    await service.initialize(scope, 'Build the message flow');

    await expect(
      service.commitMessage(scope, message({ channelId: 'private-channel' })),
    ).rejects.toThrow('does not exist');
  });

  it('rejects a non-main orchestration message before committing sibling mutations', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const service = await createService(store, new RecordingBus());
    await service.initialize(scope, 'Build the message flow');

    await expect(
      service.commitMutations(scope, [
        setMutation('phase', 'testing'),
        appendMutation('messages', message({ channelId: 'private-channel' })),
      ]),
    ).rejects.toThrow('does not exist');
    await expect(store.load(scope)).resolves.toMatchObject({ phase: 'clarifying', messages: [] });
  });

  it('uses the persisted Channel registry for dynamic addressing before State commit', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);
    const bus = new RecordingBus();
    const channels = new JsonProjectChannelStore(root, ['COORDINATOR', 'CODER', 'TESTER']);
    await channels.initialize(scope.projectId, [
      {
        channelId: 'main',
        kind: 'main',
        participants: ['leader', 'COORDINATOR', 'CODER', 'TESTER'],
        localContext: [],
        closed: false,
      },
      {
        channelId: 'sub-task-a',
        kind: 'sub',
        taskId: 'task-a',
        participants: ['leader', 'CODER'],
        localContext: [],
        closed: false,
      },
    ]);
    const service = new MessageService(store, bus, channels);
    await service.initialize(scope, 'Build the message flow');
    const subMessage = message({ channelId: 'sub-task-a', fromRole: 'CODER' });

    await expect(service.commitMessage(scope, subMessage)).resolves.toMatchObject({
      published: true,
    });
    await expect(store.load(scope)).resolves.toMatchObject({ messages: [subMessage] });
    expect(bus.events).toEqual([{ ...scope, message: subMessage }]);
  });

  it('rejects cross-task, non-participant, and closed channels without State or bus effects', async () => {
    const root = await temporaryRoot();
    const store = new JsonTaskStateStore(root);
    const bus = new RecordingBus();
    const channels = new JsonProjectChannelStore(root, ['COORDINATOR', 'CODER', 'TESTER']);
    await channels.initialize(scope.projectId, [
      createMainChannel(['COORDINATOR', 'CODER', 'TESTER']),
      {
        channelId: 'other-task',
        kind: 'sub',
        taskId: 'task-b',
        participants: ['leader', 'CODER'],
        localContext: [],
        closed: false,
      },
      {
        channelId: 'coder-only',
        kind: 'sub',
        taskId: 'task-a',
        participants: ['leader', 'CODER'],
        localContext: [],
        closed: false,
      },
      {
        channelId: 'closed',
        kind: 'sub',
        taskId: 'task-a',
        participants: ['leader', 'CODER'],
        localContext: [],
        closed: true,
      },
    ]);
    const service = new MessageService(store, bus, channels);
    await service.initialize(scope, 'Build the message flow');

    await expect(
      service.commitMessage(scope, message({ msgId: 'cross-task', channelId: 'other-task' })),
    ).rejects.toThrow('bound to taskId');
    await expect(
      service.commitMessage(
        scope,
        message({ msgId: 'non-participant', channelId: 'coder-only', fromRole: 'TESTER' }),
      ),
    ).rejects.toThrow('is not a participant');
    await expect(
      service.commitMessage(scope, message({ msgId: 'closed', channelId: 'closed' })),
    ).rejects.toThrow('is closed');

    await expect(store.load(scope)).resolves.toMatchObject({ messages: [] });
    expect(bus.events).toEqual([]);
  });
});
