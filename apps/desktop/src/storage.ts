import { constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function acquireState(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error('unsafe_state_path');
  const root = await realpath(path);
  const lock = join(root, '.desktop-owner');
  const handle = await open(lock, 'wx', 0o600).catch(() => {
    throw new Error('state_in_use');
  });
  const identity = await handle.stat();
  await handle.writeFile(JSON.stringify({ pid: process.pid, version: 1 }));
  await handle.sync();
  let released = false;
  return {
    root,
    async release() {
      if (released) return;
      const current = await lstat(lock);
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink())
        throw new Error('state_owner_changed');
      await unlink(lock);
      await handle.close();
      released = true;
    },
  };
}

export async function initializeFormat(root: string) {
  const upgrade = join(dirname(root), 'upgrade');
  try {
    const info = await lstat(upgrade);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(upgrade)).length)
      throw new Error('upgrade_requires_quiescence');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const path = join(root, 'desktop-format.json');
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('unsupported_state_version');
  }
  if (file) {
    try {
      if (!(await file.stat()).isFile() || (await file.stat()).size > 1024) throw new Error();
      const value = JSON.parse(await file.readFile('utf8'));
      if (value.version !== 1 || Object.keys(value).length !== 1) throw new Error();
    } catch {
      throw new Error('unsupported_state_version');
    } finally {
      await file.close();
    }
    return;
  }
  if ((await readdir(root)).some((entry) => entry !== '.desktop-owner'))
    throw new Error('unsupported_state_version');
  const temporary = `${path}.prepared`;
  const output = await open(temporary, 'wx', 0o600);
  try {
    await output.writeFile('{"version":1}\n');
    await output.sync();
  } finally {
    await output.close();
  }
  await rename(temporary, path);
  const directory = await open(root, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
