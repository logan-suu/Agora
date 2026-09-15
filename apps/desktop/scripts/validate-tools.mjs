// G5: real signed bundle tools, network dependency acquisition and authorized temporary projects.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = await realpath(resolve(process.argv[2] ?? ''));
if (!process.argv[2]) throw new Error('Usage: validate-tools.mjs <app>');
const root = await mkdtemp('/private/tmp/agora114-tools-');
console.log(root);
const resources = join(bundle, 'Contents/Resources');
const modules = join(resources, 'service/apps/desktop/dist');
const { verifyToolchain } = await import(
  pathToFileURL(join(modules, 'toolchain-installation.js')).href
);
const { managedEnvironment, inspectProject } = await import(
  pathToFileURL(join(modules, 'toolchains.js')).href
);
const tools = join(resources, 'toolchains', `darwin-${process.arch}`);
const home = join(root, 'home');
await mkdir(join(home, 'tmp'), { recursive: true });
const env = managedEnvironment(tools, home);
const checks = [];
const result = { status: 'running', bundle, arch: process.arch, checks };
function check(name, value) {
  assert(value, name);
  checks.push(name);
}
function run(binary, args, cwd = root) {
  return execFileSync(binary, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
}
try {
  check('bundle integrity', (await verifyToolchain(tools)).state === 'ready');
  for (const [name, expected] of [
    ['node', 'v24.20.0'],
    ['npm', '11.19.0'],
    ['pnpm', '9.15.9'],
  ])
    check(`${name} version`, run(join(tools, 'bin', name), ['--version']).trim() === expected);
  const git = join(tools, 'git/bin/git');
  check('git version', run(git, ['--version']).trim() === 'git version 2.53.0');
  for (const manager of ['npm', 'pnpm']) {
    const project = join(root, manager);
    await mkdir(project);
    const script = `const fs = require('node:fs'); const assert = require('node:assert/strict'); assert(require('is-number')(42)); assert(!Object.keys(process.env).some(k => /API_KEY|CREDENTIALS_KEY|NODE_OPTIONS|NODE_PATH/.test(k))); fs.writeFileSync('verified.txt', process.execPath);`;
    await writeFile(join(project, 'verify.cjs'), script);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        name: `agora-toolchain-${manager}`,
        private: true,
        version: '1.0.0',
        packageManager: `${manager}@${manager === 'npm' ? '11.19.0' : '9.15.9'}`,
        engines: { node: '24' },
        scripts: { postinstall: 'node verify.cjs', test: 'node verify.cjs' },
        dependencies: { 'is-number': '7.0.0' },
      }),
    );
    check(`${manager} preparation`, (await inspectProject(project)).manager === manager);
    const args =
      manager === 'pnpm'
        ? ['install', '--store-dir', join(home, 'pnpm-store')]
        : ['install', '--no-audit', '--no-fund'];
    run(join(tools, 'bin', manager), args, project);
    run(join(tools, 'bin', manager), ['test'], project);
    check(
      `${manager} dependency and lifecycle`,
      (await readFile(join(project, 'verified.txt'), 'utf8')) === join(tools, 'node/bin/node'),
    );
    await writeFile(join(project, '.node-version'), '22');
    await assert.rejects(inspectProject(project), /unsupported_node_version/);
    checks.push(`${manager} incompatible project blocked`);
  }
  const repo = join(root, 'git-repo');
  await mkdir(repo);
  run(git, ['init', '-b', 'main'], repo);
  await writeFile(join(repo, 'file.txt'), 'baseline');
  run(git, ['add', 'file.txt'], repo);
  run(
    git,
    [
      '-c',
      'user.name=Agora Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'Create fixture',
    ],
    repo,
  );
  const worktree = join(root, 'linked');
  run(git, ['worktree', 'add', '-b', 'worker', worktree], repo);
  check(
    'real linked worktree',
    (await readFile(join(worktree, 'file.txt'), 'utf8')) === 'baseline',
  );
  run(git, ['worktree', 'remove', worktree], repo);
  check(
    'worktree cleanup',
    !run(git, ['worktree', 'list', '--porcelain'], repo).includes(worktree),
  );
  const descriptor = openSync(repo, 'r');
  try {
    const helper = join(tools, 'secure-files');
    const options = {
      cwd: repo,
      env,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe', descriptor],
    };
    execFileSync(helper, ['write', repo, 'helper.txt', repo], {
      ...options,
      input: 'confined-write',
    });
    check(
      'signed native helper write/read',
      execFileSync(helper, ['read', repo, 'helper.txt', repo], options) === 'confined-write',
    );
    assert.throws(() => execFileSync(helper, ['read', repo, '../outside', repo], options));
    checks.push('signed native helper rejects traversal');
  } finally {
    closeSync(descriptor);
  }
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = error instanceof Error ? error.message.slice(0, 1000) : 'unknown';
  process.exitCode = 1;
} finally {
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
