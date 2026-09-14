// Isolated packaging probe only: startup and shutdown share one lifecycle.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keychainStore } from './local-process.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const web = resolve(root, 'apps/web');
const next = createRequire(resolve(web, 'package.json'))('next');
const sockets = new Set();
let app, http, token, startup, shutdown;
let stopping = false;

function send(message) {
  if (process.connected) process.send(message, () => {});
}

async function start(msg) {
  token = msg.token;
  process.env.AGORA_DATA_ROOT = msg.dataRoot;
  process.env.NODE_ENV = 'production';
  process.env.AGORA_LOCAL_LAUNCH = '1';
  process.env.NEXT_MANUAL_SIG_HANDLE = 'true';
  let complete;
  const credentialsReady = new Promise(resolveReady => { complete = resolveReady; });
  globalThis.__agoraLocalBootstrap = {
    system: keychainStore(msg.helper, { keychain: msg.keychain, service: 'com.agora.spike.112', account: 'spike' }),
    adopt: false, draining: false, drains: new Set(), credentialsReady: complete,
  };
  const conf = createRequire(import.meta.url)(resolve(web, '.next/required-server-files.json')).config;
  app = next({ dev: false, dir: web, hostname: '127.0.0.1', port: 0, conf });
  await app.prepare();
  if (stopping) return;
  await credentialsReady;
  if (stopping) return;
  if (globalThis.__agoraLocalBootstrap.credentialStatus !== 'ready') throw new Error('credentials not ready');
  const handler = app.getRequestHandler();
  http = createServer((req, res) => {
    const origin = 'http://' + req.headers.host;
    if (stopping || req.headers['x-agora-spike'] !== token ||
        req.headers.host !== `127.0.0.1:${http.address().port}` ||
        (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    handler(req, res);
  });
  http.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolveReady, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolveReady);
  });
  if (!stopping) send({ type: 'ready', port: http.address().port, node: process.version,
    credentials: globalThis.__agoraLocalBootstrap.credentialStatus });
}

function stop() {
  stopping = true;
  if (shutdown) return shutdown;
  // If preparation never settles, the owning probe terminates this isolated
  // process group after its deadline; no product model work runs here.
  shutdown = (async () => {
    await startup;
    const bootstrap = globalThis.__agoraLocalBootstrap;
    if (bootstrap) {
      bootstrap.draining = true;
      await Promise.all([...bootstrap.drains].map(drain => drain()));
    }
    for (const socket of sockets) socket.destroy();
    if (http?.listening) await new Promise((resolveClosed, reject) => {
      http.close(error => error ? reject(error) : resolveClosed());
    });
    if (app) await app.close();
    send({ type: 'stopped' });
  })().catch(() => {
    send({ type: 'error', message: 'probe shutdown failed' });
    process.exitCode = 1;
  }).finally(() => {
    if (process.connected) process.disconnect();
  });
  return shutdown;
}

process.on('message', msg => {
  if (msg.type === 'start' && !startup && !stopping) {
    startup = start(msg).catch(() => {
      send({ type: 'error', message: 'probe startup failed' });
      process.exitCode = 1;
    });
  } else if (msg.type === 'stop') {
    void stop();
  }
});
process.on('disconnect', () => { void stop(); });
