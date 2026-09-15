import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function contained(root: string, path: string) {
  const name = relative(root, path);
  if (isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`))
    throw new Error('external_resource');
  return name;
}
function allowed(name: string) {
  if (
    name
      .split(/[\\/]/)
      .some((part) => part.startsWith('.env') || ['.git', '.data', '.desktop-owner'].includes(part))
  )
    throw new Error('forbidden_resource');
}
export function reviewTraceFile(name: string): 'runtime' | 'development' | 'other-platform' {
  allowed(name);
  if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('external_resource');
  // Next's directory tracing also finds repository sources; compiled server chunks own these.
  if (
    /^apps\/web\/(?:src\/.*\.tsx?|test\/[^/]+\.test\.ts|next-env\.d\.ts|scripts\/[^/]+\.d\.mts)$/.test(
      name,
    )
  )
    return 'development';
  if (/^node_modules\/\.pnpm\/ssh2@[^/]+\/node_modules\/ssh2\/util\/pagent\.exe$/.test(name))
    return 'other-platform';
  if (
    /^apps\/web\/node_modules\/(?:next|react|react-dom|dockerode|@deepseek-ai\/dsh-llm-pi-ai)$/.test(
      name,
    ) ||
    (/^node_modules\//.test(name) &&
      (/\.(?:[cm]?js|json|css|map|proto|node|dylib)$/.test(name) ||
        /\/(?:license|licence|notice|copying|copyright)(?:\.[^/]*)?$/i.test(name) ||
        /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/.test(name))) ||
    /^(?:package\.json|packages\/[^/]+\/[^/]+\/package\.json|apps\/web\/package\.json)$/.test(
      name,
    ) ||
    /^apps\/web\/\.next\//.test(name) ||
    /^apps\/web\/scripts\/local-(?:process|diagnostics)\.mjs$/.test(name)
  )
    return 'runtime';
  throw new Error('unknown_trace_resource');
}
export async function copyTracedFile(source: string, target: string, file: string) {
  const name = contained(source, file);
  allowed(name);
  const canonicalSource = await realpath(source);
  const real = await realpath(file);
  allowed(contained(canonicalSource, real));
  const info = await lstat(file);
  const output = join(target, name);
  await mkdir(dirname(output), { recursive: true });
  if (info.isSymbolicLink()) {
    const link = join(target, contained(canonicalSource, real));
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(output), link), output).catch(async (error) => {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await realpath(output)) !== (await realpath(link))
      )
        throw error;
    });
  } else if (info.isFile()) await copyFile(file, output);
  else throw new Error('unknown_resource_type');
}
export async function auditResources(root: string) {
  const canonical = await realpath(root);
  const files: { path: string; sha256: string; bytes: number }[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      const name = relative(root, file);
      allowed(name);
      if (entry.isSymbolicLink()) {
        try {
          contained(canonical, await realpath(file));
        } catch {
          throw new Error('external_resource_link');
        }
      } else if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        files.push({
          path: name,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
        });
      } else throw new Error('unknown_resource_type');
    }
  }
  await walk(resolve(root));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
