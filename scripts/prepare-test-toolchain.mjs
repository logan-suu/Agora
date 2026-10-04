// Assemble test-only managed tools from the same pinned catalog as desktop builds.
// No installed application, host PATH executable or unverified download is used.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadArtifact } from '../apps/desktop/dist/toolchain-cache.js';
import {
  inventoryToolchain,
  verifyLocalExecutionToolchain,
} from '../apps/desktop/dist/toolchain-installation.js';
import { toolVersions } from '../apps/desktop/dist/toolchains.js';
import { catalog } from '../apps/desktop/scripts/toolchain-catalog.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
  throw Error('native_macos_test_host_required');
const output = join(repo, 'test-outputs', 'managed-toolchain', `darwin-${process.arch}`);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 }); // Never replace existing or user-owned inputs.
const staging = await mkdtemp(join(dirname(output), 'download-'));
const artifacts = catalog(process.arch).filter((item) => item.name !== 'electron.zip');
try {
  for (const artifact of artifacts) {
    const archive = await downloadArtifact(join(staging, 'cache'), artifact);
    const target =
      artifact.name === 'node.tar.gz' ? 'node' : artifact.name === 'git.tar.gz' ? 'git' : 'pnpm';
    const extracted = join(staging, target);
    await mkdir(extracted);
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
    const children = await readdir(extracted);
    // Node/pnpm archives have a wrapper directory; dugite Git is rooted at bin/.
    const source = target === 'git' ? extracted : join(extracted, children[0]);
    if (target !== 'git' && children.length !== 1) throw Error('unexpected_tool_archive');
    await cp(source, join(output, target), { recursive: true, verbatimSymlinks: true });
  }
  for (const name of [
    'secure-files',
    'local-root-inspection',
    'local-root-initialization',
    'local-file-transaction',
    'local-command-bootstrap',
    'local-process-control',
  ])
    await cp(
      join(repo, `packages/runtime/sandbox/build/${name}-darwin-${process.arch}`),
      join(output, name),
    );
  await cp(
    join(repo, `packages/runtime/state/build/keychain-${process.arch}`),
    join(output, 'keychain'),
  );
  await mkdir(join(output, 'bin'));
  await symlink('../node/bin/node', join(output, 'bin/node'));
  for (const [name, script] of [
    ['pnpm', 'pnpm/bin/pnpm.cjs'],
    ['npm', 'node/lib/node_modules/npm/bin/npm-cli.js'],
    ['npx', 'node/lib/node_modules/npm/bin/npx-cli.js'],
  ])
    await writeFile(
      join(output, 'bin', name),
      `#!/bin/sh\nbase="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$base/node/bin/node" "$base/${script}" "$@"\n`,
      { mode: 0o755 },
    );
  await writeFile(join(output, 'SOURCES.json'), JSON.stringify({ artifacts }, null, 2));
  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify(
      {
        format: 1,
        platform: 'darwin',
        arch: process.arch,
        versions: toolVersions,
        files: await inventoryToolchain(output),
      },
      null,
      2,
    ),
  );
  await verifyLocalExecutionToolchain(output);
  const versions = {
    node: execFileSync(join(output, 'node/bin/node'), ['--version'], { encoding: 'utf8' }).trim(),
    git: execFileSync(join(output, 'git/bin/git'), ['--version'], { encoding: 'utf8' }).trim(),
    pnpm: execFileSync(
      join(output, 'node/bin/node'),
      [join(output, 'pnpm/bin/pnpm.cjs'), '--version'],
      { encoding: 'utf8' },
    ).trim(),
  };
  await writeFile(
    join(repo, 'test-outputs', 'managed-toolchain-preparation.json'),
    JSON.stringify(
      {
        output,
        artifacts,
        versions,
        manifest: JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')),
      },
      null,
      2,
    ),
  );
  console.log(output);
} catch (error) {
  await rm(output, { recursive: true }); // Exclusively created by this invocation.
  throw error;
} finally {
  await rm(staging, { recursive: true });
}
