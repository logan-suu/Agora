import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  applyMention,
  filterMentionOptions,
  mergeMessageById,
  nextMessageTimestamp,
  sortMessagesByTimestamp,
  type WorkspaceViewModel,
} from '../src/app/chat-model';
import { ChatWorkspace } from '../src/app/chat-workspace';

describe('chat UI model', () => {
  it('sorts messages chronologically without mutating the source array', () => {
    const messages = [
      {
        msgId: 'later',
        fromRole: 'CODER',
        display: 'Later update',
        ts: 20,
      },
      {
        msgId: 'earlier',
        fromRole: 'LEADER',
        display: 'Earlier direction',
        ts: 10,
      },
    ];

    expect(sortMessagesByTimestamp(messages).map((message) => message.msgId)).toEqual([
      'earlier',
      'later',
    ]);
    expect(messages.map((message) => message.msgId)).toEqual(['later', 'earlier']);
  });

  it('filters mention options case-insensitively and replaces only the active mention', () => {
    expect(filterMentionOptions('te')).toEqual(['TESTER']);
    expect(applyMention('Ask @co to verify', 'CODER')).toBe('Ask @CODER to verify');
  });

  it('places a locally sent message after the latest rendered message', () => {
    expect(nextMessageTimestamp([{ ts: 500 }, { ts: 900 }], 100)).toBe(901);
    expect(nextMessageTimestamp([{ ts: 500 }], 700)).toBe(700);
  });

  it('merges repeated SSE messages by stable msgId', () => {
    const original = [{ msgId: 'message-1', fromRole: 'leader', display: 'old', ts: 1 }];
    const next = mergeMessageById(original, {
      msgId: 'message-1',
      fromRole: 'leader',
      display: 'committed',
      ts: 2,
    });

    expect(next).toEqual([{ msgId: 'message-1', fromRole: 'leader', display: 'committed', ts: 2 }]);
    expect(original[0]?.display).toBe('old');
  });
});

describe('ChatWorkspace', () => {
  it('renders the required workspace regions and never renders payload data', () => {
    const model: WorkspaceViewModel = {
      task: { id: '5.2', title: 'Group chat UI', status: 'In progress' },
      channel: { id: 'main-room', name: 'main-room' },
      team: [
        { role: 'LEADER', name: 'Leader (You)', status: 'online' },
        { role: 'CODER', name: 'Coder', status: 'active' },
      ],
      activeWorkers: [{ role: 'CODER', name: 'Coder', detail: 'Implementing UI' }],
      messages: [
        {
          msgId: 'message-1',
          fromRole: 'LEADER',
          display: '@CODER tighten the cache eviction tests before review.',
          payload: { secret: 'RAW_PAYLOAD_MUST_NOT_RENDER' },
          ts: 1_788_179_120_000,
        },
      ],
    };

    const html = renderToStaticMarkup(createElement(ChatWorkspace, { model }));
    const visibleText = html.replace(/<[^>]+>/g, '');

    expect(html).toContain('Channels');
    expect(html).toContain('Team');
    expect(html).toContain('Current task');
    expect(html).toContain('Active workers');
    expect(visibleText).toContain('@CODER tighten the cache eviction tests before review.');
    expect(html).not.toContain('RAW_PAYLOAD_MUST_NOT_RENDER');
    expect(html).toContain('aria-label="Message the team"');
    expect(visibleText).toContain('Connecting');
    expect(visibleText).not.toContain('Live');
    expect(visibleText).not.toContain('Collapse');
  });
});
