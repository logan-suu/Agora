// Inspect real installation media in temporary directories without changing /Applications.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const media = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: validate-media.mjs <media-directory>');
const result = JSON.parse(await readFile(join(media, 'media.json'), 'utf8'));
const root = await mkdtemp('/private/tmp/agora114-install-');
console.log(root);
const report = {
  status: 'running',
  checks: [],
  installedApp: join(root, 'installed/Agora.app'),
  mounted: false,
};
const run = (command, args) => execFileSync(command, args, { stdio: 'pipe', timeout: 120000 });
const mount = join(root, 'volume');
try {
  assert(result.arch === process.arch && result.files.length === 2);
  for (const file of result.files) {
    assert(
      file.name === `Agora-darwin-${process.arch}.zip` ||
        file.name === `Agora-darwin-${process.arch}.dmg`,
    );
    const bytes = await readFile(join(media, file.name));
    assert(
      bytes.length === file.bytes &&
        createHash('sha256').update(bytes).digest('hex') === file.sha256,
    );
  }
  report.checks.push('both media checksums');
  await mkdir(join(root, 'zip'));
  run('/usr/bin/ditto', [
    '-x',
    '-k',
    join(media, `Agora-darwin-${process.arch}.zip`),
    join(root, 'zip'),
  ]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(root, 'zip/Agora.app')]);
  report.checks.push('zip extraction and bundle signature integrity');
  await mkdir(mount);
  run('/usr/bin/hdiutil', ['verify', join(media, `Agora-darwin-${process.arch}.dmg`)]);
  run('/usr/bin/hdiutil', [
    'attach',
    '-readonly',
    '-nobrowse',
    '-mountpoint',
    mount,
    join(media, `Agora-darwin-${process.arch}.dmg`),
  ]);
  report.mounted = true;
  await mkdir(join(root, 'installed'));
  await cp(join(mount, 'Agora.app'), report.installedApp, {
    recursive: true,
    verbatimSymlinks: true,
  });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', report.installedApp]);
  const resources = join(report.installedApp, 'Contents/Resources');
  const { verifyToolchain } = await import(
    pathToFileURL(join(resources, 'service/apps/desktop/dist/toolchain-installation.js')).href
  );
  await verifyToolchain(join(resources, 'toolchains', `darwin-${process.arch}`));
  report.checks.push('dmg mount copy and installed toolchain integrity');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (report.mounted) {
    try {
      run('/usr/bin/hdiutil', ['detach', mount]);
      report.mounted = false;
    } catch {
      report.status = 'failed';
      report.cleanupError = 'detach_failed';
      process.exitCode = 1;
    }
  }
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
