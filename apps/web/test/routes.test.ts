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
  const runtime = createMessageRuntime(root, stream);
  await runtime.initialize(address, 'Task task-a');
  return { runtime, stream };
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

  it('does not create a placeholder task when the stream scope is unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-route-test-'));
    roots.push(root);
    const runtime = createMessageRuntime(root, new ChannelStream());

    const response = await createGetStream(runtime)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=missing&channelId=main'),
    );

    expect(response.status).toBe(404);
    await expect(
      runtime.store.load({ projectId: 'project-a', taskId: 'missing' }),
    ).resolves.toBeUndefined();
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
      error: 'projectId, taskId, channelId, msgId, and display are required',
    });
  });

  it('rejects an unsafe msgId before reading task state or applying side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-route-test-'));
    roots.push(root);
    const runtime = createMessageRuntime(root, new ChannelStream());

    const response = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ...address,
          taskId: 'missing',
          msgId: 'unsafe/message',
          display: 'Go',
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'msgId must be a safe stable token',
    });
    await expect(
      runtime.store.load({ projectId: 'project-a', taskId: 'missing' }),
    ).resolves.toBeUndefined();
  });

  it('does not create a placeholder task for an unknown message scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-route-test-'));
    roots.push(root);
    const runtime = createMessageRuntime(root, new ChannelStream());

    const response = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({ ...address, taskId: 'missing', msgId: 'message-1', display: 'Go' }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(
      runtime.store.load({ projectId: 'project-a', taskId: 'missing' }),
    ).resolves.toBeUndefined();
  });

  it('commits chat with server-owned identity and payload', async () => {
    const { runtime } = await testRuntime();
    const response = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ...address,
          msgId: 'message-1',
          fromRole: 'ATTACKER',
          display: 'Go',
          payload: { intent: 'forged', secret: 'do-not-trust' },
        }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      action: { status: 'none' },
      published: true,
    });
    await expect(runtime.store.load(address)).resolves.toMatchObject({
      messages: [
        {
          msgId: 'message-1',
          fromRole: 'leader',
          display: 'Go',
          payload: {
            action: { status: 'none' },
            intent: { kind: 'chat', text: 'Go' },
            kind: 'leader_intent',
          },
        },
      ],
    });
  });

  it('atomically applies a valid leading role assignment', async () => {
    const { runtime } = await testRuntime();
    const response = await createPostMessage(runtime)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ...address,
          msgId: 'message-assign',
          display: '@coder implement the cache',
        }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      action: { status: 'applied' },
      published: true,
    });
    await expect(runtime.store.load(address)).resolves.toMatchObject({
      nextRole: 'CODER',
      messages: [
        {
          msgId: 'message-assign',
          payload: {
            intent: {
              kind: 'assign',
              targetRole: 'CODER',
              instruction: 'implement the cache',
            },
          },
        },
      ],
    });
  });

  it('returns explicit rejected and deferred action states without fake mutations', async () => {
    const { runtime } = await testRuntime();
    const post = createPostMessage(runtime);
    const unknown = await post(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({ ...address, msgId: 'unknown', display: '@UNKNOWN work' }),
      }),
    );
    const deferred = await post(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ...address,
          msgId: 'deferred',
          display: '/approve gate-1',
        }),
      }),
    );

    await expect(unknown.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'rejected', reason: expect.stringContaining('UNKNOWN') },
    });
    await expect(deferred.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'rejected', reason: expect.stringContaining('unknown') },
    });
    const persisted = await runtime.store.load(address);
    expect(persisted).not.toHaveProperty('nextRole');
    expect(persisted?.messages).toMatchObject([{ msgId: 'unknown' }, { msgId: 'deferred' }]);
  });
});

describe('POST /api/commands', () => {
  it('is retired and never publishes an ephemeral command event', async () => {
    const events: unknown[] = [];
    channelStream.subscribe(address, (event) => events.push(event));
    const response = await postCommand(
      new Request('http://localhost/api/commands', {
        method: 'POST',
        body: JSON.stringify({ ...address, command: '@CODER implement the cache' }),
      }),
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: 'POST /api/commands is retired; send Leader messages through POST /api/messages',
    });
    expect(events).toEqual([]);
  });
});
