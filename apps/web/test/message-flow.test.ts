import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../src/server/channel-stream';
import { createGetStream, createPostMessage } from '../src/server/message-handlers';
import { createMessageRuntime } from '../src/server/message-runtime';

const decoder = new TextDecoder();
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-web-message-flow-test-'));
  roots.push(root);
  return root;
}

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persisted HTTP + SSE message flow', () => {
  it('server-stamps leader, persists payload, and streams only the display envelope', async () => {
    const stream = new ChannelStream();
    const runtime = createMessageRuntime(await temporaryRoot(), stream);
    const openStream = createGetStream(runtime);
    const postMessage = createPostMessage(runtime);
    const response = await openStream(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.read();

    const posted = await postMessage(
      postRequest({
        projectId: 'project-a',
        taskId: 'task-a',
        channelId: 'main',
        msgId: 'stable-message-1',
        fromRole: 'ATTACKER',
        display: 'Ship the persisted flow.',
        payload: { intent: 'implement', secret: 'agent-only' },
      }),
    );

    expect(posted.status).toBe(202);
    await expect(posted.json()).resolves.toEqual({ accepted: true, published: true });
    const live = decoder.decode((await reader?.read())?.value);
    expect(live).toContain('event: message');
    expect(live).toContain('"fromRole":"leader"');
    expect(live).toContain('"display":"Ship the persisted flow."');
    expect(live).not.toContain('payload');
    expect(live).not.toContain('agent-only');

    const persisted = await runtime.store.load({ projectId: 'project-a', taskId: 'task-a' });
    expect(persisted?.messages[0]).toMatchObject({
      msgId: 'stable-message-1',
      fromRole: 'leader',
      payload: { intent: 'implement', secret: 'agent-only' },
    });
    await reader?.cancel();
  });

  it('recovers a payload-free snapshot through a fresh runtime and suppresses msgId replays', async () => {
    const root = await temporaryRoot();
    const firstStream = new ChannelStream();
    const firstRuntime = createMessageRuntime(root, firstStream);
    const postMessage = createPostMessage(firstRuntime);
    const body = {
      projectId: 'project-a',
      taskId: 'task-a',
      channelId: 'main',
      msgId: 'stable-message-1',
      display: 'Recover this after restart.',
      payload: { secret: 'never-stream-this' },
    };

    await postMessage(postRequest(body));
    const replay = await postMessage(postRequest(body));
    await expect(replay.json()).resolves.toEqual({ accepted: true, published: false });

    const restarted = createMessageRuntime(root, new ChannelStream());
    const response = await createGetStream(restarted)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    const snapshot = decoder.decode((await reader?.read())?.value);

    expect(snapshot).toContain('event: snapshot');
    expect(snapshot).toContain('"msgId":"stable-message-1"');
    expect(snapshot).toContain('"display":"Recover this after restart."');
    expect(snapshot).not.toContain('payload');
    expect(snapshot).not.toContain('never-stream-this');
    await reader?.cancel();
  });
});
