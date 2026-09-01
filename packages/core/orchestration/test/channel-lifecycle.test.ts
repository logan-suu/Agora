import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMainChannel, type RoleId } from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageBus, MessageCommitted } from '../../../comm/bus/src/index';
import { JsonProjectChannelStore } from '../../../comm/channels/src/index';
import { JsonTaskStateStore, type TaskScope } from '../../../runtime/state/src/index';

import { ChannelLifecycleService, MessageService } from '../src/index';

const ENABLED_ROLES = ['COORDINATOR', 'CODER', 'TESTER'] as const satisfies readonly RoleId[];
const scope: TaskScope = { projectId: 'project-a', taskId: 'task-a' };
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-channel-lifecycle-test-'));
  roots.push(root);
  return root;
}

class RecordingBus implements MessageBus {
  readonly events: MessageCommitted[] = [];
  onPublish?: (event: MessageCommitted) => Promise<void>;

  async publish(event: MessageCommitted): Promise<void> {
    if (this.onPublish !== undefined) await this.onPublish(event);
    this.events.push(event);
  }
}

async function setup(initializeTask = true) {
  const root = await temporaryRoot();
  const channels = new JsonProjectChannelStore(root, ENABLED_ROLES);
  await channels.initialize(scope.projectId, [createMainChannel(ENABLED_ROLES)]);
  const states = new JsonTaskStateStore(root);
  const bus = new RecordingBus();
  const messages = new MessageService(states, bus, channels);
  if (initializeTask) await messages.initialize(scope, 'Implement channel lifecycle');
  const lifecycle = new ChannelLifecycleService(channels, messages, ENABLED_ROLES, () => 42);
  return { bus, channels, lifecycle, messages, states };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ChannelLifecycleService', () => {
  it('opens a normalized sub-channel before committing its main-channel announcement', async () => {
    const { bus, channels, lifecycle } = await setup();
    bus.onPublish = async () => {
      await expect(channels.load(scope.projectId)).resolves.toMatchObject({
        revision: 1,
        channels: [
          { channelId: 'main' },
          {
            channelId: 'sub-6-task-a-action-1',
            threadId: 'action-1',
            participants: ['leader', 'CODER', 'TESTER'],
          },
        ],
      });
    };

    const result = await lifecycle.open({
      scope,
      actor: 'CODER',
      actionId: 'action-1',
      requestedRoles: ['TESTER', 'CODER'],
      topic: 'Investigate the cache race',
    });

    expect(result).toMatchObject({ changed: true, announced: true });
    expect(result.channel).toEqual({
      channelId: 'sub-6-task-a-action-1',
      kind: 'sub',
      taskId: 'task-a',
      threadId: 'action-1',
      topic: 'Investigate the cache race',
      createdBy: 'CODER',
      participants: ['leader', 'CODER', 'TESTER'],
      closed: false,
    });
    expect(bus.events).toHaveLength(1);
    expect(bus.events[0]?.message).toMatchObject({
      msgId: 'channel-open:sub-6-task-a-action-1',
      channelId: 'main',
      type: 'announce',
      payload: { kind: 'sub_channel_opened', channelId: 'sub-6-task-a-action-1' },
    });
  });

  it('treats participant order and duplicate open requests as one semantic operation', async () => {
    const { bus, channels, lifecycle, states } = await setup();
    const first = await lifecycle.open({
      scope,
      actor: 'CODER',
      actionId: 'action-1',
      requestedRoles: ['TESTER'],
      topic: 'Investigate the cache race',
    });
    const replay = await lifecycle.open({
      scope,
      actor: 'CODER',
      actionId: 'action-1',
      requestedRoles: ['CODER', 'TESTER'],
      topic: 'Investigate the cache race',
    });

    expect(first.changed).toBe(true);
    expect(replay).toMatchObject({ changed: false, announced: false });
    expect((await channels.load(scope.projectId))?.revision).toBe(1);
    expect((await states.load(scope))?.messages).toHaveLength(1);
    expect(bus.events).toHaveLength(1);
  });

  it('rejects semantic conflicts and never reopens a closed thread', async () => {
    const { lifecycle } = await setup();
    await lifecycle.open({
      scope,
      actor: 'CODER',
      actionId: 'action-1',
      threadId: 'cache-thread',
      requestedRoles: ['TESTER'],
      topic: 'Investigate the cache race',
    });

    await expect(
      lifecycle.open({
        scope,
        actor: 'CODER',
        actionId: 'action-2',
        threadId: 'cache-thread',
        requestedRoles: ['TESTER'],
        topic: 'A different topic',
      }),
    ).rejects.toThrow('conflicts with existing sub-channel');

    await lifecycle.close({
      scope,
      actor: 'leader',
      actionId: 'close-action-1',
      channelId: 'sub-6-task-a-action-1',
    });
    await expect(
      lifecycle.open({
        scope,
        actor: 'CODER',
        actionId: 'action-2',
        threadId: 'cache-thread',
        requestedRoles: ['TESTER'],
        topic: 'Investigate the cache race',
      }),
    ).rejects.toThrow('closed thread cannot be reopened');
  });

  it('allows only leader or participants to close and makes repeated close a no-op', async () => {
    const { bus, channels, lifecycle } = await setup();
    await lifecycle.open({
      scope,
      actor: 'CODER',
      actionId: 'action-1',
      requestedRoles: ['TESTER'],
      topic: 'Investigate the cache race',
    });

    await expect(
      lifecycle.close({
        scope,
        actor: 'COORDINATOR',
        actionId: 'close-denied',
        channelId: 'sub-6-task-a-action-1',
      }),
    ).rejects.toThrow('is not allowed to close');
    await expect(
      lifecycle.close({ scope, actor: 'leader', actionId: 'close-main', channelId: 'main' }),
    ).rejects.toThrow('main channel cannot be closed');

    const first = await lifecycle.close({
      scope,
      actor: 'TESTER',
      actionId: 'close-action-1',
      channelId: 'sub-6-task-a-action-1',
    });
    const replay = await lifecycle.close({
      scope,
      actor: 'TESTER',
      actionId: 'close-action-1',
      channelId: 'sub-6-task-a-action-1',
    });

    expect(first).toMatchObject({ changed: true, announced: true, channel: { closed: true } });
    expect(replay).toMatchObject({ changed: false, announced: false, channel: { closed: true } });
    expect((await channels.load(scope.projectId))?.revision).toBe(2);
    expect(bus.events).toHaveLength(2);
    expect(bus.events[1]?.message).toMatchObject({
      msgId: 'channel-close:sub-6-task-a-action-1',
      payload: { kind: 'sub_channel_closed', channelId: 'sub-6-task-a-action-1' },
    });
  });

  it('keeps a committed Channel when the State announcement fails and fills it on retry', async () => {
    const { channels, lifecycle, messages, states } = await setup(false);
    const request = {
      scope,
      actor: 'CODER' as const,
      actionId: 'action-1',
      requestedRoles: ['TESTER'],
      topic: 'Investigate the cache race',
    };

    await expect(lifecycle.open(request)).rejects.toThrow('task state is not initialized');
    await expect(channels.load(scope.projectId)).resolves.toMatchObject({
      revision: 1,
      channels: [{ channelId: 'main' }, { channelId: 'sub-6-task-a-action-1' }],
    });

    await messages.initialize(scope, 'Implement channel lifecycle');
    const retry = await lifecycle.open(request);

    expect(retry).toMatchObject({ changed: false, announced: true });
    expect((await channels.load(scope.projectId))?.revision).toBe(1);
    expect((await states.load(scope))?.messages).toHaveLength(1);
  });

  it('uses an injective task-length prefix and rejects same-action thread conflicts as business errors', async () => {
    const { lifecycle, messages } = await setup();
    const firstScope = { projectId: scope.projectId, taskId: 'a-b' };
    const secondScope = { projectId: scope.projectId, taskId: 'a' };
    await messages.initialize(firstScope, 'First task');
    await messages.initialize(secondScope, 'Second task');

    const first = await lifecycle.open({
      scope: firstScope,
      actor: 'CODER',
      actionId: 'c',
      requestedRoles: ['TESTER'],
      topic: 'First topic',
    });
    const second = await lifecycle.open({
      scope: secondScope,
      actor: 'CODER',
      actionId: 'b-c',
      requestedRoles: ['TESTER'],
      topic: 'Second topic',
    });

    expect(first.channel.channelId).toBe('sub-3-a-b-c');
    expect(second.channel.channelId).toBe('sub-1-a-b-c');
    await expect(
      lifecycle.open({
        scope: secondScope,
        actor: 'CODER',
        actionId: 'b-c',
        threadId: 'different-thread',
        requestedRoles: ['TESTER'],
        topic: 'Second topic',
      }),
    ).rejects.toThrow('channelId conflicts with another thread');
  });
});
