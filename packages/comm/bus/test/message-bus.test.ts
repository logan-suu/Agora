import type { Message } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import { toDisplayMessageEvent } from '../src/index';

function message(): Message {
  return {
    msgId: 'message-1',
    channelId: 'main',
    fromRole: 'CODER',
    type: 'chat',
    payload: { internalPrompt: 'must remain server-side' },
    display: 'Implemented the requested change.',
    ts: 42,
  };
}

describe('toDisplayMessageEvent', () => {
  it('creates a scoped client envelope without exposing payload', () => {
    const event = toDisplayMessageEvent({
      projectId: 'project-a',
      taskId: 'task-a',
      message: message(),
    });

    expect(event).toEqual({
      msgId: 'message-1',
      channelId: 'main',
      fromRole: 'CODER',
      type: 'chat',
      display: 'Implemented the requested change.',
      ts: 42,
    });
    expect(event).not.toHaveProperty('payload');
  });
});
