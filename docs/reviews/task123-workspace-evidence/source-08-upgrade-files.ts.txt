import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function syncDirectory(root: string) {
  const directory = await open(root, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw new Error('unsafe_upgrade_directory');
}
export async function upgradePath(root: string, name: string) {
  const parts = name.split('/');
  if (
    !name ||
    name.includes('\\') ||
    parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
    name === '.desktop-owner'
  )
    throw new Error('invalid_upgrade_path');
  let path = root;
  await privateDirectory(path);
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid_upgrade_path');
  }
  return join(root, name);
}
export async function readRegular(path: string, limit = 16 * 1024 * 1024) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('invalid_upgrade_file');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function atomicWrite(path: string, bytes: Buffer) {
  const temporary = join(dirname(path), `.upgrade-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await file.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
