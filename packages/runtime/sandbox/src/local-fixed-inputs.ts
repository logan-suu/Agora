/** Materialize immutable version bytes into a command-specific private tree.
 * This is a trusted service, not execution authority; the command OS policy must
 * make this tree read-only and place all outputs in a separate directory. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash } from './local-registry-records';
import type {
  LocalFileManifest,
  LocalVersionScope,
  LocalVersionStore,
} from './local-version-store';

type Authorize = () => Promise<boolean>;
export interface LocalFixedInput {
  schemaVersion: 'local-fixed-input-v1';
  actionId: string;
  scope: LocalVersionScope;
  version: WorkspaceVersionV1;
  path: string;
  directories: { path: string; identity: string }[];
  files: { path: string; identity: string }[];
}
const keyFor = (scope: LocalVersionScope, actionId: string) =>
  localRecordHash({ kind: 'fixed-command-input', scope, actionId });
async function syncDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function directory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw Error('fixed_input_changed');
  return `${stat.dev}:${stat.ino}`;
}
export class LocalFixedInputs {
  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly root: string,
    private readonly identity: string,
  ) {}
  static async open(
    owner: LocalRegistryOwner,
    objects: LocalControlObjects,
    versions: LocalVersionStore,
  ) {
    await owner.assertHeld();
    const root = join(owner.root, 'fixed-inputs');
    if ((await realpath(owner.root)) !== owner.root) throw Error('fixed_input_changed');
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await syncDirectory(owner.root);
    return new LocalFixedInputs(owner, objects, versions, root, await directory(root));
  }
  private async authorize(check: Authorize) {
    await this.owner.assertHeld();
    if ((await directory(this.root)) !== this.identity) throw Error('fixed_input_changed');
    if (!(await check())) throw Error('authorization_closed');
  }
  async materialize(
    scopeInput: LocalVersionScope,
    versionInput: WorkspaceVersionV1,
    actionId: string,
    check: Authorize,
  ): Promise<LocalFixedInput> {
    localRecordHash({ scopeInput, versionInput, actionId });
    const scope = structuredClone(scopeInput),
      version = structuredClone(versionInput);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actionId)) throw Error('invalid_command_input');
    await this.authorize(check);
    const manifest = await this.versions.read(version, scope),
      key = keyFor(scope, actionId);
    const saved = await this.objects.getReference(key);
    if (saved) {
      const receipt = (await this.objects.get(saved)) as LocalFixedInput;
      if (localRecordHash(receipt.version) !== localRecordHash(version))
        throw Error('operation_conflict');
      await this.verify(receipt, scope, version, check);
      return receipt;
    }
    const path = join(this.root, key);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw Error('fixed_input_recovery_required');
      throw error;
    }
    await syncDirectory(this.root);
    const receipt: LocalFixedInput = {
      schemaVersion: 'local-fixed-input-v1',
      actionId,
      scope,
      version,
      path,
      directories: [],
      files: [],
    };
    for (const entry of [...manifest.directories].sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
    )) {
      await this.authorize(check);
      const target = join(path, entry.path);
      if (entry.path) await mkdir(target, { mode: 0o700 });
      receipt.directories.push({ path: entry.path, identity: await directory(target) });
    }
    for (const file of manifest.files) {
      await this.authorize(check);
      const content = await this.objects.getBytes(file.contentHash);
      const fd = await open(
        join(path, file.path),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await fd.writeFile(content);
        await fd.chmod(file.version.executable ? 0o500 : 0o400);
        await fd.sync();
        const stat = await fd.stat();
        receipt.files.push({ path: file.path, identity: `${stat.dev}:${stat.ino}` });
      } finally {
        await fd.close();
      }
    }
    for (const entry of [...receipt.directories].reverse())
      await syncDirectory(join(path, entry.path));
    await this.checkTree(receipt, manifest, check);
    await this.objects.bindReference(key, await this.objects.put(receipt));
    await this.authorize(check);
    return receipt;
  }
  async verify(
    input: LocalFixedInput,
    scopeInput: LocalVersionScope,
    versionInput: WorkspaceVersionV1,
    check: Authorize,
  ): Promise<void> {
    localRecordHash({ input, scopeInput, versionInput });
    const receipt = structuredClone(input),
      scope = structuredClone(scopeInput),
      version = structuredClone(versionInput);
    await this.authorize(check);
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !==
        'actionId,directories,files,path,schemaVersion,scope,version' ||
      receipt.schemaVersion !== 'local-fixed-input-v1' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.actionId) ||
      localRecordHash(receipt.scope) !== localRecordHash(scope) ||
      localRecordHash(receipt.version) !== localRecordHash(version)
    )
      throw Error('invalid_command_input');
    const key = keyFor(scope, receipt.actionId),
      saved = await this.objects.getReference(key);
    if (!saved || saved !== localRecordHash(receipt) || receipt.path !== join(this.root, key))
      throw Error('invalid_command_input');
    await this.checkTree(receipt, await this.versions.read(version, scope), check);
  }
  private async checkTree(receipt: LocalFixedInput, manifest: LocalFileManifest, check: Authorize) {
    if (
      !Array.isArray(receipt.directories) ||
      !Array.isArray(receipt.files) ||
      receipt.directories.length !== manifest.directories.length ||
      receipt.files.length !== manifest.files.length ||
      new Set(receipt.directories.map((entry) => entry.path)).size !== receipt.directories.length ||
      new Set(receipt.files.map((entry) => entry.path)).size !== receipt.files.length
    )
      throw Error('fixed_input_changed');
    for (const entry of manifest.directories) {
      await this.authorize(check);
      const expected = receipt.directories.find((item) => item.path === entry.path),
        path = join(receipt.path, entry.path);
      if (
        !expected ||
        Object.keys(expected).sort().join(',') !== 'identity,path' ||
        (await directory(path)) !== expected.identity
      )
        throw Error('fixed_input_changed');
      const names = entry.entries
        .filter((item) => item.kind !== 'excluded')
        .map((item) => item.name)
        .sort();
      if (localRecordHash((await readdir(path)).sort()) !== localRecordHash(names))
        throw Error('fixed_input_changed');
    }
    for (const file of manifest.files) {
      await this.authorize(check);
      const expected = receipt.files.find((item) => item.path === file.path),
        path = join(receipt.path, file.path);
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await fd.stat();
        if (
          !expected ||
          Object.keys(expected).sort().join(',') !== 'identity,path' ||
          `${before.dev}:${before.ino}` !== expected.identity ||
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== process.getuid?.() ||
          (before.mode & 0o777) !== (file.version.executable ? 0o500 : 0o400) ||
          before.size !== file.version.size ||
          before.size > 16 * 1024 * 1024
        )
          throw Error('fixed_input_changed');
        const bytes = Buffer.alloc(before.size + 1),
          { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
        const after = await fd.stat(),
          current = await lstat(path);
        if (
          bytesRead !== before.size ||
          createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex') !==
            file.contentHash ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.isSymbolicLink()
        )
          throw Error('fixed_input_changed');
      } finally {
        await fd.close();
      }
    }
    await this.authorize(check);
    for (const entry of receipt.directories)
      if ((await directory(join(receipt.path, entry.path))) !== entry.identity)
        throw Error('fixed_input_changed');
  }
}
