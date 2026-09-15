import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cacheArtifact } from '../src/toolchain-cache.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('publishes verified bytes once and preserves them after cancellation or a bad download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora114-cache-'));
  roots.push(root);
  const bytes = Buffer.from('verified archive fixture');
  const artifact = {
    id: 'fixture-arm64',
    url: 'https://example.invalid/archive',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    maxBytes: 100,
  };
  async function* source() {
    yield bytes;
  }
  const target = await cacheArtifact(root, artifact, source());
  expect(await readFile(target)).toEqual(bytes);
  expect(await cacheArtifact(root, artifact, source())).toBe(target);
  async function* bad() {
    yield Buffer.from('corrupt');
  }
  await expect(cacheArtifact(root, { ...artifact, id: 'bad' }, bad())).rejects.toThrow(
    'download_hash_mismatch',
  );
  const controller = new AbortController();
  async function* cancel() {
    yield bytes;
    controller.abort();
  }
  await expect(
    cacheArtifact(root, { ...artifact, id: 'cancelled' }, cancel(), controller.signal),
  ).rejects.toThrow();
  expect(await readFile(target)).toEqual(bytes);
  expect(await readdir(root)).toEqual([artifact.id]);
});
