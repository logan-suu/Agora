import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@agora/core-domain';
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
