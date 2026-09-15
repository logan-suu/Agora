import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireState, initializeFormat } from '../../../apps/desktop/src/storage.js';
import { cacheArtifact } from '../../../apps/desktop/src/toolchain-cache.js';
import { inspectProject } from '../../../apps/desktop/src/toolchains.js';
import { applyUpgrade, recoverUpgrade } from '../../../apps/desktop/src/upgrades.js';

it('preserves project declarations, credentials and recovery evidence across interrupted preparation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agora114-integration-'));
  const owner = await acquireState(join(parent, 'state'));
  const binding = JSON.stringify({
    projectId: 'project-1',
    revision: 7,
    connectionId: 'immutable-1',
    encryptedKey: 'opaque-existing-ciphertext',
  });
  try {
    await initializeFormat(owner.root);
    await writeFile(join(owner.root, 'connections.json'), binding, { mode: 0o600 });
    await writeFile(
      join(parent, 'package.json'),
      '{"packageManager":"pnpm@9.15.9","engines":{"node":"24"}}',
    );
    const tools = await inspectProject(parent);
    expect(tools.manager).toBe('pnpm');
    const archive = Buffer.from('integrity fixture; real binaries exercised by validate-tools.mjs');
    async function* chunks() {
      yield archive;
    }
    const prepared = await cacheArtifact(
      join(parent, 'cache'),
      {
        id: 'verified-fixture',
        url: 'https://example.invalid/fixture',
        sha256: createHash('sha256').update(archive).digest('hex'),
        maxBytes: 1024,
      },
      chunks(),
    );
    const migration = {
      id: 'integration-fixture',
      from: 1,
      to: 2,
      sourceVersion: 'test-1',
      converterVersion: 'test-2',
      files: ['connections.json'],
      transform: (_path: string, bytes: Buffer) =>
        Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), schema: 2 })),
    };
    await expect(
      applyUpgrade(owner, migration, (point) => {
        if (point === 'file:0') throw new Error('interrupted');
      }),
    ).rejects.toThrow('interrupted');
    await expect(initializeFormat(owner.root)).rejects.toThrow('upgrade_requires_quiescence');
    await recoverUpgrade(owner, migration, 'rollback');
    await initializeFormat(owner.root);
    expect(await readFile(join(owner.root, 'connections.json'), 'utf8')).toBe(binding);
    expect(await readFile(prepared)).toEqual(archive);
    expect(await inspectProject(parent)).toEqual(tools);
  } finally {
    await owner.release();
    await rm(parent, { recursive: true, force: true });
  }
});
