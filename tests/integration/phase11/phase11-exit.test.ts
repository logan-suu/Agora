// Next readiness is controlled and tool bytes are synthetic to isolate admission failures.
// State, integrity, upgrades, HTTP/SSE and cleanup use production modules and real I/O.
// These tests do not replace packaged Electron/Next/native Keychain/toolchain G5.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopService } from '../../../apps/desktop/src/service.js';
import { acquireState, initializeFormat } from '../../../apps/desktop/src/storage.js';
import { inventoryToolchain } from '../../../apps/desktop/src/toolchain-installation.js';
import { toolVersions } from '../../../apps/desktop/src/toolchains.js';
import { applyUpgrade, recoverUpgrade } from '../../../apps/desktop/src/upgrades.js';

const roots: string[] = [];
const services: DesktopService[] = [];
const originalRoot = process.env.AGORA_DATA_ROOT;
const originalPreview = process.env.AGORA_DESKTOP_PREVIEW;
const globals = globalThis as typeof globalThis & {
  __agoraLocalBootstrap?: { credentialStatus?: string; credentialsReady(): void };
};
const originalBootstrap = globals.__agoraLocalBootstrap;
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (originalRoot === undefined) delete process.env.AGORA_DATA_ROOT;
  else process.env.AGORA_DATA_ROOT = originalRoot;
  if (originalPreview === undefined) delete process.env.AGORA_DESKTOP_PREVIEW;
  else process.env.AGORA_DESKTOP_PREVIEW = originalPreview;
  if (originalBootstrap === undefined) delete globals.__agoraLocalBootstrap;
  else globals.__agoraLocalBootstrap = originalBootstrap;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agora115-exit-'));
  roots.push(root);
  const tools = join(root, 'tools');
  for (const name of [
    'node/bin/node',
    'node/lib/node_modules/npm/bin/npm-cli.js',
    'pnpm/bin/pnpm.cjs',
    'git/bin/git',
    'keychain',
    'secure-files',
  ]) {
    await mkdir(dirname(join(tools, name)), { recursive: true });
    await writeFile(join(tools, name), `integrity fixture: ${name}`, { mode: 0o700 });
  }
  for (const name of ['git/libexec/git-core', 'git/share/git-core/templates', 'bin'])
    await mkdir(join(tools, name), { recursive: true });
  await writeFile(
    join(tools, 'manifest.json'),
    JSON.stringify({
      format: 1,
      arch: process.arch,
      platform: 'darwin',
      versions: toolVersions,
      files: await inventoryToolchain(tools),
    }),
  );
  return { root, tools, state: join(root, 'state') };
}

function serviceFor(f: Awaited<ReturnType<typeof fixture>>) {
  let prepares = 0;
  let handled = 0;
  let closes = 0;
  const capability = randomBytes(32).toString('hex');
  const service = new DesktopService(
    {
      stateRoot: f.state,
      toolchainRoot: f.tools,
      helper: join(f.tools, 'keychain'),
      webRoot: f.root,
      capability,
    },
    {
      next: () => ({
        async prepare() {
          prepares++;
          const boot = globals.__agoraLocalBootstrap;
          if (!boot) throw new Error('missing_bootstrap');
          boot.credentialStatus = 'locked';
          boot.credentialsReady();
        },
        async close() {
          closes++;
        },
        getRequestHandler: () => async (_request, response) => {
          handled++;
          response.end('controlled Next response');
        },
      }),
    },
  );
  services.push(service);
  return { service, capability, counters: () => ({ prepares, handled, closes }) };
}

describe('Phase 11 exit composition', () => {
  it('admits only authenticated preview traffic and releases a live SSE connection before reopening state', async () => {
    const f = await fixture();
    const first = serviceFor(f);
    const ready = await first.service.start();
    expect(ready?.credentials).toBe('locked');
    const origin = ready?.origin as string;
    const headers = { 'x-agora-desktop': first.capability };
    const expected = {
      credentials: 'locked',
      toolchain: { state: 'ready', versions: toolVersions },
    };
    expect(await (await fetch(`${origin}/api/desktop/status`, { headers })).json()).toEqual(
      expected,
    );
    const duplicate = serviceFor(f);
    await expect(duplicate.service.start()).rejects.toThrow('state_in_use');
    expect(duplicate.counters().prepares).toBe(0);
    await duplicate.service.stop();
    await expect(acquireState(f.state)).rejects.toThrow('state_in_use');
    expect((await fetch(`${origin}/api/desktop/status`)).status).toBe(403);
    expect(
      (
        await fetch(`${origin}/api/desktop/status`, {
          headers: { ...headers, origin: 'https://example.invalid' },
        })
      ).status,
    ).toBe(403);
    for (const endpoint of [
      'tasks',
      'messages',
      'model-settings',
      'channels',
      'traces',
      'stream',
    ]) {
      expect((await fetch(`${origin}/api/${endpoint}`, { headers })).status).toBe(403);
      expect(
        (await fetch(`${origin}/api/${endpoint}`, { headers, method: 'POST', body: '{}' })).status,
      ).toBe(403);
    }
    expect(first.counters().handled).toBe(0);
    const stream = await fetch(`${origin}/api/desktop/events`, { headers });
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(
      JSON.stringify(expected),
    );
    const ended = reader?.read().then(
      (chunk) => chunk.done,
      () => true,
    );
    await first.service.stop();
    expect(await ended).toBe(true);
    expect(first.service.stopped).toBe(true);
    expect(first.counters().closes).toBe(1);
    await expect(stat(join(f.state, '.desktop-owner'))).rejects.toMatchObject({ code: 'ENOENT' });
    const second = serviceFor(f);
    const restarted = await second.service.start();
    expect(restarted?.credentials).toBe('locked');
    expect((await fetch(`${restarted?.origin}/api/desktop/status`, { headers })).status).toBe(403);
    expect(await readFile(join(f.state, 'desktop-format.json'), 'utf8')).toBe('{"version":1}\n');
  });

  it('rejects a corrupted bundled tool before state ownership or Next initialization', async () => {
    const f = await fixture();
    await writeFile(join(f.tools, 'node/bin/node'), 'corrupted');
    const probe = serviceFor(f);
    await expect(probe.service.start()).rejects.toThrow('toolchain_node_invalid');
    expect(probe.counters().prepares).toBe(0);
    await expect(stat(f.state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks readiness after an interrupted upgrade, then preserves bytes and root identity through rollback and restart', async () => {
    const f = await fixture();
    const owner = await acquireState(f.state);
    await initializeFormat(owner.root);
    const beforeRoot = await stat(owner.root);
    const bytes = Buffer.from(
      '{"projectId":"p1","revision":7,"encryptedKey":"synthetic-ciphertext"}\n',
    );
    await writeFile(join(owner.root, 'connections.json'), bytes, { mode: 0o600 });
    const migration = {
      id: 'exit-interruption',
      from: 1,
      to: 2,
      sourceVersion: 'fixture-1',
      converterVersion: 'fixture-2',
      files: ['connections.json'],
      transform: (_path: string, source: Buffer) => Buffer.concat([source, Buffer.from(' ')]),
    };
    try {
      await expect(
        applyUpgrade(owner, migration, (point) => {
          if (point === 'file:0') throw new Error('injected_interruption');
        }),
      ).rejects.toThrow('injected_interruption');
    } finally {
      await owner.release();
    }
    const blocked = serviceFor(f);
    await expect(blocked.service.start()).rejects.toThrow('upgrade_requires_quiescence');
    expect(blocked.counters().prepares).toBe(0);
    await blocked.service.stop();
    const recovery = await acquireState(f.state);
    try {
      await recoverUpgrade(recovery, migration, 'rollback');
    } finally {
      await recovery.release();
    }
    const restarted = serviceFor(f);
    expect((await restarted.service.start())?.credentials).toBe('locked');
    expect(await readFile(join(f.state, 'connections.json'))).toEqual(bytes);
    expect(await stat(f.state)).toMatchObject({ dev: beforeRoot.dev, ino: beforeRoot.ino });
  });
});
