/** Internal fixed-input store. Capturing bytes does not grant a workspace or
 * attest that a command executed them; the caller must supply current authority. */
import { createHash } from 'node:crypto';
import {
  type FileVersionV1,
  isFileChangeV1,
  isFileVersionV1,
  isWorkspaceVersionV1,
  type WorkspaceRefV1,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import {
  inspectLocalDirectory,
  inspectLocalFileBytes,
  type LocalRootBinding,
  type ReplacementBytesBasis,
} from './local-file-transaction';
import { localRecordHash } from './local-registry-records';
import { isLocalReservedName } from './local-reserved-path';

export type LocalVersionScope = {
  projectId: string;
  taskId: string;
  rootId: string;
  policyHash: string;
};
type RegularVersion = Extract<FileVersionV1, { kind: 'regular' }>;
type Directory = ReturnType<typeof inspectLocalDirectory> & { path: string };
export interface LocalFileManifest extends LocalVersionScope {
  schemaVersion: 'local-file-manifest-v1';
  bindingHash: string;
  directories: Directory[];
  files: { path: string; version: RegularVersion; contentHash: string }[];
  excludedPaths: string[];
}
type Authorize = (stage: 'admission' | 'read' | 'verification' | 'completion') => Promise<boolean>;
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const id = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const pathOrder = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
export function localSnapshotVersion(workspace: WorkspaceRefV1): WorkspaceVersionV1 {
  if (
    workspace.purpose !== 'validation' ||
    workspace.mode !== 'direct' ||
    !/^manifest:[a-f0-9]{64}$/.test(workspace.baselineManifestId)
  )
    throw Error('invalid_workspace_version');
  return {
    kind: 'files',
    manifestId: workspace.baselineManifestId,
    manifestHash: workspace.baselineManifestId.slice(9),
  };
}
export function localFileVersion(basis: ReplacementBytesBasis): RegularVersion {
  return {
    kind: 'regular',
    identity: basis.identity,
    sha256: digest(basis.content),
    size: basis.content.length,
    executable: (Number(basis.metadata.split(':')[0]) & 0o111) !== 0,
    metadataHash: digest(basis.metadata),
  };
}
function scopeValid(scope: LocalVersionScope) {
  localRecordHash(scope);
  if (
    Object.keys(scope).sort().join(',') !== 'policyHash,projectId,rootId,taskId' ||
    ![scope.projectId, scope.taskId, scope.rootId].every(id) ||
    !/^[a-f0-9]{64}$/.test(scope.policyHash)
  )
    throw Error('workspace_version_scope_mismatch');
}
async function authorized(check: Authorize, stage: Parameters<Authorize>[0]) {
  if (!(await check(stage))) throw Error('authorization_closed');
}
export class LocalVersionStore {
  constructor(
    private readonly objects: LocalControlObjects,
    private readonly helper: string,
  ) {}
  async capture(
    scope: LocalVersionScope,
    root: LocalRootBinding,
    authorize: Authorize,
  ): Promise<WorkspaceVersionV1> {
    scopeValid(scope);
    scope = structuredClone(scope);
    root = structuredClone(root);
    await authorized(authorize, 'admission');
    const manifest: LocalFileManifest = {
      ...scope,
      schemaVersion: 'local-file-manifest-v1',
      bindingHash: localRecordHash(root),
      directories: [],
      files: [],
      excludedPaths: [],
    };
    const pending = [''];
    let count = 0,
      size = 0;
    while (pending.length) {
      const directory = pending.pop() as string;
      await authorized(authorize, 'read');
      const listing = inspectLocalDirectory(root, directory, this.helper);
      manifest.directories.push({ path: directory, ...listing });
      for (const entry of listing.entries) {
        if (++count > 4096) throw Error('workspace_version_limit');
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.kind === 'excluded') manifest.excludedPaths.push(path);
        else if (entry.kind === 'directory') pending.push(path);
        else if (entry.kind === 'unsupported') throw Error('unsupported_workspace_entry');
        else {
          await authorized(authorize, 'read');
          const basis = inspectLocalFileBytes(root, path, this.helper);
          size += basis.content.length;
          if (size > 256 * 1024 * 1024) throw Error('workspace_version_limit');
          const contentHash = await this.objects.putBytes(basis.content);
          manifest.files.push({ path, version: localFileVersion(basis), contentHash });
        }
      }
    }
    manifest.directories.sort(pathOrder);
    manifest.files.sort(pathOrder);
    manifest.excludedPaths.sort();
    await this.verifyManifest(manifest, root, authorize);
    const hash = await this.objects.put(manifest);
    await this.verifyManifest(manifest, root, authorize);
    // Object publication may yield; only the durable bytes are fixed, not the live root.
    return { kind: 'files', manifestId: `manifest:${hash}`, manifestHash: hash };
  }
  async read(version: WorkspaceVersionV1, scope: LocalVersionScope): Promise<LocalFileManifest> {
    scopeValid(scope);
    version = structuredClone(version);
    scope = structuredClone(scope);
    if (
      !isWorkspaceVersionV1(version) ||
      version.kind !== 'files' ||
      version.manifestId !== `manifest:${version.manifestHash}`
    )
      throw Error('invalid_workspace_version');
    const manifest = (await this.objects.get(version.manifestHash)) as LocalFileManifest;
    if (
      !manifest ||
      Object.keys(manifest).sort().join(',') !==
        'bindingHash,directories,excludedPaths,files,policyHash,projectId,rootId,schemaVersion,taskId' ||
      manifest.schemaVersion !== 'local-file-manifest-v1' ||
      !/^[a-f0-9]{64}$/.test(manifest.bindingHash) ||
      !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.directories) ||
      !Array.isArray(manifest.excludedPaths)
    )
      throw Error('invalid_workspace_version');
    for (const key of ['projectId', 'taskId', 'rootId', 'policyHash'] as const)
      if (manifest[key] !== scope[key]) throw Error('workspace_version_scope_mismatch');
    const declaredFiles: string[] = [],
      declaredDirectories = [''],
      excluded: string[] = [];
    const directoryPaths = new Set<string>();
    const relativePath = (value: unknown): value is string =>
      typeof value === 'string' &&
      isFileChangeV1({
        op: 'put',
        path: value,
        expected: { kind: 'absent', parentIdentity: '0:0', name: value.split('/').at(-1) },
        contentRef: 'content',
      });
    let entries = 0;
    for (const directory of manifest.directories) {
      if (
        !directory ||
        Object.keys(directory).sort().join(',') !== 'entries,identity,path' ||
        (directory.path !== '' && !relativePath(directory.path)) ||
        !/^\d+:\d+$/.test(directory.identity) ||
        !Array.isArray(directory.entries) ||
        directoryPaths.has(directory.path)
      )
        throw Error('invalid_workspace_version');
      directoryPaths.add(directory.path);
      const names = new Set<string>();
      for (const entry of directory.entries) {
        if (
          ++entries > 4096 ||
          !entry ||
          Object.keys(entry).sort().join(',') !== 'kind,name' ||
          !relativePath(entry.name) ||
          entry.name.includes('/') ||
          names.has(entry.name)
        )
          throw Error('invalid_workspace_version');
        names.add(entry.name);
        const path = directory.path ? `${directory.path}/${entry.name}` : entry.name;
        const isExcluded = isLocalReservedName(entry.name);
        if (isExcluded ? entry.kind !== 'excluded' : !['file', 'directory'].includes(entry.kind))
          throw Error('invalid_workspace_version');
        if (entry.kind === 'excluded') excluded.push(path);
        else if (entry.kind === 'directory') declaredDirectories.push(path);
        else declaredFiles.push(path);
      }
    }
    const sorted = (values: string[]) => [...values].sort();
    if (
      localRecordHash(sorted([...directoryPaths])) !==
        localRecordHash(sorted(declaredDirectories)) ||
      localRecordHash(sorted(excluded)) !== localRecordHash(manifest.excludedPaths)
    )
      throw Error('invalid_workspace_version');
    const paths = new Set<string>();
    let bytesTotal = 0;
    for (const file of manifest.files) {
      if (
        !file ||
        Object.keys(file).sort().join(',') !== 'contentHash,path,version' ||
        !isFileVersionV1(file.version) ||
        file.version.kind !== 'regular' ||
        !isFileChangeV1({
          op: 'put',
          path: file.path,
          expected: file.version,
          contentRef: file.contentHash,
        }) ||
        file.contentHash !== file.version.sha256 ||
        paths.has(file.path)
      )
        throw Error('invalid_workspace_version');
      paths.add(file.path);
      const bytes = await this.objects.getBytes(file.contentHash);
      if (bytes.length !== file.version.size) throw Error('invalid_workspace_version');
      bytesTotal += bytes.length;
      if (bytesTotal > 256 * 1024 * 1024) throw Error('workspace_version_limit');
    }
    if (localRecordHash(sorted([...paths])) !== localRecordHash(sorted(declaredFiles)))
      throw Error('invalid_workspace_version');
    return manifest;
  }
  async verify(
    version: WorkspaceVersionV1,
    scope: LocalVersionScope,
    root: LocalRootBinding,
    authorize: Authorize,
  ) {
    root = structuredClone(root);
    scope = structuredClone(scope);
    version = structuredClone(version);
    await this.verifyManifest(await this.read(version, scope), root, authorize);
  }
  private async verifyManifest(
    manifest: LocalFileManifest,
    root: LocalRootBinding,
    authorize: Authorize,
  ) {
    await authorized(authorize, 'verification');
    if (manifest.bindingHash !== localRecordHash(root)) throw Error('root_identity_changed');
    for (const directory of manifest.directories) {
      await authorized(authorize, 'read');
      const current = {
        path: directory.path,
        ...inspectLocalDirectory(root, directory.path, this.helper),
      };
      if (localRecordHash(current) !== localRecordHash(directory))
        throw Error('file_version_conflict');
    }
    for (const file of manifest.files) {
      await authorized(authorize, 'read');
      if (
        localRecordHash(localFileVersion(inspectLocalFileBytes(root, file.path, this.helper))) !==
        localRecordHash(file.version)
      )
        throw Error('file_version_conflict');
    }
    await authorized(authorize, 'completion');
    const rootEntry = manifest.directories.find((entry) => entry.path === '');
    if (
      !rootEntry ||
      localRecordHash({ path: '', ...inspectLocalDirectory(root, '', this.helper) }) !==
        localRecordHash(rootEntry)
    )
      throw Error('file_version_conflict');
  }
}
