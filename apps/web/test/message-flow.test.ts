// Test seam: one case pauses the real TaskStateStore.load call to make the
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
import { createMessageRuntime, getOrCreateMessageRuntime } from '../src/server/message-runtime';

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
  it('reuses one process runtime across separately bundled route modules', async () => {
    const root = await temporaryRoot();
    const registry: { messageRuntime: ReturnType<typeof createMessageRuntime> | undefined } = {
      messageRuntime: undefined,
    };
    let createCount = 0;
    const create = () => {
      createCount += 1;
      return createMessageRuntime(root, new ChannelStream());
    };

    const first = getOrCreateMessageRuntime(registry, create);
    const second = getOrCreateMessageRuntime(registry, create);

    expect(second).toBe(first);
    expect(createCount).toBe(1);
  });

  it('carries a persisted Leader assignment into one real Coordinator dispatch', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    await runtime.initialize({ projectId: 'project-a', taskId: 'task-a' }, 'Task task-a');
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

  it('persists the project main registry and addresses a registered sub channel', async () => {
    const root = await temporaryRoot();
    const runtime = createMessageRuntime(root, new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const initial = await runtime.channels.load(scope.projectId);
    if (initial === undefined) throw new Error('expected initialized project channels');
    await runtime.channels.commit(scope.projectId, initial.revision, [
      ...initial.channels,
      {
        channelId: 'sub-task-a',
        kind: 'sub',
        taskId: scope.taskId,
        participants: ['leader', 'CODER'],
        localContext: [],
        closed: false,
      },
    ]);

    const response = await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'sub-task-a',
        msgId: 'leader-sub-message',
        display: 'Please inspect this privately.',
      }),
    );

    expect(response.status).toBe(202);
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      messages: [{ msgId: 'leader-sub-message', channelId: 'sub-task-a', fromRole: 'leader' }],
    });
    await expect(createMessageRuntime(root).channels.load(scope.projectId)).resolves.toMatchObject({
      revision: 1,
      channels: [{ channelId: 'main' }, { channelId: 'sub-task-a' }],
    });
  });

  it('rejects invalid browser Channel scope without persisting or streaming a message', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const initial = await runtime.channels.load(scope.projectId);
    if (initial === undefined) throw new Error('expected initialized project channels');
    await runtime.channels.commit(scope.projectId, initial.revision, [
      ...initial.channels,
      {
        channelId: 'other-task',
        kind: 'sub',
        taskId: 'task-b',
        participants: ['leader', 'CODER'],
        localContext: [],
        closed: false,
      },
      {
        channelId: 'closed-task-a',
        kind: 'sub',
        taskId: 'task-a',
        participants: ['leader', 'CODER'],
        localContext: [],
        closed: true,
      },
    ]);
    const streamed: unknown[] = [];
    const unsubscribe = runtime.stream.subscribe(
      { ...scope, channelId: 'closed-task-a' },
      (event) => streamed.push(event),
    );

    for (const channelId of ['missing', 'other-task', 'closed-task-a']) {
      const response = await createPostMessage(runtime)(
        postRequest({
          ...scope,
          channelId,
          msgId: `invalid-${channelId}`,
          display: 'This must be rejected.',
        }),
      );
      expect(response.status).toBe(400);
    }

    const invalidStream = await createGetStream(runtime)(
      new Request(
        'http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=other-task',
      ),
    );
    expect(invalidStream.status).toBe(400);
    expect(runtime.stream.subscriberCount({ ...scope, channelId: 'other-task' })).toBe(0);
    await expect(runtime.store.load(scope)).resolves.toMatchObject({ messages: [] });
    expect(streamed).toEqual([]);
    unsubscribe();
  });

  it('server-stamps leader, persists payload, and streams only the display envelope', async () => {
    const stream = new ChannelStream();
    const runtime = createMessageRuntime(await temporaryRoot(), stream);
    await runtime.initialize({ projectId: 'project-a', taskId: 'task-a' }, 'Task task-a');
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
    await firstRuntime.initialize({ projectId: 'project-a', taskId: 'task-a' }, 'Task task-a');
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

    const realLoad = runtime.store.load.bind(runtime.store);
    let releaseSnapshot: (() => void) | undefined;
    const snapshotPaused = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let markSnapshotRead: (() => void) | undefined;
    const snapshotRead = new Promise<void>((resolve) => {
      markSnapshotRead = resolve;
    });
    let pauseNextLoad = true;
    runtime.store.load = async (...args) => {
      const state = await realLoad(...args);
      if (pauseNextLoad) {
        pauseNextLoad = false;
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
