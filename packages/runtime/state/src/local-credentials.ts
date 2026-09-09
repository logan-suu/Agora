import { randomBytes } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonModelConfigStore } from './model-config-store';

export interface SystemCredentialStore {
  read(): Promise<string | undefined>;
  /** Create if absent, returning the canonical winner without overwriting it. */
  create(key: string): Promise<string>;
}
export type CredentialStatus =
  | 'ready'
  | 'missing'
  | 'invalid'
  | 'mismatch'
  | 'locked'
  | 'denied'
  | 'unavailable'
  | 'ambiguous'
  | 'history_invalid';
export interface LocalCredentials {
  status: CredentialStatus;
  key(): string | undefined;
}
export const credentialGuidance: Record<CredentialStatus, string> = {
  ready: 'Credentials are available.',
  missing: 'Restore the original Agora Keychain item before using saved API keys.',
  invalid:
    'The encryption key format is invalid. Correct any advanced override, or restore the original Keychain item, then restart Agora.',
  mismatch:
    'Restore the original encryption key for this data directory. Existing credentials were not changed.',
  locked: 'Unlock your macOS login Keychain, then restart Agora.',
  denied: 'Allow Agora to access your macOS Keychain, then restart Agora.',
  unavailable:
    'Start Agora with pnpm start after pnpm run setup. Check Keychain access and restart.',
  ambiguous: 'Multiple Agora Keychain items conflict. Restore the original item before restarting.',
  history_invalid:
    'Saved model configuration is damaged or has unsafe paths. Restore a valid data backup before restarting.',
};

/** Validate every immutable connection, including versions retained only by old tasks. */
export async function inspectCredentialHistory(
  root: string,
): Promise<{ project: string; id: string }[]> {
  const encrypted: { project: string; id: string }[] = [];
  const store = new JsonModelConfigStore(root, () => undefined);
  for (const project of await directoryEntries(join(root, 'projects'))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(project)) throw new Error('invalid project');
    await requireDirectory(join(root, 'projects', project));
    for (const file of await directoryEntries(
      join(root, 'projects', project, 'model-connections'),
    )) {
      if (/^\.model-[A-Za-z0-9-]+\.tmp$/.test(file)) throw new Error('unfinished credential write');
      if (!file.endsWith('.json')) throw new Error('invalid connection file');
      const id = file.slice(0, -5);
      const connection = await store.loadConnection(project, id);
      if (connection.auth.kind === 'encrypted') encrypted.push({ project, id });
    }
  }
  return encrypted;
}
async function requireDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe directory');
}
async function directoryEntries(path: string): Promise<string[]> {
  try {
    await requireDirectory(path);
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function validKey(key: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').toString('base64') === key;
}
const unavailable = (status: CredentialStatus): LocalCredentials => ({
  status,
  key: () => undefined,
});

/** All OS access is injected by the trusted local launcher; no subprocesses in the store. */
export async function initializeLocalCredentials(
  root: string,
  system: SystemCredentialStore,
  explicit?: string,
  adopt = false,
): Promise<LocalCredentials> {
  if ((explicit !== undefined && !validKey(explicit)) || (adopt && explicit === undefined))
    return unavailable('invalid');
  let history: Awaited<ReturnType<typeof inspectCredentialHistory>>;
  try {
    history = await inspectCredentialHistory(root);
  } catch {
    return unavailable('history_invalid');
  }
  try {
    let key = explicit ?? (await system.read());
    if (key === undefined) {
      if (history.length) return unavailable('missing');
      key = await system.create(randomBytes(32).toString('base64'));
    }
    if (!validKey(key)) return unavailable('invalid');
    const store = new JsonModelConfigStore(root, () => key);
    try {
      for (const connection of history) await store.resolveKey(connection.project, connection.id);
    } catch {
      return unavailable('mismatch');
    }
    if (adopt) {
      const existing = await system.read();
      if (existing !== undefined && existing !== key) return unavailable('mismatch');
      const saved = existing ?? (await system.create(key));
      if (saved !== key) return unavailable('mismatch');
    }
    return { status: 'ready', key: () => key };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return unavailable(
      code === 'locked' || code === 'denied' || code === 'ambiguous' || code === 'invalid'
        ? code
        : 'unavailable',
    );
  }
}
