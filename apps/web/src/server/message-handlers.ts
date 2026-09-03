import { toDisplayMessageEvent } from '@agora/comm-bus';
import { resolveParticipantChannel } from '@agora/comm-channels';

import { isSafeMessageId } from '../lib/intent';
import { type ChannelEvent, encodeSseEvent } from './channel-stream';
import { jsonError, readJsonObject, requiredString } from './http';
import type { MessageRuntime } from './message-runtime';

const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

export function createPostMessage(runtime: MessageRuntime) {
  return async function postMessage(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    const projectId = requiredString(body?.projectId);
    const taskId = requiredString(body?.taskId);
    const channelId = requiredString(body?.channelId);
    const msgId = requiredString(body?.msgId);
    const display = requiredString(body?.display);

    if (!projectId || !taskId || !channelId || !msgId || !display) {
      return jsonError('projectId, taskId, channelId, msgId, and display are required');
    }
    if (!isSafeMessageId(msgId)) return jsonError('msgId must be a safe stable token');
    const scope = { projectId, taskId };
    if ((await runtime.store.load(scope)) === undefined) {
      return jsonError('task not found; create it through POST /api/tasks first', 404);
    }
    const project = await runtime.ensureProjectChannels(projectId);
    try {
      const channel = resolveParticipantChannel(project, taskId, 'leader', channelId);
      if (channel.closed) return jsonError(`channel "${channelId}" is closed`);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : 'invalid channel address');
    }
    const result = await runtime.commitLeaderMessage(scope, {
      msgId,
      channelId,
      display,
      ts: Date.now(),
    });

    return Response.json(
      { accepted: true, published: result.published, action: result.action },
      { status: 202 },
    );
  };
}

export function createGetStream(runtime: MessageRuntime) {
  return async function getStream(request: Request): Promise<Response> {
    const search = new URL(request.url).searchParams;
    const projectId = requiredString(search.get('projectId'));
    const taskId = requiredString(search.get('taskId'));
    const channelId = requiredString(search.get('channelId'));
    if (!projectId || !taskId || !channelId) {
      return jsonError('projectId, taskId, and channelId are required');
    }
    const scope = { projectId, taskId };
    const address = { ...scope, channelId };
    let cleanup = () => {};
    let sendBootstrap = (_snapshot: unknown[]) => {};
    let failStream = (_error: unknown) => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let active = true;
        let bootstrapped = false;
        const buffered: ChannelEvent[] = [];
        const send = (frame: string) => {
          if (active) controller.enqueue(encoder.encode(frame));
        };
        const unsubscribe = runtime.stream.subscribe(address, (event) => {
          if (bootstrapped) {
            send(encodeSseEvent(event));
          } else {
            buffered.push(event);
          }
        });
        const heartbeat = setInterval(() => send(': heartbeat\n\n'), HEARTBEAT_INTERVAL_MS);

        const closeForAbort = () => {
          cleanup();
          controller.close();
        };
        cleanup = () => {
          if (!active) return;
          active = false;
          clearInterval(heartbeat);
          unsubscribe();
          request.signal.removeEventListener('abort', closeForAbort);
        };
        sendBootstrap = (snapshot) => {
          if (!active) return;
          send(encodeSseEvent({ type: 'connected', data: address }));
          send(encodeSseEvent({ type: 'snapshot', data: snapshot }));
          bootstrapped = true;
          for (const event of buffered) send(encodeSseEvent(event));
          buffered.length = 0;
        };
        failStream = (error) => {
          if (!active) return;
          cleanup();
          controller.error(error);
        };
        request.signal.addEventListener('abort', closeForAbort, { once: true });

        if (request.signal.aborted) {
          closeForAbort();
          return;
        }
      },
      cancel() {
        cleanup();
      },
    });

    try {
      const state = await runtime.store.load(scope);
      if (state === undefined) {
        cleanup();
        return jsonError('task not found; create it through POST /api/tasks first', 404);
      }
      const project = await runtime.ensureProjectChannels(projectId);
      try {
        resolveParticipantChannel(project, taskId, 'leader', channelId);
      } catch (error) {
        cleanup();
        return jsonError(error instanceof Error ? error.message : 'invalid channel address');
      }
      const snapshot = state.messages
        .filter((message) => message.channelId === channelId)
        .map((message) => toDisplayMessageEvent({ ...scope, message }));
      sendBootstrap(snapshot);
    } catch (error) {
      failStream(error);
      throw error;
    }

    return new Response(body, {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      },
    });
  };
}

export function createGetChannels(runtime: MessageRuntime) {
  return async function getChannels(request: Request): Promise<Response> {
    const search = new URL(request.url).searchParams;
    const projectId = requiredString(search.get('projectId'));
    const taskId = requiredString(search.get('taskId'));
    if (!projectId || !taskId) return jsonError('projectId and taskId are required');
    if ((await runtime.store.load({ projectId, taskId })) === undefined) {
      return jsonError('task not found; create it through POST /api/tasks first', 404);
    }
    const snapshot = await runtime.ensureProjectChannels(projectId);
    const channels = snapshot.channels
      .filter((channel) => channel.kind === 'main' || channel.taskId === taskId)
      .map((channel) =>
        channel.kind === 'main'
          ? {
              channelId: channel.channelId,
              kind: channel.kind,
              participants: channel.participants,
              closed: channel.closed,
            }
          : {
              channelId: channel.channelId,
              kind: channel.kind,
              taskId: channel.taskId,
              threadId: channel.threadId,
              topic: channel.topic,
              participants: channel.participants,
              closed: channel.closed,
            },
      );
    return Response.json({ channels });
  };
}
