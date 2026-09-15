import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { toolVersions } from './toolchains.js';

const required = [
  'node/bin/node',
  'node/lib/node_modules/npm/bin/npm-cli.js',
  'pnpm/bin/pnpm.cjs',
  'git/bin/git',
  'keychain',
  'secure-files',
] as const;
export interface ToolFile {
  path: string;
  sha256?: string;
  link?: string;
  executable?: boolean;
}
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inventoryToolchain(root: string): Promise<ToolFile[]> {
  const canonical = await realpath(root);
  const result: ToolFile[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (name === 'manifest.json') continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink()) {
        const link = await readlink(path);
        const actual = relative(canonical, await realpath(path));
        if (isAbsolute(link) || actual === '..' || actual.startsWith('../') || isAbsolute(actual))
          throw new Error('toolchain_external_link');
        result.push({ path: name, link });
      } else if (entry.isFile()) {
        result.push({
          path: name,
          sha256: await hashFile(path),
          executable: Boolean((await lstat(path)).mode & 0o111),
        });
      } else throw new Error('toolchain_invalid_file');
    }
  }
  await visit(resolve(root));
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function componentError(path: string) {
  const component =
    path.startsWith('node/lib/node_modules/npm') || path === 'bin/npm' || path === 'bin/npx'
      ? 'npm'
      : path.startsWith('node/') || path === 'bin/node'
        ? 'node'
        : path.startsWith('pnpm/') || path === 'bin/pnpm'
          ? 'pnpm'
          : path.startsWith('git/')
            ? 'git'
            : path === 'keychain'
              ? 'keychain'
              : path === 'secure-files'
                ? 'files'
                : 'manifest';
  return new Error(`toolchain_${component}_invalid`);
}
export async function verifyToolchain(root: string, arch: string = process.arch) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('toolchain_invalid_root');
  const manifestPath = join(root, 'manifest.json');
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    throw new Error('toolchain_invalid_manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    !['arm64', 'x64'].includes(arch) ||
    manifest.arch !== arch ||
    manifest.platform !== 'darwin' ||
    manifest.format !== 1
  )
    throw new Error('toolchain_arch_mismatch');
  if (JSON.stringify(manifest.versions) !== JSON.stringify(toolVersions))
    throw new Error('toolchain_version_mismatch');
  const inventory = await inventoryToolchain(root);
  if (!Array.isArray(manifest.files)) throw new Error('toolchain_invalid_manifest');
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.files)) {
    const mismatch = inventory.find(
      (entry, index) => JSON.stringify(entry) !== JSON.stringify(manifest.files[index]),
    );
    throw componentError(mismatch?.path ?? 'manifest.json');
  }
  for (const name of required) {
    const entry = inventory.find((file) => file.path === name);
    if (!entry?.sha256 || (!name.endsWith('.js') && !name.endsWith('.cjs') && !entry.executable))
      throw componentError(name);
  }
  for (const name of ['git/libexec/git-core', 'git/share/git-core/templates', 'bin']) {
    const info = await lstat(join(root, name));
    if (!info.isDirectory() || info.isSymbolicLink()) throw componentError(name);
  }
  return { state: 'ready' as const, versions: toolVersions };
}
