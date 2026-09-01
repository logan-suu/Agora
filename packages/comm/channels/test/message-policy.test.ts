import { createMainChannel, type Message, type SubChannel } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import { assertMessageChannelAccess, type ProjectChannelSnapshot } from '../src/index';

function message(overrides: Partial<Message> = {}): Message {
  return {
    msgId: 'message-1',
    channelId: 'sub-task-a',
    fromRole: 'CODER',
    type: 'chat',
    payload: {},
    display: 'Ready.',
    ts: 1,
    ...overrides,
  };
}

function sub(overrides: Partial<SubChannel> = {}): SubChannel {
  return {
    channelId: 'sub-task-a',
    kind: 'sub',
    taskId: 'task-a',
    threadId: 'thread-a',
    topic: 'Task A',
    createdBy: 'leader',
    participants: ['leader', 'CODER'],
    localContext: [],
    closed: false,
    ...overrides,
  };
}

function project(channel: SubChannel = sub()): ProjectChannelSnapshot {
  return {
    projectId: 'project-a',
    revision: 1,
    channels: [createMainChannel(['COORDINATOR', 'CODER', 'TESTER']), channel],
  };
}

describe('assertMessageChannelAccess', () => {
  it('allows a participant to address an open channel bound to the current task', () => {
    expect(() => assertMessageChannelAccess(project(), 'task-a', message())).not.toThrow();
  });

  it.each([
    ['missing channel', project(), message({ channelId: 'missing' }), 'does not exist'],
    ['cross-task sub channel', project(), message(), 'bound to taskId "task-a"'],
    ['non-participant sender', project(), message({ fromRole: 'TESTER' }), 'is not a participant'],
    ['closed channel', project(sub({ closed: true })), message(), 'is closed'],
  ])('rejects %s before commit', (_name, snapshot, candidate, expected) => {
    const taskId = _name === 'cross-task sub channel' ? 'task-b' : 'task-a';
    expect(() => assertMessageChannelAccess(snapshot, taskId, candidate)).toThrow(expected);
  });
});
