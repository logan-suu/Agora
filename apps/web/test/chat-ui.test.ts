import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  applyMention,
  fetchChannelRegistry,
  fetchTaskRuntime,
  filterMentionOptions,
  leaderActionNoticeFromResponse,
  mergeMessageById,
  nextMessageTimestamp,
  prepareMessageSubmission,
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

  it('reuses the msgId when retrying the same logical message', () => {
    let sequence = 0;
    const createId = () => `message-${++sequence}`;
    const first = prepareMessageSubmission(undefined, 'Ship it.', createId);
    const retry = prepareMessageSubmission(first, 'Ship it.', createId);
    const changed = prepareMessageSubmission(first, 'Ship it safely.', createId);

    expect(retry).toBe(first);
    expect(retry.msgId).toBe('message-1');
    expect(changed).toEqual({ display: 'Ship it safely.', msgId: 'message-2' });
  });

  it('turns rejected and deferred Leader actions into visible notices', () => {
    expect(
      leaderActionNoticeFromResponse({
        action: { status: 'rejected', reason: 'unknown role "UNKNOWN"' },
      }),
    ).toEqual({ kind: 'rejected', text: 'Command rejected: unknown role "UNKNOWN"' });
    expect(
      leaderActionNoticeFromResponse({
        action: {
          status: 'deferred',
          targetPhase: 6,
          reason: 'dynamic sub channels are implemented in Phase 6',
        },
      }),
    ).toEqual({
      kind: 'deferred',
      text: 'Command deferred to Phase 6: dynamic sub channels are implemented in Phase 6',
    });
    expect(leaderActionNoticeFromResponse({ action: { status: 'none' } })).toBeUndefined();
  });

  it('rejects malformed message responses instead of swallowing action status', () => {
    expect(() => leaderActionNoticeFromResponse({ accepted: true })).toThrow(
      'invalid Leader action response',
    );
  });

  it('surfaces task polling transport and HTTP failures', async () => {
    await expect(
      fetchTaskRuntime('/api/tasks', async () => {
        throw new Error('network unavailable');
      }),
    ).rejects.toThrow('network unavailable');
    await expect(
      fetchTaskRuntime('/api/tasks', async () =>
        Response.json({ error: 'task backend unavailable' }, { status: 503 }),
      ),
    ).rejects.toThrow('task backend unavailable');
  });

  it('preserves the HTTP status when a channel error body is not JSON', async () => {
    await expect(
      fetchChannelRegistry(
        '/api/channels',
        async () => new Response('Service unavailable', { status: 503 }),
      ),
    ).rejects.toThrow('Channel refresh failed (503)');
  });

  it('loads only validated channel display metadata', async () => {
    await expect(
      fetchChannelRegistry('/api/channels', async () =>
        Response.json({
          channels: [
            {
              channelId: 'main',
              kind: 'main',
              participants: ['leader', 'CODER'],
              closed: false,
            },
            {
              channelId: 'sub-task-a-action-1',
              kind: 'sub',
              taskId: 'task-a',
              threadId: 'action-1',
              topic: 'Cache race',
              createdBy: 'CODER',
              participants: ['leader', 'CODER'],
              closed: true,
              localContext: [{ msgId: 'must-not-cross-read-model' }],
            },
          ],
        }),
      ),
    ).resolves.toEqual([
      { id: 'main', name: 'main', kind: 'main', closed: false },
      {
        id: 'sub-task-a-action-1',
        name: 'Cache race',
        kind: 'sub',
        closed: true,
      },
    ]);
  });
});

describe('ChatWorkspace', () => {
  it('renders the required workspace regions and never renders payload data', () => {
    const model: WorkspaceViewModel = {
      task: { id: '5.2', title: 'Group chat UI', status: 'In progress' },
      channel: { id: 'main-room', name: 'main-room' },
      channels: [
        { id: 'main-room', name: 'main-room', kind: 'main', closed: false },
        { id: 'sub-task-a', name: 'Cache race', kind: 'sub', closed: true },
      ],
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
    expect(visibleText).toContain('Cache race');
    expect(visibleText).toContain('closed');
    expect(html).toContain('Team');
    expect(html).toContain('Current task');
    expect(html).toContain('Active workers');
    expect(visibleText).toContain('@CODER tighten the cache eviction tests before review.');
    expect(html).not.toContain('RAW_PAYLOAD_MUST_NOT_RENDER');
    expect(html).toContain('aria-label="Message the team"');
    expect(visibleText).toContain('Idle');
    expect(visibleText).not.toContain('Live');
    expect(visibleText).not.toContain('Collapse');
  });
});
