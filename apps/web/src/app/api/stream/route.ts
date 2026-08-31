import { channelStream, encodeSseEvent } from '../../../server/channel-stream';
import { jsonError, requiredString } from '../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

export function GET(request: Request): Response {
  const channelId = requiredString(new URL(request.url).searchParams.get('channelId'));
  if (!channelId) {
    return jsonError('channelId is required');
  }

  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let active = true;
      const send = (frame: string) => {
        if (active) {
          controller.enqueue(encoder.encode(frame));
        }
      };
      const unsubscribe = channelStream.subscribe(channelId, (event) => {
        send(encodeSseEvent(event));
      });
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), HEARTBEAT_INTERVAL_MS);

      const closeForAbort = () => {
        cleanup();
        controller.close();
      };
      cleanup = () => {
        if (!active) {
          return;
        }
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

      send(encodeSseEvent({ type: 'connected', data: { channelId } }));
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
}
