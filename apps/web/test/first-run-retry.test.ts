// Creation is stubbed only to exercise promise caching; native preparation and
// resource ownership are covered by phase12-6 with real services and grants.
import { afterEach, expect, it, vi } from 'vitest';
import { FirstRunService, firstRunService } from '../src/server/first-run';

const globals = globalThis as typeof globalThis & { __agoraLocalBootstrap?: unknown };
const original = globals.__agoraLocalBootstrap;
afterEach(() => {
  globals.__agoraLocalBootstrap = original;
  vi.restoreAllMocks();
});
it('retries a rejected initialization and shares the successful in-flight creation', async () => {
  const drains = new Set<() => Promise<void>>();
  const boot = { desktop: {}, draining: false, drains };
  globals.__agoraLocalBootstrap = boot;
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const instance = { drain: cleanup } as unknown as FirstRunService;
  let finish!: (service: FirstRunService) => void;
  const initialization = new Promise<FirstRunService>((resolve) => {
    finish = resolve;
  });
  const create = vi
    .spyOn(FirstRunService, 'create')
    .mockRejectedValueOnce(Error('toolchain_temporarily_unavailable'))
    .mockReturnValueOnce(initialization);
  await expect(firstRunService()).rejects.toThrow('toolchain_temporarily_unavailable');
  expect(drains.size).toBe(0);
  const second = firstRunService();
  expect(firstRunService()).toBe(second);
  expect(drains.size).toBe(1);
  boot.draining = true;
  const stopping = Promise.all([...drains].map((drain) => drain()));
  await Promise.resolve();
  expect(cleanup).not.toHaveBeenCalled();
  finish(instance);
  await expect(second).resolves.toBe(instance);
  await stopping;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledTimes(2);
});
