import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from './toolchain-catalog.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cache = resolve(process.argv[2] ?? '');
const flags = process.argv.slice(3);
const option = (name) => {
  const index = flags.indexOf(name);
  return index < 0 ? undefined : flags[index + 1];
};
if (
  flags.length % 2 ||
  flags.some((value, index) => index % 2 === 0 && !['--revision', '--arch'].includes(value)) ||
  new Set(flags.filter((_, index) => index % 2 === 0)).size !== flags.length / 2 ||
  !process.argv[2]
)
  throw new Error(
    'Usage: build.mjs <verified-download-directory> [--revision <git-ref>] [--arch arm64|x64]',
  );
const revision = option('--revision');
const arch = option('--arch') ?? process.arch;
catalog(arch);
if (process.platform !== 'darwin' || process.arch !== arch)
  throw new Error('native_target_build_required');
const build = await mkdtemp(join(tmpdir(), 'agora114-build-'));
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
for (const artifact of catalog(arch)) {
  const bytes = await readFile(join(cache, artifact.name));
  if (
    bytes.length > artifact.maxBytes ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  )
    throw new Error('download_hash_mismatch');
}
await writeFile(join(build, 'downloads.json'), JSON.stringify(catalog(arch), null, 2));
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
const gitRoot = join(build, 'git');
await mkdir(gitRoot);
execFileSync('/usr/bin/tar', ['-xzf', join(cache, 'git.tar.gz'), '-C', gitRoot]);
const env = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  PATH: `${tools}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  NEXT_TELEMETRY_DISABLED: '1',
  CI: 'true',
  MACOSX_DEPLOYMENT_TARGET: '13.5',
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
await cp(join(cache, 'electron.zip'), join(zipDir, `electron-v44.3.0-darwin-${arch}.zip`));
run([
  'apps/desktop/scripts/package.mjs',
  source,
  tools,
  zipDir,
  join(build, 'output'),
  gitRoot,
  pnpmRoot,
  arch,
]);
console.log(`BUILD_COMPLETE=${build}`);
