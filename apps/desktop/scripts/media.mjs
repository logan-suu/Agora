import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { auditResources } from '../dist/build-resources.js';
import { inventoryToolchain, verifyToolchain } from '../dist/toolchain-installation.js';
import { signValidationBundle } from './sign.mjs';

const [bundle, outputArg, identity = '-'] = process.argv.slice(2);
if (!bundle || !outputArg || process.argv.length > 5)
  throw new Error('Usage: media.mjs <validated-app> <new-output> [Developer-ID-identity]');
const output = resolve(outputArg);
await mkdir(output);
const staging = join(output, 'contents');
await mkdir(staging);
const app = join(staging, 'Agora.app');
await cp(resolve(bundle), app, { recursive: true, verbatimSymlinks: true });
await auditResources(join(app, 'Contents/Resources'));
const tools = join(app, 'Contents/Resources/toolchains', `darwin-${process.arch}`);
await verifyToolchain(tools);
const signing = await signValidationBundle(
  app,
  async () => {
    const path = join(tools, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.files = await inventoryToolchain(tools);
    await writeFile(path, JSON.stringify(manifest, null, 2));
  },
  identity,
);
await verifyToolchain(tools);
const files = [];
// Developer ID media is signed here; notarization is an explicit subsequent operation.
for (const extension of ['zip', 'dmg']) {
  const path = join(output, `Agora-darwin-${process.arch}.${extension}`);
  if (extension === 'zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path], {
      stdio: 'pipe',
    });
  else {
    await symlink('/Applications', join(staging, 'Applications'));
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'create',
        '-fs',
        'HFS+',
        '-format',
        'UDZO',
        '-volname',
        'Agora',
        '-srcfolder',
        staging,
        path,
      ],
      { stdio: 'pipe' },
    );
  }
  const bytes = await readFile(path);
  files.push({
    name: path.split('/').at(-1),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  join(output, 'media.json'),
  JSON.stringify(
    { arch: process.arch, minimumSystem: '15.0', signing, notarization: 'not-run', files },
    null,
    2,
  ),
);
await writeFile(
  join(output, 'SHA256SUMS'),
  files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
);
console.log(`MEDIA_OUTPUT=${output}`);
