// IPC fixture supplies deterministic faults using real child processes, not G5 substitutes.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { observeServiceNavigation, ServiceLifecycle } from '../src/service-lifecycle.js';

const fixture = fileURLToPath(new URL('./fixtures/service.mjs', import.meta.url));
describe('desktop service lifecycle', () => {
  it('does not turn an intentional stop into a window failure when navigation rejects late', async () => {
    const child = fork(fixture, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const lifecycle = new ServiceLifecycle(child, { type: 'start' });
    await once(lifecycle, 'ready');
    const failures: string[] = [];
    await observeServiceNavigation(
      lifecycle,
      Promise.reject(new Error('real_load_failure')),
      () => true,
      async () => {
        failures.push('active');
      },
    );
    expect(failures).toEqual(['active']);
    let reject!: (error: Error) => void;
    const navigation = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const observed = observeServiceNavigation(
      lifecycle,
      navigation,
      () => true,
      async () => {
        failures.push('late');
      },
    );
    const stopped = lifecycle.stop();
    reject(new Error('ERR_CONNECTION_RESET'));
    await observed;
    await stopped;
    expect(lifecycle.state).toBe('stopped');
    expect(child.exitCode).toBe(0);
    expect(failures).toEqual(['active']);
  });

  it('does not equate stopped receipt with process exit or send stop twice', async () => {
    const child = fork(fixture, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const lifecycle = new ServiceLifecycle(child, { type: 'start' });
    await once(lifecycle, 'ready');
    expect(lifecycle.state).toBe('ready');
    const receipt = once(lifecycle, 'receipt');
    let reentrant: Promise<void> | undefined;
    lifecycle.once('changed', () => {
      reentrant = lifecycle.stop();
    });
    const first = lifecycle.stop();
    expect(reentrant).toBe(first);
    expect(lifecycle.stop()).toBe(first);
    await receipt;
    expect(lifecycle.state).toBe('draining');
    expect(lifecycle.exited).toBe(false);
    await first;
    expect(lifecycle.exited).toBe(true);
    expect(lifecycle.state).toBe('stopped');
    await lifecycle.stop();
  });

  it('reports an unexpected exit as failure', async () => {
    const child = fork(fixture, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const lifecycle = new ServiceLifecycle(child, { type: 'start', mode: 'crash' });
    await once(lifecycle, 'exited');
    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.failure).toBe('service_exited');
    await expect(lifecycle.stop()).rejects.toThrow('service_exited');
  });
});
