import { afterEach, describe, expect, it } from 'vitest';

import { POST as postCommand } from '../src/app/api/commands/route';
import { POST as postMessage } from '../src/app/api/messages/route';
import { GET as openStream } from '../src/app/api/stream/route';
import { channelStream } from '../src/server/channel-stream';

const decoder = new TextDecoder();

afterEach(() => {
  channelStream.clear();
});

describe('GET /api/stream', () => {
  it('rejects a missing channelId', async () => {
    const response = openStream(new Request('http://localhost/api/stream'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'channelId is required' });
  });

  it('opens an SSE stream and releases its subscription when cancelled', async () => {
    const response = openStream(new Request('http://localhost/api/stream?channelId=main'));
    const reader = response.body?.getReader();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(channelStream.subscriberCount('main')).toBe(1);

    const first = await reader?.read();
    expect(decoder.decode(first?.value)).toBe('event: connected\ndata: {"channelId":"main"}\n\n');

    await reader?.cancel();
    expect(channelStream.subscriberCount('main')).toBe(0);
  });

  it('does not retain a subscription for an already-aborted request', () => {
    const controller = new AbortController();
    controller.abort();

    const response = openStream(
      new Request('http://localhost/api/stream?channelId=main', { signal: controller.signal }),
    );

    expect(response.status).toBe(200);
    expect(channelStream.subscriberCount('main')).toBe(0);
  });

  it('closes an established SSE stream when its request is aborted', async () => {
    const controller = new AbortController();
    const response = openStream(
      new Request('http://localhost/api/stream?channelId=main', {
        signal: controller.signal,
      }),
    );
    const reader = response.body?.getReader();

    await reader?.read();
    controller.abort();

    await expect(reader?.read()).resolves.toEqual({ done: true, value: undefined });
    expect(channelStream.subscriberCount('main')).toBe(0);
  });
});

describe('POST /api/messages', () => {
  it('rejects malformed message bodies', async () => {
    const response = await postMessage(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({ channelId: 'main', fromRole: '', payload: 'hello' }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'channelId, fromRole, and payload are required',
    });
  });

  it('publishes a valid message to the selected channel', async () => {
    const events: unknown[] = [];
    channelStream.subscribe('main', (event) => events.push(event));

    const response = await postMessage(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({ channelId: 'main', fromRole: 'leader', payload: { text: 'Go' } }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, delivered: 1 });
    expect(events).toEqual([
      {
        type: 'message',
        data: { channelId: 'main', fromRole: 'leader', payload: { text: 'Go' } },
      },
    ]);
  });
});

describe('POST /api/commands', () => {
  it('rejects malformed command bodies', async () => {
    const response = await postCommand(
      new Request('http://localhost/api/commands', {
        method: 'POST',
        body: JSON.stringify({ channelId: 'main', command: '   ' }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'channelId and command are required' });
  });

  it('publishes an opaque leader command without interpreting intent', async () => {
    const events: unknown[] = [];
    channelStream.subscribe('main', (event) => events.push(event));

    const response = await postCommand(
      new Request('http://localhost/api/commands', {
        method: 'POST',
        body: JSON.stringify({ channelId: 'main', command: '@CODER implement the cache' }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, delivered: 1 });
    expect(events).toEqual([
      {
        type: 'command',
        data: { channelId: 'main', command: '@CODER implement the cache' },
      },
    ]);
  });
});
