import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Message, setMutation } from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageBus, MessageCommitted } from '../../../comm/bus/src/index';
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MessageService', () => {
  it('persists a message before publishing its committed event', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const bus = new RecordingBus();
    const service = new MessageService(store, bus);
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
    const service = new MessageService(store, bus);
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
    const service = new MessageService(store, bus);
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
    const service = new MessageService(store, bus);
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
    const service = new MessageService(store, bus);
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
    const service = new MessageService(store, bus);
    await service.initialize(scope, 'Build the message flow');

    await expect(service.commitMessage(scope, message())).rejects.toThrow('delivery unavailable');
    await expect(store.load(scope)).resolves.toMatchObject({ messages: [message()] });
  });

  it('keeps Phase 5 message submission on the main channel', async () => {
    const store = new JsonTaskStateStore(await temporaryRoot());
    const service = new MessageService(store, new RecordingBus());
    await service.initialize(scope, 'Build the message flow');

    await expect(
      service.commitMessage(scope, message({ channelId: 'private-channel' })),
    ).rejects.toThrow('main');
  });
});
