import { describe, expect, it } from 'vitest';
import { DockerSandbox } from '../src/docker-sandbox';
import { createSandbox } from '../src/factory';
import { LocalTempSandbox } from '../src/local-temp-sandbox';

// Pure construction tests — no daemon contact (the Docker client is lazy).

describe('createSandbox (config-driven LocalTemp/Docker switching, decision D5)', () => {
  it('defaults to the LocalTempSandbox (Phase 0 behavior preserved)', () => {
    const sandbox = createSandbox();
    expect(sandbox).toBeInstanceOf(LocalTempSandbox);
  });

  it('returns LocalTempSandbox for { kind: "local" }', () => {
    const sandbox = createSandbox({ kind: 'local' });
    expect(sandbox).toBeInstanceOf(LocalTempSandbox);
  });

  it('returns DockerSandbox for { kind: "docker" }', () => {
    const sandbox = createSandbox({ kind: 'docker' });
    expect(sandbox).toBeInstanceOf(DockerSandbox);
  });

  it('forwards docker options (image/network/memory) to the Docker implementation', () => {
    const sandbox = createSandbox({
      kind: 'docker',
      image: 'node:20-slim',
      networkMode: 'bridge',
      memoryBytes: 256 * 1024 * 1024,
      cpuShares: 256,
    });
    expect(sandbox).toBeInstanceOf(DockerSandbox);
  });
});
