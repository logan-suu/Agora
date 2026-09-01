import { describe, expect, it } from 'vitest';

import { assertValidChannelRegistry, type Channel, createMainChannel } from '../src/index';

const ENABLED_ROLES = ['COORDINATOR', 'CODER', 'TESTER'] as const;

function subChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: 'sub-task-a-coder-tester',
    kind: 'sub',
    taskId: 'task-a',
    participants: ['leader', 'CODER', 'TESTER'],
    localContext: [{ taskId: 'task-a', msgId: 'message-1' }],
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
      localContext: [],
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
      name: 'an unscoped local context reference',
      channels: [
        createMainChannel(ENABLED_ROLES),
        subChannel({ localContext: [{ taskId: '', msgId: 'message-1' }] }),
      ],
      error: 'localContext taskId must be a safe non-empty segment',
    },
  ])('rejects $name', ({ channels, error }) => {
    expect(() => assertValidChannelRegistry(channels, ENABLED_ROLES)).toThrow(error);
  });
});
