import { toDisplayMessageEvent } from '@agora/comm-bus';

import { encodeSseEvent } from './channel-stream';
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
    const payload = objectRecord(body?.payload);

    if (!projectId || !taskId || !channelId || !msgId || !display || !payload) {
      return jsonError(
        'projectId, taskId, channelId, msgId, display, and object payload are required',
      );
    }
    if (channelId !== 'main') {
      return jsonError('Phase 5 only supports channelId "main"');
    }

    const scope = { projectId, taskId };
    await runtime.initialize(scope, `Task ${taskId}`);
    const result = await runtime.commitMessage(scope, {
      msgId,
      channelId,
      fromRole: 'leader',
      type: 'chat',
      payload,
      display,
      ts: Date.now(),
    });

    return Response.json({ accepted: true, published: result.published }, { status: 202 });
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
    if (channelId !== 'main') {
      return jsonError('Phase 5 only supports channelId "main"');
    }

    const scope = { projectId, taskId };
    const address = { ...scope, channelId };
    const state = await runtime.initialize(scope, `Task ${taskId}`);
    const snapshot = state.messages
      .filter((message) => message.channelId === channelId)
      .map((message) => toDisplayMessageEvent({ ...scope, message }));

    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let active = true;
        const send = (frame: string) => {
          if (active) controller.enqueue(encoder.encode(frame));
        };
        const unsubscribe = runtime.stream.subscribe(address, (event) => {
          send(encodeSseEvent(event));
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
        request.signal.addEventListener('abort', closeForAbort, { once: true });

        if (request.signal.aborted) {
          closeForAbort();
          return;
        }

        send(encodeSseEvent({ type: 'connected', data: address }));
        send(encodeSseEvent({ type: 'snapshot', data: snapshot }));
      },
      cancel() {
        cleanup();
      },
    });

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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
