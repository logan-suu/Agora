// The OS port is simulated only for denied/locked/error states; native Keychain G5 is separate.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { initializeLocalCredentials, type SystemCredentialStore } from '../src/local-credentials';
import { JsonModelConfigStore } from '../src/model-config-store';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'agora-local-key-'));
  roots.push(root);
  return root;
}
function system(initial?: string) {
  let value = initial;
  let creates = 0;
  const port: SystemCredentialStore = {
    read: async () => value,
    create: async (candidate) => {
      creates++;
      value ??= candidate;
      return value;
    },
  };
  return { port, value: () => value, creates: () => creates };
}
const options = { baseURL: 'https://example.com/v1', contextWindow: 32768, maxTokens: 4096 };

it('creates once, reuses the winning system key concurrently and decrypts after restart', async () => {
  const root = await directory();
  const os = system();
  const states = await Promise.all(
    Array.from({ length: 4 }, () => initializeLocalCredentials(root, os.port)),
  );
  expect(states.every((s) => s.status === 'ready' && s.key() === os.value())).toBe(true);
  const store = new JsonModelConfigStore(root, () => states[0]?.key());
  const saved = await store.createConnection('p', options, 'private-api-key');
  const restarted = await initializeLocalCredentials(root, os.port);
  expect(restarted.status).toBe('ready');
  expect(await new JsonModelConfigStore(root, restarted.key).resolveKey('p', saved.id)).toBe(
    'private-api-key',
  );
});

it('never creates a replacement for missing or mismatched historical keys, even unreferenced connections', async () => {
  const root = await directory();
  const original = randomBytes(32).toString('base64');
  await new JsonModelConfigStore(root, () => original).createConnection('old', options, 'secret');
  for (const key of [undefined, randomBytes(32).toString('base64')]) {
    const os = system(key);
    const result = await initializeLocalCredentials(root, os.port);
    expect(result.status).toBe(key ? 'mismatch' : 'missing');
    expect(result.key()).toBeUndefined();
    expect(os.creates()).toBe(0);
  }
});

it('gives explicit environment settings precedence without silently falling back or changing Keychain', async () => {
  const root = await directory();
  const original = randomBytes(32).toString('base64');
  const os = system(original);
  for (const key of ['', 'invalid', original.slice(0, -1)]) {
    expect((await initializeLocalCredentials(root, os.port, key)).status).toBe('invalid');
  }
  const supplied = randomBytes(32).toString('base64');
  expect((await initializeLocalCredentials(root, os.port, supplied)).key()).toBe(supplied);
  expect(os.value()).toBe(original);
  expect(os.creates()).toBe(0);
});

it('reports OS failures safely and keeps unauthenticated records usable', async () => {
  const root = await directory();
  for (const code of ['locked', 'denied', 'unavailable', 'ambiguous']) {
    const result = await initializeLocalCredentials(root, {
      read: async () => {
        throw Object.assign(new Error('sensitive raw OS error'), { code });
      },
      create: async () => {
        throw new Error('unexpected creation');
      },
    });
    expect(result.status).toBe(code);
    expect(Object.keys(result).sort()).toEqual(['key', 'status']);
    expect(result.key()).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('sensitive');
    const store = new JsonModelConfigStore(root, result.key);
    const c = await store.createConnection('p', options);
    expect(await store.resolveKey('p', c.id)).toBeUndefined();
  }
});

it('rejects malformed or symlinked history rather than interpreting it as a clean install', async () => {
  const root = await directory();
  const os = system();
  await mkdir(join(root, 'projects/p/model-connections'), { recursive: true });
  await writeFile(join(root, 'projects/p/model-connections/broken.json'), '{');
  expect((await initializeLocalCredentials(root, os.port)).status).toBe('history_invalid');
  expect(os.creates()).toBe(0);
  const linked = await directory();
  await symlink(join(root, 'projects'), join(linked, 'projects'));
  expect((await initializeLocalCredentials(linked, os.port)).status).toBe('history_invalid');
  expect(os.creates()).toBe(0);
});

it('imports an explicit key only after history validation and refuses to overwrite another key', async () => {
  const root = await directory();
  const key = randomBytes(32).toString('base64');
  await new JsonModelConfigStore(root, () => key).createConnection('p', options, 'secret');
  const os = system();
  expect((await initializeLocalCredentials(root, os.port, key, true)).status).toBe('ready');
  expect(os.value()).toBe(key);
  expect((await initializeLocalCredentials(root, os.port, key, true)).status).toBe('ready');
  const conflicting = system(randomBytes(32).toString('base64'));
  expect((await initializeLocalCredentials(root, conflicting.port, key, true)).status).toBe(
    'mismatch',
  );
  expect(conflicting.creates()).toBe(0);
});
