// Reproduce the historical arm64 packaging probe; this is not a product launcher.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const evidence = path.dirname(here);
const repo = path.resolve(here, '../../../..');
const manifestBytes = fs.readFileSync(path.join(evidence, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
for (const entry of manifest.files) {
  assert(entry.file && !entry.localFile, 'Evidence must be available in the checkout');
  const file = path.resolve(evidence, entry.file);
  assert(file.startsWith(`${evidence}/`), 'Evidence path escapes its directory');
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), entry.sha256, entry.file);
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--verify-only') {
  console.log(`Verified ${manifest.files.length} repository evidence files`);
  process.exit(0);
}
assert(args.length === 0 || (args.length === 2 && args[0] === '--download-cache'),
  'Usage: node reproduce.mjs [--verify-only | --download-cache DIRECTORY]');
assert(process.platform === 'darwin' && process.arch === 'arm64', 'The historical probe requires macOS arm64');
const cache = args.length ? path.resolve(args[1]) : undefined;
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agora112-reproduce-'));
fs.chmodSync(base, 0o700);
console.log(`Reproduction directory: ${base}`);
const env = { HOME: os.homedir(), TMPDIR: os.tmpdir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8', CI: '1', NEXT_TELEMETRY_DISABLED: '1' };
const log = fs.openSync(path.join(base, 'reproduce.log'), 'wx', 0o600);
function run(command, argv, cwd = base) {
  try {
    return execFileSync(command, argv, { cwd, env, stdio: ['ignore', log, log] });
  } catch {
    // Do not echo subprocess arguments or raw Keychain diagnostics into a result.
    throw new Error(`Command failed: ${path.basename(command)}; inspect private reproduce.log`);
  }
}
const urls = {
  'electron.zip': 'https://github.com/electron/electron/releases/download/v44.3.0/electron-v44.3.0-darwin-arm64.zip',
  'node.tar.gz': 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz',
  'git.tar.gz': 'https://github.com/desktop/dugite-native/releases/download/v2.53.0-4/dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz',
  'pnpm.tgz': 'https://registry.npmjs.org/pnpm/-/pnpm-9.15.9.tgz',
};
try {
  fs.mkdirSync(path.join(base, 'downloads'));
  for (const [name, algorithm, expected] of JSON.parse(fs.readFileSync(path.join(evidence, 'downloads.json')))) {
    const target = path.join(base, 'downloads', name);
    if (cache) fs.copyFileSync(path.join(cache, name), target);
    else run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--output', target, urls[name]]);
    const actual = createHash(algorithm).update(fs.readFileSync(target)).digest(algorithm === 'sha512' ? 'base64' : 'hex');
    assert.equal(actual, expected, `Download checksum: ${name}`);
  }
  for (const name of ['source', 'node', 'git', 'pnpm', 'electron']) fs.mkdirSync(path.join(base, name));
  run('/usr/bin/git', ['-C', repo, 'archive', '--format=tar', '--output', path.join(base, 'source.tar'), manifest.sourceCommit]);
  const source = path.join(base, 'source');
  run('/usr/bin/tar', ['-xf', path.join(base, 'source.tar'), '-C', source]);
  for (const [name, archive, strip] of [['node', 'node.tar.gz', true], ['git', 'git.tar.gz', false], ['pnpm', 'pnpm.tgz', true]]) {
    run('/usr/bin/tar', ['-xf', path.join(base, 'downloads', archive), '-C', path.join(base, name), ...(strip ? ['--strip-components=1'] : [])]);
  }
  run('/usr/bin/ditto', ['-x', '-k', path.join(base, 'downloads/electron.zip'), path.join(base, 'electron')]);
  const node = path.join(base, 'node/bin/node');
  const pnpm = path.join(base, 'pnpm/bin/pnpm.cjs');
  env.PATH = `${path.join(base, 'node/bin')}:${env.PATH}`;
  console.log('Installing frozen dependencies in the clean source archive');
  run(node, [pnpm, 'install', '--frozen-lockfile'], source);
  run(node, [pnpm, 'build:sandbox-native'], source);
  run(node, [pnpm, 'build:keychain-native'], source);
  run(node, [pnpm, '--filter', '@agora/web', 'build'], source);
  // The historical script only reads these verified metadata fields; Packager is not executed.
  const stage = JSON.parse(fs.readFileSync(path.join(evidence, 'stage.json')));
  fs.writeFileSync(path.join(base, 'downloads/packager-metadata.json'), JSON.stringify({ version: stage.packagerCandidate, engines: stage.packagerEngines }));
  for (const name of ['prepare.cjs', 'close-dependencies.cjs']) {
    let code = fs.readFileSync(path.join(here, name), 'utf8');
    const originalBase = "'/private/tmp/agora-112-spike'";
    assert.equal(code.split(originalBase).length, 2, `Expected one historical base in ${name}`);
    code = code.replace(originalBase, JSON.stringify(base));
    if (name === 'prepare.cjs') {
      const oldCommit = "cp.execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:process.cwd(),encoding:'utf8'}).trim()";
      assert(code.includes(oldCommit), 'Expected historical source-commit lookup');
      code = code.replace(oldCommit, JSON.stringify(manifest.sourceCommit));
    }
    fs.writeFileSync(path.join(base, name), code);
    run(node, [path.join(base, name)], source);
  }
  const bundle = path.join(base, 'Agora Spike.app');
  const resources = path.join(bundle, 'Contents/Resources');
  fs.copyFileSync(path.join(here, 'main.cjs'), path.join(resources, 'app/main.cjs'));
  fs.copyFileSync(path.join(here, 'stop-child.cjs'), path.join(resources, 'app/stop-child.cjs'));
  fs.copyFileSync(path.join(here, 'desktop-spike.mjs'), path.join(resources, 'service/desktop-spike.mjs'));
  fs.renameSync(path.join(bundle, 'Contents/MacOS/Electron'), path.join(bundle, 'Contents/MacOS/AgoraSpike'));
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const [key, value] of [['CFBundleExecutable', 'AgoraSpike'], ['CFBundleName', 'Agora Spike'], ['CFBundleIdentifier', 'com.agora.spike112']]) {
    run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }
  let files = 0;
  function audit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(!['.data', '.git'].includes(entry.name) && !entry.name.startsWith('.env'), `Forbidden resource name: ${entry.name}`);
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) assert(fs.realpathSync(file).startsWith(`${resources}/`), 'External resource link');
      else if (entry.isDirectory()) audit(file);
      else files++;
    }
  }
  audit(resources);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  console.log('Running the packaged Electron probe with its isolated Keychain');
  run(path.join(bundle, 'Contents/MacOS/AgoraSpike'), []);
  const probe = fs.readFileSync(path.join(base, 'last-probe.txt'), 'utf8').trim();
  assert(path.dirname(probe) === base, 'Unexpected probe result directory');
  const result = JSON.parse(fs.readFileSync(path.join(probe, 'result.json')));
  assert.equal(result.status, 'passed');
  const expectedChecks = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'))).checks;
  assert.deepEqual(result.checks, expectedChecks);
  assert.equal(result.keychainRemoved, true);
  fs.writeFileSync(path.join(base, 'reproduction-result.json'), JSON.stringify({
    sourceCommit: manifest.sourceCommit, evidenceFilesVerified: manifest.files.length,
    evidenceVerification: {
      phase: 'Before building the app',
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      files: manifest.files,
      scope: 'All entries in the input manifest snapshot were verified. This generated result is a later output, not one of its own verified inputs; subsequent manifest additions do not change this count.',
    },
    resourceFiles: files, externalLinks: 0, forbidden: 0, adHocBundleVerification: 'passed',
    dependencyInstall: 'pnpm install --frozen-lockfile in clean git archive',
    transformations: ['Two historical build-script base paths relocated to this new temporary directory', 'prepare.cjs sourceCommit fixed to the archived commit'],
    result,
  }, null, 2) + '\n');
  console.log(`Passed ${result.checks.length} checks; result: ${path.join(base, 'reproduction-result.json')}`);
} finally {
  fs.closeSync(log);
}
