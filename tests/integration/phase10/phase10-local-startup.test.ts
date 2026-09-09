// OS authorization failures use a locked, disposable Keychain; the user's Keychain is never modified.
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  initializeLocalCredentials,
  type SystemCredentialStore,
} from '../../../packages/runtime/state/src/local-credentials';
import { JsonModelConfigStore } from '../../../packages/runtime/state/src/model-config-store';

const exec = promisify(execFile);
const helper = resolve(`packages/runtime/state/build/keychain-${process.arch}`);
function invoke(args: string[], input?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(helper, args, { timeout: 15000 }, (error, stdout) => {
      if (error && typeof error.code !== 'number') {
        reject(new Error('Keychain helper unavailable'));
        return;
      }
      resolveResult({
        code: typeof error?.code === 'number' ? error.code : 0,
        output: stdout.trim(),
      });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}
it('uses real macOS Keychain for first setup, restart decryption, concurrent create and locked storage', async () => {
  if (process.platform !== 'darwin') {
    await expect(exec(process.execPath, ['apps/web/scripts/local.mjs', 'doctor'])).rejects.toThrow(
      'macOS only',
    );
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'agora-keychain-g5-'));
  const path = join(root, 'test.keychain-db');
  const password = randomBytes(24).toString('hex');
  const service = `com.agora.test.${randomUUID()}`;
  const port: SystemCredentialStore = {
    read: async () => {
      const r = await invoke(['read', service, 'test', path]);
      if (r.code === 10) return undefined;
      if (r.code)
        throw Object.assign(new Error('OS failure'), {
          code: r.code === 12 ? 'locked' : 'unavailable',
        });
      return r.output;
    },
    create: async (key) => {
      const r = await invoke(['create', service, 'test', path], key);
      if (r.code) throw new Error('OS create failed');
      return r.output;
    },
  };
  let created = false;
  const failures: unknown[] = [];
  try {
    await exec('/usr/bin/security', ['create-keychain', '-p', password, path]);
    created = true;
    await exec('/usr/bin/security', ['unlock-keychain', '-p', password, path]);
    const initial = await initializeLocalCredentials(root, port);
    expect(initial.status).toBe('ready');
    const store = new JsonModelConfigStore(root, initial.key);
    const record = await store.createConnection(
      'p',
      { baseURL: 'https://example.com/v1', contextWindow: 32768, maxTokens: 4096 },
      'test-api-secret',
    );
    const restarted = await initializeLocalCredentials(root, port);
    expect(restarted.key() === initial.key()).toBe(true);
    expect(await new JsonModelConfigStore(root, restarted.key).resolveKey('p', record.id)).toBe(
      'test-api-secret',
    );
    const winners = await Promise.all(
      Array.from({ length: 4 }, () => port.create(randomBytes(32).toString('base64'))),
    );
    expect(winners.every((key) => key === initial.key())).toBe(true);
    await exec('/usr/bin/security', ['lock-keychain', path]);
    expect((await initializeLocalCredentials(root, port)).status).toBe('locked');
    await exec('/usr/bin/security', ['unlock-keychain', '-p', password, path]);
    expect((await initializeLocalCredentials(root, port)).key() === initial.key()).toBe(true);
    await exec('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', 'test', path]);
    expect((await initializeLocalCredentials(root, port)).status).toBe('missing');
    expect(await port.read()).toBeUndefined();
    await port.create(randomBytes(32).toString('base64'));
    expect((await initializeLocalCredentials(root, port)).status).toBe('mismatch');
  } catch (error) {
    failures.push(error);
  } finally {
    if (created)
      await exec('/usr/bin/security', ['delete-keychain', path]).catch((error) =>
        failures.push(error),
      );
    await rm(root, { recursive: true, force: true }).catch((error) => failures.push(error));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Keychain G5 or cleanup failed');
}, 30000);
