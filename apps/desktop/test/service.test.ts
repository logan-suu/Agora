// Controlled Next preparation exercises stop races; real packaged Next/Keychain is G5.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopService } from '../src/service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('desktop startup cancellation', () => {
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
