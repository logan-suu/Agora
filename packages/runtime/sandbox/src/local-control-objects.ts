/** Private immutable control inputs. These objects never confer authority and
 * are not exposed as a path-addressed model tool. Partial files fail closed. */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash } from './local-registry-records';

const maxBytes = 16 * 1024 * 1024;
const maxFileBytes = 16 * 1024 * 1024;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function identity(path: string) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink()) throw Error('control_objects_root_changed');
  return { path, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode };
}
async function sync(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export class LocalControlObjects {
  private readonly chain: Awaited<ReturnType<typeof identity>>[] = [];
  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly root: string,
  ) {}
  static async open(owner: LocalRegistryOwner) {
    await owner.assertHeld();
    const parent = join(owner.root, 'local-workspaces');
    if ((await realpath(parent)) !== parent) throw Error('control_objects_root_changed');
    const before = await identity(parent);
    if (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o700)
      throw Error('control_objects_root_changed');
    const root = join(parent, 'objects');
    try {
      await mkdir(root, { mode: 0o700 });
      await sync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const store = new LocalControlObjects(owner, root);
    for (let path = root; ; path = dirname(path)) {
      store.chain.push(await identity(path));
      if (path === '/') break;
    }
    if (localRecordHash(store.chain[1]) !== localRecordHash(before))
      throw Error('control_objects_root_changed');
    await store.assertRoot();
    return store;
  }
  private async assertRoot() {
    await this.owner.assertHeld();
    for (const entry of this.chain)
      if (localRecordHash(await identity(entry.path)) !== localRecordHash(entry))
        throw Error('control_objects_root_changed');
    const own = this.chain[0];
    if (!own || own.uid !== process.getuid?.() || (own.mode & 0o777) !== 0o700)
      throw Error('control_objects_root_changed');
    await this.owner.assertHeld();
  }
  async put(value: unknown): Promise<string> {
    const hash = localRecordHash(value);
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > maxBytes) throw Error('invalid_control_object');
    await this.persist(hash, Buffer.from(bytes), 'json');
    await this.get(hash);
    return hash;
  }
  async putBytes(value: Buffer): Promise<string> {
    if (!Buffer.isBuffer(value) || value.length > maxFileBytes)
      throw Error('invalid_control_object');
    const bytes = Buffer.from(value),
      hash = digest(bytes);
    await this.persist(hash, bytes, 'bin');
    await this.getBytes(hash);
    return hash;
  }
  private async persist(hash: string, bytes: Buffer, extension: 'json' | 'bin' | 'ref') {
    await this.assertRoot();
    let fd: FileHandle;
    try {
      fd = await open(join(this.root, `${hash}.${extension}`), 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return;
    }
    try {
      await fd.writeFile(bytes);
      await fd.chmod(0o400);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await sync(this.root);
  }
  async get(hash: string): Promise<unknown> {
    const bytes = await this.read(hash, 'json', maxBytes);
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (localRecordHash(value) !== hash) throw Error();
      return value;
    } catch {
      throw Error('invalid_control_object');
    }
  }
  async getBytes(hash: string): Promise<Buffer> {
    const bytes = await this.read(hash, 'bin', maxFileBytes);
    if (digest(bytes) !== hash) throw Error('invalid_control_object');
    return bytes;
  }
  async bindReference(key: string, valueHash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(valueHash))
      throw Error('invalid_control_object');
    await this.get(valueHash);
    const value = { key, valueHash };
    await this.persist(
      key,
      Buffer.from(JSON.stringify({ ...value, sha256: localRecordHash(value) })),
      'ref',
    );
    if ((await this.getReference(key)) !== valueHash) throw Error('operation_conflict');
  }
  async getReference(key: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('invalid_control_object');
    await this.assertRoot();
    try {
      await lstat(join(this.root, `${key}.ref`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.assertRoot();
      return undefined;
    }
    const data = JSON.parse((await this.read(key, 'ref', 4096)).toString('utf8'));
    if (
      !data ||
      Object.keys(data).sort().join(',') !== 'key,sha256,valueHash' ||
      data.key !== key ||
      typeof data.valueHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.valueHash) ||
      data.sha256 !== localRecordHash({ key, valueHash: data.valueHash })
    )
      throw Error('invalid_control_object');
    await this.get(data.valueHash);
    return data.valueHash;
  }
  async references(): Promise<{ key: string; valueHash: string }[]> {
    await this.assertRoot();
    const names = (await readdir(this.root)).filter((name) => name.endsWith('.ref'));
    if (names.length > 4096) throw Error('control_reference_limit');
    const result: { key: string; valueHash: string }[] = [];
    for (const name of names.sort()) {
      const key = name.slice(0, -4),
        valueHash = await this.getReference(key);
      if (!valueHash) throw Error('invalid_control_object');
      result.push({ key, valueHash });
    }
    await this.assertRoot();
    return result;
  }
  private async read(
    hash: string,
    extension: 'json' | 'bin' | 'ref',
    limit: number,
  ): Promise<Buffer> {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      throw Error('invalid_control_object');
    await this.assertRoot();
    const file = join(this.root, `${hash}.${extension}`);
    let fd: FileHandle | undefined;
    let bytes: Buffer;
    try {
      fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await fd.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o777) !== 0o400 ||
        before.size > limit
      )
        throw Error();
      await fd.sync();
      await sync(this.root);
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw Error();
      bytes = buffer.subarray(0, length);
      const after = await fd.stat(),
        current = await lstat(file);
      if (
        after.size !== before.size ||
        after.ctimeMs !== before.ctimeMs ||
        after.mtimeMs !== before.mtimeMs ||
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw Error();
    } catch {
      throw Error('invalid_control_object');
    } finally {
      await fd?.close();
    }
    await this.assertRoot();
    return bytes;
  }
}
