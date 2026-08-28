import Dockerode from 'dockerode';
import type { DockerSandboxOptions } from './docker-sandbox';
import { DockerSandbox } from './docker-sandbox';
import { LocalTempSandbox } from './local-temp-sandbox';
import type { SandboxManager } from './sandbox-manager';

/** Configuration-driven sandbox selection (decision D5 phase advance). */
export type SandboxConfig = { kind: 'local' } | ({ kind: 'docker' } & DockerSandboxOptions);

/**
 * Build the configured {@link SandboxManager}.
 *
 * Defaults to `{ kind: 'local' }` so Phase 0 callers keep working unchanged
 * (decision R9: interface-first, Phase degradation swaps the body). Phase 1
 * callers pass `{ kind: 'docker', ... }` for the Docker implementation.
 */
export function createSandbox(config: SandboxConfig = { kind: 'local' }): SandboxManager {
  switch (config.kind) {
    case 'local':
      return new LocalTempSandbox();
    case 'docker': {
      const { kind: _kind, ...options } = config;
      return new DockerSandbox(options);
    }
  }
}

export type { DockerSandboxOptions };
export { Dockerode };
