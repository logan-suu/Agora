// Synthetic component bytes exercise integrity validation only; packaged G5 executes real tools.
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inventoryToolchain, verifyToolchain } from '../src/toolchain-installation.js';
import { toolVersions } from '../src/toolchains.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
