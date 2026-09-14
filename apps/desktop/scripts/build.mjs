import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cache = resolve(process.argv[2] ?? '');
const revision = process.argv[3] === '--revision' ? process.argv[4] : undefined;
if (!(process.argv.length === 3 || (process.argv.length === 5 && revision)))
  throw new Error('Usage: build.mjs <verified-download-directory> [--revision <git-ref>]');
const build = await mkdtemp(join(tmpdir(), 'agora113-build-'));
console.log(build);
const source = join(build, 'source');
await mkdir(source);
const base = execFileSync(
  '/usr/bin/git',
  ['rev-parse', '--verify', `${revision ?? 'HEAD'}^{commit}`],
  {
    cwd: repo,
    encoding: 'utf8',
  },
).trim();
const names = execFileSync(
  '/usr/bin/git',
  revision
    ? ['ls-tree', '-r', '--name-only', '-z', base]
    : ['ls-files', '-co', '--exclude-standard', '-z'],
  {
    cwd: repo,
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean);
const inputs = [];
for (const name of [...new Set(names)].sort()) {
  if (
    !/^(apps\/|packages\/|scripts\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig[^/]*\.json$|biome\.json$)/.test(
      name,
    )
  )
    continue;
  if (
    name
      .split('/')
      .some(
        (part) =>
          part.startsWith('.env') ||
          ['.data', '.git', 'node_modules', 'dist', 'build'].includes(part),
      )
  )
    throw new Error('forbidden_source');
  const from = join(repo, name);
  let stat;
  if (revision) stat = { isFile: () => true, mode: 0o644 };
  else
    try {
      stat = await lstat(from);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  if (!stat.isFile()) throw new Error('unsafe_source_file');
  const bytes = revision
    ? execFileSync('/usr/bin/git', ['show', `${base}:${name}`], {
        cwd: repo,
        maxBuffer: 32 * 1024 * 1024,
      })
    : await readFile(from);
  inputs.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex') });
  await mkdir(dirname(join(source, name)), { recursive: true });
  await writeFile(join(source, name), bytes, { mode: stat.mode });
}
await writeFile(
  join(build, 'input.json'),
  JSON.stringify(
    { base, kind: revision ? 'fixed-commit' : 'development-working-tree', inputs },
    null,
    2,
  ),
);
for (const [name, hash] of [
  ['node.tar.gz', '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8'],
  ['electron.zip', '49b91ef265c603c8888500f807484b63816069c30f87ba2b403e7c87f0f45035'],
]) {
  if (
    createHash('sha256')
      .update(await readFile(join(cache, name)))
      .digest('hex') !== hash
  )
    throw new Error('download_hash_mismatch');
}
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('arm64_validation_build_only');
const tools = join(build, 'tools');
await mkdir(tools);
execFileSync('/usr/bin/tar', [
  '-xzf',
  join(cache, 'node.tar.gz'),
  '--strip-components=1',
  '-C',
  tools,
]);
const node = join(tools, 'bin/node');
const pnpmArchive = await readFile(join(cache, 'pnpm.tgz'));
if (
  createHash('sha512').update(pnpmArchive).digest('base64') !==
  'aARhQYk8ZvrQHAeSMRKOmvuJ74fiaR1p5NQO7iKJiClf1GghgbrlW1hBjDolO95lpQXsfF+UA+zlzDzTfc8lMQ=='
)
  throw new Error('pnpm_hash_mismatch');
const pnpmRoot = join(build, 'pnpm');
await mkdir(pnpmRoot);
execFileSync('/usr/bin/tar', [
  '-xzf',
  join(cache, 'pnpm.tgz'),
  '--strip-components=1',
  '-C',
  pnpmRoot,
]);
const env = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  PATH: `${tools}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  NEXT_TELEMETRY_DISABLED: '1',
  CI: 'true',
};
function run(args) {
  execFileSync(node, args, { cwd: source, env, stdio: 'inherit', timeout: 600000 });
}
const pnpm = join(pnpmRoot, 'bin/pnpm.cjs');
run([pnpm, 'install', '--frozen-lockfile', '--ignore-scripts']);
run(['packages/runtime/state/scripts/build-keychain.mjs']);
run(['packages/runtime/sandbox/scripts/build-native.mjs']);
run([pnpm, '--filter', '@agora/desktop', 'build']);
run([pnpm, '--filter', '@agora/web', 'build']);
const zipDir = join(build, 'electron');
await mkdir(zipDir);
await cp(join(cache, 'electron.zip'), join(zipDir, 'electron-v44.3.0-darwin-arm64.zip'));
run(['apps/desktop/scripts/package.mjs', source, tools, zipDir, join(build, 'output')]);
console.log(`BUILD_COMPLETE=${build}`);
