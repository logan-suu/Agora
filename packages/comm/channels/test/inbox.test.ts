import {
  createInitialAppState,
  createMainChannel,
  type Message,
  type SubChannel,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import { DerivedChannelInbox, type ProjectChannelSnapshot } from '../src/index';

const main = createMainChannel(['COORDINATOR', 'CODER', 'TESTER']);

function subChannel(
  channelId: string,
  taskId: string,
  participants: SubChannel['participants'],
): SubChannel {
  return {
    channelId,
    kind: 'sub',
    taskId,
    participants,
    localContext: [],
    closed: false,
  };
}

function message(msgId: string, channelId: string, to?: string[]): Message {
  const result: Message = {
    msgId,
    channelId,
    fromRole: 'COORDINATOR',
    type: 'chat',
    payload: { msgId },
    display: msgId,
    ts: Number(msgId.slice(1)),
  };
  if (to !== undefined) result.to = to;
  return result;
}

function project(): ProjectChannelSnapshot {
  return {
    projectId: 'project-a',
    revision: 3,
    channels: [
      main,
      subChannel('sub-task-a', 'task-a', ['leader', 'CODER']),
      subChannel('sub-task-b', 'task-b', ['leader', 'CODER']),
    ],
  };
}

describe('DerivedChannelInbox', () => {
  it('derives visible current-task messages without reordering direct mentions', () => {
    const task = {
      ...createInitialAppState('task-a', 'goal', 'project-a'),
      messages: [
        message('m1', 'main'),
        message('m2', 'sub-task-a', ['CODER']),
        message('m3', 'main', ['TESTER']),
        message('m4', 'sub-task-b', ['CODER']),
        message('m5', 'missing'),
      ],
    };

    expect(new DerivedChannelInbox().inboxFor(project(), task, 'CODER')).toEqual([
      { message: message('m1', 'main'), priority: 'normal' },
      { message: message('m2', 'sub-task-a', ['CODER']), priority: 'direct' },
      { message: message('m3', 'main', ['TESTER']), priority: 'normal' },
    ]);
  });

  it('uses participant membership for visibility while leader remains able to read sub channels', () => {
    const task = {
      ...createInitialAppState('task-a', 'goal', 'project-a'),
      messages: [message('m1', 'main'), message('m2', 'sub-task-a')],
    };
    const inbox = new DerivedChannelInbox();

    expect(inbox.inboxFor(project(), task, 'TESTER').map((item) => item.message.msgId)).toEqual([
      'm1',
    ]);
    expect(inbox.inboxFor(project(), task, 'leader').map((item) => item.message.msgId)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('rejects a cross-project composition instead of leaking messages', () => {
    const task = createInitialAppState('task-a', 'goal', 'project-b');

    expect(() => new DerivedChannelInbox().inboxFor(project(), task, 'CODER')).toThrow(
      'project identity mismatch',
    );
  });

  it('returns defensive message copies rather than mutable State references', () => {
    const task = {
      ...createInitialAppState('task-a', 'goal', 'project-a'),
      messages: [message('m1', 'main')],
    };
    const [item] = new DerivedChannelInbox().inboxFor(project(), task, 'CODER');

    if (item === undefined) throw new Error('expected inbox item');
    item.message.payload.changed = true;
    item.message.to = ['REVIEWER'];

    expect(task.messages[0]).toEqual(message('m1', 'main'));
  });
});
