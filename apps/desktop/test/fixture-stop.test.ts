// Delayed module doubles expose the validation fixture's IPC race; these are not G5 evidence.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('settles concurrent startup and stop with one stopped receipt and no late ready', async () => {
  const root = await mkdtemp('/private/tmp/agora113-fixture-');
  await writeFile(
    join(root, 'service.mjs'),
    `
    await new Promise(resolve => setTimeout(resolve, 100));
    export class DesktopService {
      async start() { return { origin: 'http://127.0.0.1:12345', credentials: 'ready' }; }
      async stop() {}
    }
  `,
  );
  await writeFile(join(root, 'store.mjs'), 'export const keychainStore = () => ({});');
  const child = fork(new URL('./fixtures/packaged-service.mjs', import.meta.url), [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const events: { type: string }[] = [];
  child.on('message', (message) => events.push(message as { type: string }));
  const exit = once(child, 'exit');
  try {
    child.send({
      type: 'start',
      module: pathToFileURL(join(root, 'service.mjs')).href,
      storeModule: pathToFileURL(join(root, 'store.mjs')).href,
      config: { helper: '/unused' },
    });
    child.send({ type: 'stop', version: 1 });
    child.send({ type: 'stop', version: 1 });
    expect(
      await Promise.race([
        exit.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
      ]),
    ).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['stopped']);
    expect(child.exitCode).toBe(0);
  } finally {
    if (child.connected) child.disconnect();
    await exit;
    await rm(root, { recursive: true });
  }
});

it('requests stop while the constructed service is still preparing', async () => {
  const root = await mkdtemp('/private/tmp/agora113-fixture-');
  await writeFile(
    join(root, 'service.mjs'),
    `
    export class DesktopService {
      async start() {
        const pending = new Promise(resolve => { this.finish = resolve; });
        process.send({ type: 'preparing' });
        await pending;
      }
      async stop() { this.finish?.(); }
    }
  `,
  );
  await writeFile(join(root, 'store.mjs'), 'export const keychainStore = () => ({});');
  const child = fork(new URL('./fixtures/packaged-service.mjs', import.meta.url), [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const events: { type: string }[] = [];
  child.on('message', (message) => events.push(message as { type: string }));
  const exit = once(child, 'exit');
  try {
    const preparing = once(child, 'message');
    child.send({
      type: 'start',
      module: pathToFileURL(join(root, 'service.mjs')).href,
      storeModule: pathToFileURL(join(root, 'store.mjs')).href,
      config: { helper: '/unused' },
    });
    await preparing;
    child.send({ type: 'stop', version: 1 });
    expect(
      await Promise.race([
        exit.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
      ]),
    ).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['preparing', 'stopped']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
    await rm(root, { recursive: true });
  }
});
