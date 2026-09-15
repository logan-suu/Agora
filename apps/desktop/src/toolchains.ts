import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const toolVersions = {
  node: '24.20.0',
  pnpm: '9.15.9',
  npm: '11.19.0',
  git: '2.53.0',
} as const;
export type ProjectTools = { node: string; manager: 'pnpm' | 'npm'; version: string };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_project_manifest');
  return value as Record<string, unknown>;
}

// Deliberately bounded syntax: unsupported ranges are reported, never guessed.
function matches(version: string, constraint: unknown): boolean {
  if (typeof constraint !== 'string' || !constraint.trim())
    throw new Error('unsupported_node_constraint');
  const actual = version.split('.').map(Number);
  const comparisons = constraint
    .trim()
    .split(/\s+/)
    .map((part) => {
      const match =
        /^(>=|<=|>|<|\^|~|=)?v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/.exec(part);
      if (!match) throw new Error('unsupported_node_constraint');
      const [, operator = '=', major, minor, patch] = match;
      const expected = [Number(major), Number(minor ?? 0), Number(patch ?? 0)];
      const order =
        actual[0] !== expected[0]
          ? (actual[0] ?? 0) - (expected[0] ?? 0)
          : actual[1] !== expected[1]
            ? (actual[1] ?? 0) - (expected[1] ?? 0)
            : (actual[2] ?? 0) - (expected[2] ?? 0);
      if (operator === '>=') return order >= 0;
      if (operator === '>')
        return patch === undefined
          ? minor === undefined
            ? (actual[0] ?? 0) > Number(major)
            : (actual[0] ?? 0) > Number(major) ||
              (actual[0] === Number(major) && (actual[1] ?? 0) > Number(minor))
          : order > 0;
      if (operator === '<=')
        return patch === undefined
          ? minor === undefined
            ? (actual[0] ?? 0) <= Number(major)
            : (actual[0] ?? 0) < Number(major) ||
              (actual[0] === Number(major) && (actual[1] ?? 0) <= Number(minor))
          : order <= 0;
      if (operator === '<') return order < 0;
      if (operator === '^')
        return (
          order >= 0 &&
          actual[0] === expected[0] &&
          (expected[0] !== 0 ||
            (actual[1] === expected[1] && (expected[1] !== 0 || actual[2] === expected[2])))
        );
      if (operator === '~')
        return (
          order >= 0 &&
          actual[0] === expected[0] &&
          (minor === undefined || actual[1] === expected[1])
        );
      return (
        actual[0] === expected[0] &&
        (minor === undefined || actual[1] === expected[1]) &&
        (patch === undefined || actual[2] === expected[2])
      );
    });
  return comparisons.every(Boolean);
}

export function selectProjectTools(
  manifest: unknown,
  files: string[],
  nodeDeclarations: string[] = [],
): ProjectTools {
  const pkg = object(manifest);
  const engines = pkg.engines === undefined ? {} : object(pkg.engines);
  const constraints = [...nodeDeclarations, ...(engines.node === undefined ? [] : [engines.node])];
  for (const constraint of constraints) {
    if (!matches(toolVersions.node, constraint)) throw new Error('unsupported_node_version');
  }
  const locks = [
    ...(files.includes('pnpm-lock.yaml') ? ['pnpm'] : []),
    ...(files.some((file) => ['package-lock.json', 'npm-shrinkwrap.json'].includes(file))
      ? ['npm']
      : []),
    ...(files.includes('yarn.lock') ? ['yarn'] : []),
    ...(files.some((file) => ['bun.lock', 'bun.lockb'].includes(file)) ? ['bun'] : []),
  ];
  if (locks.length > 1) throw new Error('package_manager_conflict');
  let manager = locks[0] ?? 'npm';
  if (pkg.packageManager !== undefined) {
    if (typeof pkg.packageManager !== 'string') throw new Error('invalid_project_manifest');
    const match = /^(npm|pnpm)@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager);
    if (!match) throw new Error('unsupported_package_manager');
    manager = match[1] ?? '';
    if (locks.length && locks[0] !== manager) throw new Error('package_manager_conflict');
    if (match[2] !== toolVersions[manager as 'npm' | 'pnpm'])
      throw new Error('unsupported_package_manager_version');
  }
  if (manager !== 'npm' && manager !== 'pnpm') throw new Error('unsupported_package_manager');
  if (engines[manager] !== undefined) {
    try {
      if (!matches(toolVersions[manager], engines[manager])) throw new Error();
    } catch {
      throw new Error('unsupported_package_manager_version');
    }
  }
  return { node: toolVersions.node, manager, version: toolVersions[manager] };
}

export async function inspectProject(root: string): Promise<ProjectTools> {
  if (!isAbsolute(root) || (await lstat(root)).isSymbolicLink())
    throw new Error('invalid_project_root');
  const canonical = await realpath(root);
  const files = await readdir(canonical);
  async function read(name: string) {
    const handle = await open(join(canonical, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('invalid_project_manifest');
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }
  const declarations = [];
  for (const name of ['.node-version', '.nvmrc'])
    if (files.includes(name)) declarations.push((await read(name)).trim());
  return selectProjectTools(JSON.parse(await read('package.json')), files, declarations);
}

// Only callers holding a project authorization may use this environment to execute.
// The private home prevents package-manager config and credentials leaking from the host.
export function managedEnvironment(root: string, privateHome: string): NodeJS.ProcessEnv {
  if (
    !isAbsolute(root) ||
    !isAbsolute(privateHome) ||
    root.includes(':') ||
    privateHome.includes('\0')
  )
    throw new Error('invalid_toolchain_path');
  return {
    NODE_ENV: 'development',
    HOME: privateHome,
    TMPDIR: join(privateHome, 'tmp'),
    PATH: `${root}/bin:${root}/node/bin:${root}/git/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8',
    GIT_EXEC_PATH: join(root, 'git/libexec/git-core'),
    GIT_TEMPLATE_DIR: join(root, 'git/share/git-core/templates'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_userconfig: join(privateHome, 'npm-user.conf'),
    npm_config_globalconfig: join(privateHome, 'npm-global.conf'),
    npm_config_cache: join(privateHome, 'npm-cache'),
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    NEXT_TELEMETRY_DISABLED: '1',
    CI: 'true',
  };
}
