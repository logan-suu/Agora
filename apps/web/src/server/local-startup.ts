import { resolve } from 'node:path';
import {
  credentialGuidance,
  initializeLocalCredentials,
  type LocalCredentials,
  type SystemCredentialStore,
} from '@agora/runtime-state';

export interface LocalBootstrap {
  system: SystemCredentialStore;
  explicit?: string;
  adopt: boolean;
  draining: boolean;
  drains: Set<() => Promise<void>>;
  credentialStatus?: string;
  credentialsReady?: () => void;
}
const processState = globalThis as typeof globalThis & {
  __agoraLocalBootstrap?: LocalBootstrap;
  __agoraLocalCredentials?: Map<string, { ready: Promise<void>; value?: LocalCredentials }>;
};
export function localBootstrap() {
  return processState.__agoraLocalBootstrap;
}
export function localCredentials(root: string) {
  const bootstrap = localBootstrap();
  if (!bootstrap) return undefined;
  processState.__agoraLocalCredentials ??= new Map();
  const registry = processState.__agoraLocalCredentials;
  const path = resolve(root);
  let entry = registry.get(path);
  if (!entry) {
    const created: { ready: Promise<void>; value?: LocalCredentials } = {
      ready: Promise.resolve(),
    };
    created.ready = initializeLocalCredentials(
      path,
      bootstrap.system,
      bootstrap.explicit,
      bootstrap.adopt,
    ).then((value) => {
      created.value = value;
      bootstrap.credentialStatus = value.status;
      bootstrap.credentialsReady?.();
    });
    registry.set(path, created);
    entry = created;
  }
  return entry;
}
export function localCredentialMessage(root: string): string | undefined {
  const value = localCredentials(root)?.value;
  return value && value.status !== 'ready' ? credentialGuidance[value.status] : undefined;
}
export async function registerLocalStartup() {
  if (localBootstrap())
    await localCredentials(process.env.AGORA_DATA_ROOT ?? resolve(process.cwd(), '../../.data'))
      ?.ready;
}
