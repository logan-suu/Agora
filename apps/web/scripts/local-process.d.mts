import type { SystemCredentialStore } from '../../../packages/runtime/state/src/local-credentials';
export function childEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function controlPath(root: string): string;
export function keychainStore(
  helper: string,
  options?: { service?: string; account?: string; keychain?: string },
): SystemCredentialStore;
export function runTool(
  command: string,
  args: string[],
  cwd: string,
  visible?: boolean,
): Promise<string>;
