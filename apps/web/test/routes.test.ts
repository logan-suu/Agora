import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { POST as postCommand } from '../src/app/api/commands/route';
import { ChannelStream, channelStream } from '../src/server/channel-stream';
import { createGetStream, createPostMessage } from '../src/server/message-handlers';
import { createMessageRuntime } from '../src/server/message-runtime';

const decoder = new TextDecoder();
const roots: string[] = [];
const address = { projectId: 'project-a', taskId: 'task-a', channelId: 'main' };

async function testRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'agora-route-test-'));
  roots.push(root);
  const stream = new ChannelStream();
  return { runtime: createMessageRuntime(root, stream), stream };
}

afterEach(async () => {
  channelStream.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GET /api/stream', () => {
  it('rejects missing task scope', async () => {
    const { runtime } = await testRuntime();
    const response = await createGetStream(runtime)(
      new Request('http://localhost/api/stream?channelId=main'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'projectId, taskId, and channelId are required',
    });
  });

  it('opens an SSE stream with snapshot and releases its subscription when cancelled', async () => {
    const { runtime, stream } = await testRuntime();
    const response = await createGetStream(runtime)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    const reader = response.body?.getReader();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.subscriberCount(address)).toBe(1);
    expect(decoder.decode((await reader?.read())?.value)).toContain('event: connected');
    expect(decoder.decode((await reader?.read())?.value)).toBe('event: snapshot\ndata: []\n\n');

    await reader?.cancel();
    expect(stream.subscriberCount(address)).toBe(0);
  });

  it('does not retain a subscription for an already-aborted request', async () => {
    const { runtime, stream } = await testRuntime();
    const controller = new AbortController();
    controller.abort();

    const response = await createGetStream(runtime)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main', {
        signal: controller.signal,
      }),
    );

    expect(response.status).toBe(200);
    expect(stream.subscriberCount(address)).toBe(0);
  });

  it('closes an established SSE stream when its request is aborted', async () => {
    const { runtime, stream } = await testRuntime();
    const controller = new AbortController();
    const response = await createGetStream(runtime)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main', {
        signal: controller.signal,
      }),
    );
    const reader = response.body?.getReader();

    await reader?.read();
    await reader?.read();
    controller.abort();

    await expect(reader?.read()).resolves.toEqual({ done: true, value: undefined });
    expect(stream.subscriberCount(address)).toBe(0);
  });
});

describe('POST /api/messages', () => {
  it('rejects malformed message bodies', async () => {
    const { runtime } = await testRuntime();
    const response = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({ channelId: 'main', payload: 'hello' }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'projectId, taskId, channelId, msgId, display, and object payload are required',
    });
  });

  it('commits a valid leader message using server-owned identity', async () => {
    const { runtime } = await testRuntime();
    const response = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ...address,
          msgId: 'message-1',
          fromRole: 'ATTACKER',
          display: 'Go',
          payload: { text: 'Go' },
        }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, published: true });
    await expect(runtime.store.load(address)).resolves.toMatchObject({
      messages: [{ msgId: 'message-1', fromRole: 'leader', display: 'Go' }],
    });
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
    await expect(response.json()).resolves.toEqual({
      error: 'projectId, taskId, channelId, and command are required',
    });
  });

  it('publishes an opaque leader command within task scope', async () => {
    const events: unknown[] = [];
    channelStream.subscribe(address, (event) => events.push(event));

    const response = await postCommand(
      new Request('http://localhost/api/commands', {
        method: 'POST',
        body: JSON.stringify({ ...address, command: '@CODER implement the cache' }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, delivered: 1 });
    expect(events).toEqual([
      {
        type: 'command',
        data: { ...address, command: '@CODER implement the cache' },
      },
    ]);
  });
});
