import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectProject, managedEnvironment, selectProjectTools } from '../src/toolchains.js';

const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'agora114-project-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('managed project preparation', () => {
  it('respects supported versions and rejects conflicting declarations without changing them', async () => {
    const root = await directory();
    const manifest = JSON.stringify({
      packageManager: 'pnpm@9.15.9',
      engines: { node: '>=24 <25' },
    });
    await writeFile(join(root, 'package.json'), manifest);
    await writeFile(join(root, '.nvmrc'), '24.20.0\n');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    expect(await inspectProject(root)).toMatchObject({
      node: '24.20.0',
      manager: 'pnpm',
      version: '9.15.9',
    });
    await writeFile(join(root, '.node-version'), '22');
    await expect(inspectProject(root)).rejects.toThrow('unsupported_node_version');
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest);
    expect(await readdir(root)).toHaveLength(4);
  });
  it('does not silently pick a package manager or ignore malformed constraints', () => {
    expect(() => selectProjectTools({ packageManager: 'yarn@4.0.0' }, [])).toThrow(
      'unsupported_package_manager',
    );
    expect(() => selectProjectTools({ packageManager: 'npm@11.19.0' }, ['pnpm-lock.yaml'])).toThrow(
      'package_manager_conflict',
    );
    expect(() => selectProjectTools({}, ['pnpm-lock.yaml', 'package-lock.json'])).toThrow(
      'package_manager_conflict',
    );
    expect(() => selectProjectTools({ engines: { node: '>=24 || banana' } }, [])).toThrow(
      'unsupported_node_constraint',
    );
    expect(() => selectProjectTools({ engines: { node: '<24' } }, [])).toThrow(
      'unsupported_node_version',
    );
    expect(() => selectProjectTools({ engines: { npm: '10' } }, [])).toThrow(
      'unsupported_package_manager_version',
    );
    expect(() => selectProjectTools({ engines: { node: '>24' } }, [])).toThrow(
      'unsupported_node_version',
    );
    expect(selectProjectTools({ engines: { node: '<=24' } }, []).node).toBe('24.20.0');
    expect(selectProjectTools({}, [])).toMatchObject({ manager: 'npm', version: '11.19.0' });
  });
  it('constructs a private project environment without inherited configuration or credentials', () => {
    const env = managedEnvironment('/app/tools', '/private/test-home');
    expect(env.PATH).toBe(
      '/app/tools/bin:/app/tools/node/bin:/app/tools/git/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    expect(env.GIT_EXEC_PATH).toBe('/app/tools/git/libexec/git-core');
    expect(env.GIT_TEMPLATE_DIR).toBe('/app/tools/git/share/git-core/templates');
    expect(env.HOME).toBe('/private/test-home');
    expect(env.npm_config_userconfig).not.toBe(env.npm_config_globalconfig);
    expect(env.npm_config_userconfig).toBe('/private/test-home/npm-user.conf');
    expect(env.npm_config_globalconfig).toBe('/private/test-home/npm-global.conf');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('AGORA_CREDENTIALS_KEY');
    expect(env).not.toHaveProperty('AGORA_DATA_ROOT');
    expect(() => managedEnvironment('relative', '/private/home')).toThrow('invalid_toolchain_path');
  });
});
