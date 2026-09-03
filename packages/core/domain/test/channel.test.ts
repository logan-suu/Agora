import { describe, expect, it } from 'vitest';

import {
  assertValidChannelRegistry,
  type Channel,
  createMainChannel,
  type RosterEntry,
} from '../src/index';

const ENABLED_ROLES = ['COORDINATOR', 'CODER', 'TESTER'] as const;

function subChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: 'sub-task-a-coder-tester',
    kind: 'sub',
    taskId: 'task-a',
    threadId: 'thread-a',
    topic: 'Investigate task A',
    createdBy: 'CODER',
    participants: ['leader', 'CODER', 'TESTER'],
    closed: false,
    ...overrides,
  } as Channel;
}

describe('Channel registry invariants', () => {
  it('creates the one open main channel from the enabled roster', () => {
    const main = createMainChannel(ENABLED_ROLES);

    expect(main).toEqual({
      channelId: 'main',
      kind: 'main',
      participants: ['leader', ...ENABLED_ROLES],
      closed: false,
    });
    expect(() => assertValidChannelRegistry([main, subChannel()], ENABLED_ROLES)).not.toThrow();
  });

  it('rejects duplicate and reserved identities in the enabled roster before creating main', () => {
    expect(() => createMainChannel(['CODER', 'CODER'])).toThrow(
      'enabled roster roles must be unique',
    );
    expect(() => createMainChannel(['leader' as (typeof ENABLED_ROLES)[number]])).toThrow(
      'enabled roster roles must not use reserved participant "leader"',
    );
  });

  it.each([
    {
      name: 'a missing main channel',
      channels: [subChannel()],
      error: 'exactly one main channel',
    },
    {
      name: 'duplicate channel ids',
      channels: [createMainChannel(ENABLED_ROLES), subChannel({ channelId: 'main' })],
      error: 'channelId must be unique',
    },
    {
      name: 'a closed main channel',
      channels: [{ ...createMainChannel(ENABLED_ROLES), closed: true }],
      error: 'main channel must remain open',
    },
    {
      name: 'a main channel whose roster drifted',
      channels: [{ ...createMainChannel(ENABLED_ROLES), participants: ['leader', 'CODER'] }],
      error: 'main channel participants must equal leader plus enabled roster',
    },
    {
      name: 'a sub channel without leader',
      channels: [
        createMainChannel(ENABLED_ROLES),
        subChannel({ participants: ['CODER', 'TESTER'] }),
      ],
      error: 'must include leader',
    },
    {
      name: 'a sub channel without a task scope',
      channels: [createMainChannel(ENABLED_ROLES), subChannel({ taskId: '' })],
      error: 'sub channel taskId must be a safe non-empty segment',
    },
    {
      name: 'a sub channel without a thread identity',
      channels: [createMainChannel(ENABLED_ROLES), subChannel({ threadId: '' })],
      error: 'sub channel threadId must be a safe non-empty segment',
    },
    {
      name: 'a sub channel without a topic',
      channels: [createMainChannel(ENABLED_ROLES), subChannel({ topic: '' })],
      error: 'sub channel topic must be a non-empty string',
    },
    {
      name: 'a sub channel created by an unknown role',
      channels: [createMainChannel(ENABLED_ROLES), subChannel({ createdBy: 'REVIEWER' })],
      error: 'sub channel "sub-task-a-coder-tester" createdBy "REVIEWER" is not known',
    },
    {
      name: 'a sub channel whose creator is not a participant',
      channels: [
        createMainChannel(ENABLED_ROLES),
        subChannel({ createdBy: 'COORDINATOR', participants: ['leader', 'CODER', 'TESTER'] }),
      ],
      error: 'sub channel "sub-task-a-coder-tester" must include creator "COORDINATOR"',
    },
    {
      name: 'a summary reference for another task',
      channels: [
        createMainChannel(ENABLED_ROLES),
        subChannel({
          closed: true,
          bubbledSummaryRef: {
            taskId: 'task-b',
            msgId: 'channel-bubble:sub-task-a-coder-tester',
          },
        }),
      ],
      error: 'bubbledSummaryRef taskId must match channel taskId',
    },
    {
      name: 'a summary reference on an open channel',
      channels: [
        createMainChannel(ENABLED_ROLES),
        subChannel({
          bubbledSummaryRef: {
            taskId: 'task-a',
            msgId: 'channel-bubble:sub-task-a-coder-tester',
          },
        }),
      ],
      error: 'must be closed before summary is referenced',
    },
    {
      name: 'a non-stable summary reference',
      channels: [
        createMainChannel(ENABLED_ROLES),
        subChannel({
          closed: true,
          bubbledSummaryRef: { taskId: 'task-a', msgId: 'message-1' },
        }),
      ],
      error: 'bubbledSummaryRef msgId must be stable',
    },
  ])('rejects $name', ({ channels, error }) => {
    expect(() => assertValidChannelRegistry(channels, ENABLED_ROLES)).toThrow(error);
  });

  it('keeps historical sub-channel identities valid after a member is disabled', () => {
    const roster: RosterEntry[] = ENABLED_ROLES.map((role) => ({
      spec: {
        role,
        executor: 'harness',
        systemPrompt: role,
        tools: [],
        projection: ['global.summary'],
        routeWhen: 'always',
      },
      status: role === 'CODER' ? 'disabled' : 'enabled',
    }));
    const channels = [
      createMainChannel(['COORDINATOR', 'TESTER']),
      subChannel({ createdBy: 'CODER', participants: ['leader', 'CODER'] }),
    ];

    expect(() => assertValidChannelRegistry(channels, roster)).not.toThrow();
  });
});
