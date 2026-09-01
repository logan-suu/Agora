// Test seam: one case pauses the real MessageRuntime.initialize call to make the
// snapshot-to-subscription race deterministic; the JSON store, commit, and stream stay real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyMutations } from '@agora/core-domain';
import { decide, latestCoordinationLedger } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
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
  it('carries a persisted Leader assignment into one real Coordinator dispatch', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const postMessage = createPostMessage(runtime);

    const posted = await postMessage(
      postRequest({
        projectId: 'project-a',
        taskId: 'task-a',
        channelId: 'main',
        msgId: 'leader-assignment',
        display: '@REVIEWER inspect the cache contract',
      }),
    );
    await expect(posted.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'applied' },
    });

    const state = await runtime.store.load({ projectId: 'project-a', taskId: 'task-a' });
    expect(state).toBeDefined();
    if (state === undefined) throw new Error('expected persisted task state');
    const decision = decide(state, {
      roster: DEFAULT_ROSTER,
      newId: (() => {
        let id = 0;
        return () => `coordinator-${++id}`;
      })(),
      now: () => 1000,
    });

    expect(decision.route).toEqual({
      kind: 'worker',
      batch: [{ role: 'REVIEWER' }],
      parallel: false,
    });
    const dispatched = applyMutations(state, decision.mutations);
    expect(latestCoordinationLedger(dispatched)?.progress.instructionOrQuestion.answer).toBe(
      'inspect the cache contract',
    );
    expect(
      dispatched.messages.some(
        (message) =>
          message.fromRole === 'COORDINATOR' && message.payload.sourceMsgId === 'leader-assignment',
      ),
    ).toBe(true);
  });

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
    await expect(posted.json()).resolves.toEqual({
      accepted: true,
      action: { status: 'none' },
      published: true,
    });
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
      payload: {
        action: { status: 'none' },
        intent: { kind: 'chat', text: 'Ship the persisted flow.' },
        kind: 'leader_intent',
      },
    });
    expect(JSON.stringify(persisted?.messages[0]?.payload)).not.toContain('agent-only');
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
    await expect(replay.json()).resolves.toEqual({
      accepted: true,
      action: { status: 'none' },
      published: false,
    });

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

  it('bridges commits made while the persisted snapshot is opening into the live SSE tail', async () => {
    const stream = new ChannelStream();
    const runtime = createMessageRuntime(await temporaryRoot(), stream);
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const address = { ...scope, channelId: 'main' };
    await runtime.initialize(scope, 'Task task-a');

    const realInitialize = runtime.initialize.bind(runtime);
    let releaseSnapshot: (() => void) | undefined;
    const snapshotPaused = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let markSnapshotRead: (() => void) | undefined;
    const snapshotRead = new Promise<void>((resolve) => {
      markSnapshotRead = resolve;
    });
    let pauseNextInitialize = true;
    runtime.initialize = async (...args) => {
      const state = await realInitialize(...args);
      if (pauseNextInitialize) {
        pauseNextInitialize = false;
        markSnapshotRead?.();
        await snapshotPaused;
      }
      return state;
    };

    const opening = createGetStream(runtime)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    await snapshotRead;
    const subscriberCountDuringSnapshot = stream.subscriberCount(address);

    await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'during-open',
        display: 'Do not lose this message.',
        payload: { intent: 'chat' },
      }),
    );
    releaseSnapshot?.();

    const response = await opening;
    const reader = response.body?.getReader();
    const connected = decoder.decode((await reader?.read())?.value);
    const snapshot = decoder.decode((await reader?.read())?.value);
    const live = await Promise.race([
      reader?.read().then((result) => decoder.decode(result.value)),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);

    expect(subscriberCountDuringSnapshot).toBe(1);
    expect(connected).toContain('event: connected');
    expect(snapshot).toContain('event: snapshot');
    expect(snapshot).not.toContain('during-open');
    expect(live).toContain('event: message');
    expect(live).toContain('during-open');
    await reader?.cancel();
  });
});
