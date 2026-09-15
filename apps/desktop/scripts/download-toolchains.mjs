import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { downloadArtifact } from '../dist/toolchain-cache.js';
import { catalog } from './toolchain-catalog.mjs';

const [directory, arch = process.arch] = process.argv.slice(2);
if (!directory || process.argv.length > 4)
  throw new Error('Usage: download-toolchains.mjs <new-directory> [arm64|x64]');
const artifacts = catalog(arch);
const root = resolve(directory);
await mkdir(root, { mode: 0o700 });
for (const artifact of artifacts) {
  const verified = await downloadArtifact(join(root, 'cache'), artifact);
  await cp(verified, join(root, artifact.name), { errorOnExist: true, force: false });
}
await writeFile(join(root, 'downloads.json'), JSON.stringify(artifacts, null, 2));
console.log(`VERIFIED_DOWNLOADS=${root}`);
