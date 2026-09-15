import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { requestAllowed } from './protocol.js';

export interface PreviewStatus {
  credentials: string;
  toolchain?: { state: 'ready'; versions: Record<string, string> };
}
export function createPreviewServer(
  capability: string,
  status: () => PreviewStatus,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) {
  let closing = false;
  const sockets = new Set<Socket>();
  const streams = new Set<ServerResponse>();
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (closing) {
      res.writeHead(503).end();
      return;
    }
    if (!requestAllowed(req.headers, origin(), capability)) {
      res.writeHead(403).end();
      return;
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (
      !['GET', 'HEAD'].includes(req.method ?? '') ||
      !(
        (/^\/_next\/static\/[A-Za-z0-9_./-]+$/.test(path) && !path.includes('..')) ||
        ['/desktop', '/api/desktop/status', '/api/desktop/events'].includes(path)
      )
    ) {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'preview_only' }));
      return;
    }
    const nonce = randomBytes(24).toString('base64');
    const csp = `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
    req.headers['content-security-policy'] = csp;
    res.setHeader('content-security-policy', csp);
    if (path === '/api/desktop/status') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status()));
      return;
    }
    if (path === '/api/desktop/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      streams.add(res);
      res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      res.once('close', () => {
        clearInterval(timer);
        streams.delete(res);
      });
      return;
    }
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return {
    server,
    origin,
    async close() {
      closing = true;
      for (const stream of streams) stream.end();
      const closed = server.listening
        ? new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
