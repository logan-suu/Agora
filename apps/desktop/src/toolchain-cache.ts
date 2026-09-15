import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, privateDirectory, readRegular, syncDirectory } from './upgrade-files.js';

export interface Artifact {
  id: string;
  url: string;
  sha256: string;
  maxBytes: number;
}
// Artifacts and streams come only from the trusted, pinned build/preparation catalog.
export async function cacheArtifact(
  root: string,
  artifact: Artifact,
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(artifact.id) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !artifact.url.startsWith('https://') ||
    !Number.isSafeInteger(artifact.maxBytes) ||
    artifact.maxBytes < 1
  )
    throw new Error('invalid_artifact');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateDirectory(root);
  const published = join(root, artifact.id);
  const target = join(published, 'archive');
  async function existing() {
    await privateDirectory(published);
    const bytes = await readRegular(target, artifact.maxBytes);
    if (digest(bytes) !== artifact.sha256) throw new Error('cached_artifact_corrupt');
    const receipt = JSON.parse((await readRegular(join(published, 'receipt.json'))).toString());
    if (JSON.stringify(receipt) !== JSON.stringify(artifact))
      throw new Error('cached_artifact_conflict');
    return target;
  }
  try {
    return await existing();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  signal?.throwIfAborted();
  const stage = join(root, `.staging-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const file = await open(join(stage, 'archive'), 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > artifact.maxBytes) throw new Error('download_too_large');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      signal?.throwIfAborted();
      if (hash.digest('hex') !== artifact.sha256) throw new Error('download_hash_mismatch');
      await file.sync();
    } finally {
      await file.close();
    }
    const receipt = await open(join(stage, 'receipt.json'), 'wx', 0o600);
    try {
      await receipt.writeFile(JSON.stringify(artifact));
      await receipt.sync();
    } finally {
      await receipt.close();
    }
    await syncDirectory(stage);
    signal?.throwIfAborted();
    try {
      await rename(stage, published);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
      return await existing();
    }
    await syncDirectory(root);
    return target;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function downloadArtifact(root: string, artifact: Artifact, signal?: AbortSignal) {
  let url = new URL(artifact.url);
  let response: Response | undefined;
  const allowed = new Set([
    'nodejs.org',
    'github.com',
    'release-assets.githubusercontent.com',
    'objects.githubusercontent.com',
    'registry.npmjs.org',
  ]);
  const requestSignal = AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
  for (let redirect = 0; redirect < 6; redirect++) {
    if (
      url.protocol !== 'https:' ||
      !allowed.has(url.hostname) ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      throw new Error('untrusted_download_source');
    response = await fetch(url, { redirect: 'manual', signal: requestSignal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('download_failed');
      url = new URL(location, url);
    } else break;
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel();
    throw new Error('download_failed');
  }
  const stream = response.body;
  try {
    async function* chunks() {
      const reader = stream.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          yield chunk.value;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    return await cacheArtifact(root, artifact, chunks(), requestSignal);
  } finally {
    if (!stream.locked) await stream.cancel();
  }
}
