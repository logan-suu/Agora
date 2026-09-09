import { access, chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { connect, createServer as createControlServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlPath, keychainStore, runTool } from './local-process.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const web = resolve(repo, 'apps/web');
const helper = resolve(repo, `packages/runtime/state/build/keychain-${process.arch}`);
const action = process.argv[2] ?? 'start';
const args = process.argv.slice(3);
const explicit = process.env.AGORA_CREDENTIALS_KEY;
delete process.env.AGORA_CREDENTIALS_KEY;
const platformError = 'The Agora product launcher currently supports macOS only.';
let control;
let app;
let http;
let root;
let socketPath;
let ownsSocket = false;
const sockets = new Set();
const activeWrites = new Set();
let stopping;
let acceptingHttp = false;

async function diagnose(buildRequired) {
  if (process.platform !== 'darwin') throw new Error(platformError);
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('Install Node.js 24 before starting Agora.');
  const checks = [
    ['pnpm', ['--version']],
    ['git', ['--version']],
    ['/usr/bin/clang', ['--version']],
    ['docker', ['info', '--format', '{{.ServerVersion}}']],
  ];
  const results = await Promise.allSettled(
    checks.map(([tool, flags]) => runTool(tool, flags, repo)),
  );
  const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [checks[i][0]] : []));
  if (failures.length)
    throw new Error(
      `Check these dependencies before retrying: ${failures.join(', ')}. Docker Desktop must be running.`,
    );
  if (results[0].status !== 'fulfilled' || results[0].value !== '9.15.9')
    throw new Error('Use pnpm 9.15.9, as pinned in package.json.');
  if (buildRequired) {
    for (const path of [
      helper,
      resolve(
        repo,
        `packages/runtime/sandbox/build/secure-files-${process.platform}-${process.arch}`,
      ),
      resolve(web, '.next/BUILD_ID'),
    ]) {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error();
        await access(path);
      } catch {
        throw new Error('Build artifacts are missing or unsafe. Run pnpm run setup.');
      }
    }
  }
}
function portNumber() {
  if (args.length && (args.length !== 2 || args[0] !== '--port'))
    throw new Error('Usage: pnpm start [--port 3000]');
  const value = args.length ? args[1] : '3000';
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
    throw new Error('Choose a port from 1024 through 65535.');
  return Number(value);
}
async function stopRemote() {
  await new Promise((done, reject) => {
    const client = connect(socketPath);
    client.setTimeout(3000, () => {
      client.destroy();
      reject(new Error('Local control is unresponsive. Do not terminate an active model request.'));
    });
    client.once('connect', () => {
      client.setTimeout(0);
      client.end('stop\n');
    });
    let response = '';
    client.on('data', (data) => {
      response += data;
      if (response.length > 4096) client.destroy();
    });
    client.once('error', () =>
      reject(
        new Error(
          `No reachable Agora instance for this data directory. If a previous process crashed, verify it has exited before removing ${socketPath}.`,
        ),
      ),
    );
    client.once('close', () =>
      response.startsWith('stopped')
        ? done()
        : reject(
            new Error(
              'Agora is still draining or cleanup failed. Check its terminal and retry stop.',
            ),
          ),
    );
  });
}
async function shutdown() {
  if (stopping) return stopping;
  const boot = globalThis.__agoraLocalBootstrap;
  boot.draining = true;
  console.log('Stopping: waiting for active work to finish or reach its existing human gate…');
  stopping = (async () => {
    await ready;
    await Promise.allSettled([...activeWrites]);
    const results = await Promise.allSettled([...boot.drains].map((drain) => drain()));
    if (results.some((r) => r.status === 'rejected'))
      throw new Error('Resource cleanup failed. Keep this terminal open and retry stop.');
    acceptingHttp = false;
    const closed = http
      ? new Promise((done, reject) => http.close((error) => (error ? reject(error) : done())))
      : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    await closed;
    if (app) await app.close();
    console.log('Stopped. Data and Keychain credentials are retained.');
  })().catch((error) => {
    stopping = undefined;
    throw error;
  });
  return stopping;
}
let readyResolve;
const ready = new Promise((resolveReady) => {
  readyResolve = resolveReady;
});
export async function runLocal(system = keychainStore(helper)) {
  if (!['start', 'doctor', 'setup', 'stop', 'adopt-key'].includes(action))
    throw new Error('Use setup, doctor, start, stop, or adopt-key.');
  if (process.platform !== 'darwin') throw new Error(platformError);
  if (action !== 'start' && args.length) throw new Error('Unexpected command arguments.');
  if (action === 'setup') {
    await diagnose(false);
    await runTool('pnpm', ['build:sandbox-native'], repo, true);
    await runTool(
      process.execPath,
      ['packages/runtime/state/scripts/build-keychain.mjs'],
      repo,
      true,
    );
    await runTool('pnpm', ['--filter', '@agora/web', 'build'], repo, true);
    console.log('Setup complete. Run pnpm start.');
    return;
  }
  if (action === 'doctor') {
    await diagnose(true);
    console.log(
      'macOS, Node 24, pnpm, Git, clang, Docker and build artifacts are available. Keychain access is checked at startup.',
    );
    return;
  }
  await mkdir(resolve(process.env.AGORA_DATA_ROOT ?? resolve(repo, '.data')), { recursive: true });
  root = await realpath(resolve(process.env.AGORA_DATA_ROOT ?? resolve(repo, '.data')));
  socketPath = controlPath(root);
  if (action === 'stop') {
    await stopRemote();
    return;
  }
  const port = action === 'start' ? portNumber() : 0;
  await diagnose(true);
  process.env.AGORA_DATA_ROOT = root;
  process.env.NODE_ENV = 'production';
  process.env.NEXT_MANUAL_SIG_HANDLE = 'true';
  process.env.AGORA_LOCAL_LAUNCH = '1';
  let credentialReady;
  const credentialsInitialized = new Promise((done) => {
    credentialReady = done;
  });
  globalThis.__agoraLocalBootstrap = {
    system,
    credentialsReady: credentialReady,
    explicit,
    adopt: action === 'adopt-key',
    draining: false,
    drains: new Set(),
  };
  control = createControlServer({ allowHalfOpen: true }, (client) => {
    client.on('error', () => client.destroy());
    let request = '';
    client.setTimeout(3000, () => client.destroy());
    client.on('data', (data) => {
      request += data;
      if (request.length > 32) {
        client.destroy();
        return;
      }
      if (request === 'stop\n') {
        client.setTimeout(0);
        shutdown()
          .then(() => {
            client.end('stopped\n');
            control.close();
            process.exitCode = 0;
          })
          .catch((error) => {
            console.error(error.message);
            client.end('failed\n');
          });
      }
    });
  });
  await new Promise((done, reject) => {
    control.once('error', () =>
      reject(
        new Error(
          `Another instance or stale control socket exists: ${socketPath}. Use pnpm stop; after a crash, verify the previous process has exited before removing this socket.`,
        ),
      ),
    );
    control.listen(socketPath, done);
  });
  ownsSocket = true;
  await chmod(socketPath, 0o600);
  const next = createRequire(resolve(web, 'package.json'))('next');
  app = next({ dev: false, dir: web, hostname: '127.0.0.1', port });
  await app.prepare();
  let initializationTimer;
  try {
    await Promise.race([
      credentialsInitialized,
      new Promise((_, reject) => {
        initializationTimer = setTimeout(
          () =>
            reject(
              new Error(
                'Keychain initialization did not finish. Check macOS access prompts, then restart.',
              ),
            ),
          65000,
        );
      }),
    ]);
  } finally {
    clearTimeout(initializationTimer);
  }
  delete process.env.AGORA_CREDENTIALS_KEY;
  const credentialStatus = globalThis.__agoraLocalBootstrap.credentialStatus;
  if (!credentialStatus)
    throw new Error('Local credential initialization did not run. Rebuild with pnpm run setup.');
  if (action === 'adopt-key') {
    if (credentialStatus !== 'ready')
      throw new Error(
        `Key adoption failed (${credentialStatus}); existing records were not changed.`,
      );
    await app.close();
    control.close();
    console.log(
      'The existing key is available in macOS Keychain. No credentials were re-encrypted.',
    );
    readyResolve();
    return;
  }
  if (credentialStatus !== 'ready')
    console.warn(
      `Keychain credentials unavailable (${credentialStatus}). Open model settings for recovery instructions. No-auth connections remain available.`,
    );
  const handler = app.getRequestHandler();
  http = createHttpServer((request, response) => {
    if (
      !acceptingHttp ||
      (globalThis.__agoraLocalBootstrap.draining && !['GET', 'HEAD'].includes(request.method ?? ''))
    ) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Agora is stopping. Please wait for shutdown.' }));
      return;
    }
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (
      !hosts.has(host) ||
      (origin && origin !== `http://${host}`) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      response.writeHead(403);
      response.end('Use the local Agora address.');
      return;
    }
    const operation = Promise.resolve(handler(request, response));
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      activeWrites.add(operation);
      operation.finally(() => activeWrites.delete(operation)).catch(() => {});
    }
    operation.catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  http.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((done, reject) => {
    http.once('error', () =>
      reject(new Error(`Port ${port} is unavailable. Stop its owner or choose --port.`)),
    );
    http.listen(port, '127.0.0.1', done);
  });
  acceptingHttp = true;
  readyResolve();
  console.log(`Agora is ready at http://127.0.0.1:${port}. Stop with pnpm stop or Ctrl+C.`);
  const onSignal = () =>
    shutdown()
      .then(() => control.close())
      .catch((error) => console.error(error.message));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
export async function reportStartupFailure(error) {
  readyResolve();
  console.error(error.message ?? 'Local startup failed. Run pnpm run doctor.');
  if (http) http.close();
  if (app) await app.close().catch(() => {});
  if (control) control.close();
  if (ownsSocket) await unlink(socketPath).catch(() => {});
  process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocal().catch(reportStartupFailure);
}
