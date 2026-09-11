import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve only the selected Go credential; never copy it into benchmark artifacts. */
export async function resolveOpenCodeGoApiKey(
  options: { env?: Readonly<Record<string, string | undefined>>; authPath?: string } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  if (env.OPENCODE_API_KEY !== undefined) return validKey(env.OPENCODE_API_KEY);
  const path =
    options.authPath ??
    join(env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/auth.json');
  let auth: unknown;
  try {
    auth = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(
      'OpenCode Go credential unavailable; configure OPENCODE_API_KEY or connect opencode-go',
    );
  }
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth))
    throw new Error('invalid OpenCode Go credential configuration');
  const selected = (auth as Record<string, unknown>)['opencode-go'];
  if (
    typeof selected !== 'object' ||
    selected === null ||
    !('type' in selected) ||
    selected.type !== 'api' ||
    !('key' in selected)
  )
    throw new Error('OpenCode Go API credential is required; other providers are not a fallback');
  return validKey(selected.key);
}

function validKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\r\n]/.test(value))
    throw new Error('invalid OpenCode Go API credential');
  return value.trim();
}
