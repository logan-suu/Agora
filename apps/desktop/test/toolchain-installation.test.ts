// Synthetic component bytes exercise integrity validation only; packaged G5 executes real tools.
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inventoryToolchain, verifyToolchain } from '../src/toolchain-installation.js';
import { toolVersions } from '../src/toolchains.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('hashes multi-chunk binaries without changing the digest or executable metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora114-inventory-'));
  roots.push(root);
  const file = await open(join(root, 'binary'), 'wx', 0o700);
  const block = Buffer.alloc(1024 * 1024, 0x5a);
  const hash = createHash('sha256');
  try {
    for (let index = 0; index < 32; index++) {
      await file.writeFile(block);
      hash.update(block);
    }
  } finally {
    await file.close();
  }
  expect(await inventoryToolchain(root)).toEqual([
    { path: 'binary', sha256: hash.digest('hex'), executable: true },
  ]);
});
it('rejects corruption, wrong architecture and internal launcher replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora114-inventory-'));
  roots.push(root);
  for (const name of [
    'node/bin/node',
    'node/lib/node_modules/npm/bin/npm-cli.js',
    'pnpm/bin/pnpm.cjs',
    'git/bin/git',
    'keychain',
    'secure-files',
  ]) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), name, { mode: 0o755 });
  }
  for (const name of ['git/libexec/git-core', 'git/share/git-core/templates', 'bin'])
    await mkdir(join(root, name), { recursive: true });
  await symlink('../node/bin/node', join(root, 'bin/node'));
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      format: 1,
      arch: 'arm64',
      platform: 'darwin',
      versions: toolVersions,
      files: await inventoryToolchain(root),
    }),
  );
  expect(await verifyToolchain(root, 'arm64')).toMatchObject({ state: 'ready' });
  await expect(verifyToolchain(root, 'x64')).rejects.toThrow('toolchain_arch_mismatch');
  await chmod(join(root, 'node/bin/node'), 0o644);
  await expect(verifyToolchain(root, 'arm64')).rejects.toThrow('toolchain_node_invalid');
  await chmod(join(root, 'node/bin/node'), 0o755);
  const before = await readFile(join(root, 'node/bin/node'));
  await writeFile(join(root, 'node/bin/node'), 'corrupted');
  await expect(verifyToolchain(root, 'arm64')).rejects.toThrow('toolchain_node_invalid');
  await writeFile(join(root, 'node/bin/node'), before);
  await rm(join(root, 'bin/node'));
  await symlink('../git/bin/git', join(root, 'bin/node'));
  await expect(verifyToolchain(root, 'arm64')).rejects.toThrow('toolchain_node_invalid');
});

it('requires every executable local helper before admitting local execution', async () => {
  const { verifyLocalExecutionToolchain } = await import('../src/toolchain-installation.js');
  const root = await mkdtemp(join(tmpdir(), 'agora123-tools-'));
  roots.push(root);
  const names = [
    'node/bin/node',
    'node/lib/node_modules/npm/bin/npm-cli.js',
    'pnpm/bin/pnpm.cjs',
    'git/bin/git',
    'keychain',
    'secure-files',
    'local-root-inspection',
    'local-root-initialization',
    'local-file-transaction',
    'local-command-bootstrap',
    'local-process-control',
  ];
  for (const name of names) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), name, { mode: 0o755 });
  }
  for (const name of ['git/libexec/git-core', 'git/share/git-core/templates', 'bin'])
    await mkdir(join(root, name), { recursive: true });
  async function manifest() {
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        format: 1,
        arch: 'arm64',
        platform: 'darwin',
        versions: toolVersions,
        files: await inventoryToolchain(root),
      }),
    );
  }
  await manifest();
  expect(await verifyLocalExecutionToolchain(root, 'arm64')).toMatchObject({
    inspector: join(root, 'local-root-inspection'),
    initializer: join(root, 'local-root-initialization'),
    filesHelper: join(root, 'local-file-transaction'),
    tools: {
      node: { path: join(root, 'node/bin/node'), version: toolVersions.node },
      bootstrap: { path: join(root, 'local-command-bootstrap') },
      processControl: { path: join(root, 'local-process-control') },
    },
  });
  await chmod(join(root, 'local-process-control'), 0o644);
  await manifest();
  await expect(verifyLocalExecutionToolchain(root, 'arm64')).rejects.toThrow(
    'toolchain_local_execution_invalid',
  );
  await rm(join(root, 'local-command-bootstrap'));
  await manifest();
  await expect(verifyLocalExecutionToolchain(root, 'arm64')).rejects.toThrow(
    'toolchain_local_execution_invalid',
  );
});
