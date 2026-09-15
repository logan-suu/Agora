// Controlled Next preparation exercises stop races; real packaged Next/Keychain is G5.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopService } from '../src/service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('desktop startup cancellation', () => {
  it('wakes a readiness wait when stopped without waiting for the credential timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora113-ready-stop-'));
    roots.push(root);
    let prepared!: () => void;
    const entered = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    let closes = 0;
    const service = new DesktopService(
      { stateRoot: root, webRoot: root, helper: '/unused', capability: 'a'.repeat(64) },
      {
        system: { read: async () => undefined, create: async (key) => key },
        next: () => ({
          prepare: async () => {
            prepared();
          },
          close: async () => {
            closes++;
          },
          getRequestHandler: () => async () => {},
        }),
      },
    );
    const starting = service.start();
    await entered;
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = service.stop();
    try {
      expect(
        await Promise.race([
          stopping.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 200)),
        ]),
      ).toBe(true);
      expect(await starting).toBeUndefined();
      expect(closes).toBe(1);
    } finally {
      (
        globalThis as unknown as { __agoraLocalBootstrap: { credentialsReady(): void } }
      ).__agoraLocalBootstrap.credentialsReady();
      await starting;
      await stopping;
    }
  });
  it('keeps ownership until active credential operations settle and refuses late writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora113-key-stop-'));
    roots.push(root);
    let finishRead!: () => void;
    let enteredRead!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const read = new Promise<undefined>((resolve) => {
      finishRead = () => resolve(undefined);
    });
    let closes = 0,
      creates = 0;
    let initialization!: Promise<void>;
    const service = new DesktopService(
      { stateRoot: root, webRoot: root, helper: '/unused', capability: 'a'.repeat(64) },
      {
        system: {
          read: () => {
            enteredRead();
            return read;
          },
          create: async (key) => {
            creates++;
            return key;
          },
        },
        next: () => ({
          prepare: async () => {
            const boot = (
              globalThis as unknown as {
                __agoraLocalBootstrap: {
                  system: { read(): Promise<unknown>; create(key: string): Promise<string> };
                  credentialsReady(): void;
                };
              }
            ).__agoraLocalBootstrap;
            initialization = boot.system
              .read()
              .then(() => boot.system.create('test-only'))
              .then(
                () => {},
                () => {},
              )
              .finally(() => boot.credentialsReady());
          },
          close: async () => {
            closes++;
          },
          getRequestHandler: () => async () => {},
        }),
      },
    );
    const starting = service.start();
    await entered;
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = service.stop();
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closes).toBe(1);
      expect(service.stopped).toBe(false);
      expect(await readFile(join(root, '.desktop-owner'), 'utf8')).toContain('pid');
    } finally {
      finishRead();
      await initialization;
      await starting;
      await stopping;
    }
    expect(creates).toBe(0);
    expect(service.stopped).toBe(true);
  });
  it('retains ownership when resource cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora113-cleanup-'));
    roots.push(root);
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failed = false;
    const service = new DesktopService(
      { stateRoot: root, webRoot: root, helper: '/unused', capability: 'a'.repeat(64) },
      {
        system: { read: async () => undefined, create: async (key) => key },
        next: () => ({
          prepare: async () => {
            entered();
            await gate;
          },
          close: async () => {
            if (!failed) {
              failed = true;
              throw new Error('cleanup rejected');
            }
          },
          getRequestHandler: () => async (_req, res) => {
            res.end();
          },
        }),
      },
    );
    const starting = service.start();
    await preparing;
    const stopping = service.stop();
    release();
    await starting;
    await expect(stopping).rejects.toThrow('cleanup rejected');
    expect(service.stopped).toBe(false);
    await service.stop();
    expect(service.stopped).toBe(true);
  });
  it('stops during preparation without late readiness or leaking state ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora113-service-'));
    roots.push(root);
    let prepared!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const enteredPrepare = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closes = 0;
    const service = new DesktopService(
      { stateRoot: root, webRoot: root, helper: '/unused', capability: 'a'.repeat(64) },
      {
        system: { read: async () => undefined, create: async (key) => key },
        next: () => ({
          prepare: async () => {
            entered();
            await waiting;
          },
          close: async () => {
            closes++;
          },
          getRequestHandler: () => async (_req, res) => {
            res.end();
          },
        }),
      },
    );
    const starting = service.start();
    await enteredPrepare;
    const stopping = service.stop();
    prepared();
    expect(await starting).toBeUndefined();
    await stopping;
    await service.stop();
    expect(closes).toBe(1);
    expect(service.stopped).toBe(true);
  });
});
