/** Full actual U plus native metadata and current control authority. Capturing
 * this input does not acquire a writer or grant execution permission. */
import type { AppState, WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import { inspectLocalDirectoryMetadata, inspectLocalFileBytes } from './local-file-transaction';
import type { LocalQuiescentWriters } from './local-quiescent-writers';
import { assertLocalRangeAdmission, localWorkspacePhysical } from './local-range-admission';
import {
  type LocalRegistryRecords,
  type LocalUndoClaimRecord,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';
import { inspectSelectedLocalRoot } from './local-root-inspection';
import type { LocalUndoTreeInput } from './local-undo-tree-plan';
import { type LocalVersionStore, localFileVersion } from './local-version-store';
import { localRootBinding } from './local-workspace-authority';

type Scope = { projectId: string; taskId: string; workspaceId: string };
type Options = {
  control: Pick<LocalBindingCoordinator, 'snapshot' | 'assertClosed'>;
  objects: LocalControlObjects;
  versions: LocalVersionStore;
  writers: LocalQuiescentWriters;
  filesHelper: string;
  inspector: string;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  fingerprint(state: AppState): unknown;
  /** Must qualify owned Git identity and read actual HEAD/index/user metadata,
   * or prove this is a registered ordinary root without Git. No repair. */
  metadata(scope: Scope, registry: LocalRegistryRecords): Promise<unknown>;
};
export type LocalUndoCurrentRecord = Scope & {
  schemaVersion: 'local-undo-current-v1';
  writersHash: string;
  registryHash: string;
  registryRevision: number;
  rootId: string;
  grantId: string;
  grantRevision: number;
  policyHash: string;
  bindingHash: string;
  controlFingerprint: string;
  metadataHash: string;
  version: WorkspaceVersionV1;
  directories: LocalUndoTreeInput['directories'];
  files: {
    path: string;
    version: LocalUndoTreeInput['files'][number]['version'];
    metadata: string;
    contentRef: string;
  }[];
  protectedPaths: string[];
};
function fail(): never {
  throw Error('undo_current_unverified');
}
export class LocalUndoCurrentSource {
  constructor(private readonly options: Options) {}
  private bound(registry: LocalRegistryRecords, scope: Scope, ownUndoClaimId?: string) {
    const workspace = registry.workspaces.find(
        (w) =>
          w.projectId === scope.projectId &&
          w.taskId === scope.taskId &&
          w.workspaceId === scope.workspaceId,
      ),
      root =
        workspace?.mode === 'linked-worktree'
          ? registry.linkedRoots?.find(
              (r) =>
                r.projectId === scope.projectId &&
                r.taskId === scope.taskId &&
                r.workspaceId === scope.workspaceId,
            )
          : registry.roots.find(
              (r) => r.projectId === scope.projectId && r.rootId === workspace?.rootId,
            ),
      grant = registry.grants.find(
        (g) => g.projectId === scope.projectId && g.grantId === workspace?.grantId,
      );
    if (
      !workspace ||
      workspace.purpose === 'validation' ||
      !root ||
      !grant ||
      grant.status !== 'active' ||
      !grant.actions.includes('read') ||
      grant.rootId !== root.rootId
    )
      fail();
    // Only verifyOwned excludes its exact, already privately verified dedicated
    // writer. Every other undo and range barrier remains in this view.
    assertLocalRangeAdmission(
      ownUndoClaimId
        ? { ...registry, claims: registry.claims.filter((c) => c.claimId !== ownUndoClaimId) }
        : registry,
      workspace,
      [],
    );
    return {
      workspace,
      root,
      grant,
      binding: localRootBinding(root),
      versionScope: {
        projectId: scope.projectId,
        taskId: scope.taskId,
        rootId: root.rootId,
        policyHash: grant.policyHash,
      },
    };
  }
  private async authority(scope: Scope, registry: LocalRegistryRecords, writersHash: string) {
    await this.options.writers.verifyCurrent(writersHash);
    const bound = this.bound(registry, scope);
    await this.options.verifyGrant(scope, bound.grant.grantId);
    const inspected = inspectSelectedLocalRoot(bound.root.path, this.options.inspector);
    if (
      localRecordHash(inspected) !== bound.root.inspectionHash ||
      localRecordHash(await this.options.control.snapshot()) !== localRecordHash(registry)
    )
      throw Error('root_identity_changed');
    return bound;
  }
  async capture(input: Scope) {
    const scope = structuredClone(input),
      { objects, versions, filesHelper } = this.options,
      registry = await this.options.control.snapshot(),
      bound = this.bound(registry, scope),
      writers = await this.options.writers.capture(
        localWorkspacePhysical(registry, bound.workspace),
      );
    if (writers.record.registryHash !== localRecordHash(registry)) fail();
    const state = await this.options.control.assertClosed(scope),
      controlFingerprint = localRecordHash(this.options.fingerprint(state)),
      metadataHash = await objects.put(await this.options.metadata(scope, registry));
    const check = async () => {
      await this.authority(scope, registry, writers.hash);
      return (
        localRecordHash(
          this.options.fingerprint(await this.options.control.assertClosed(scope)),
        ) === controlFingerprint
      );
    };
    const version = await versions.capture(bound.versionScope, bound.binding, check),
      manifest = await versions.read(version, bound.versionScope),
      directories: LocalUndoCurrentRecord['directories'] = [],
      files: LocalUndoCurrentRecord['files'] = [];
    for (const directory of manifest.directories) {
      if (!(await check())) fail();
      const metadata = inspectLocalDirectoryMetadata(bound.binding, directory.path, filesHelper);
      if (metadata.identity !== directory.identity) fail();
      directories.push({ path: directory.path, ...metadata });
    }
    for (const file of manifest.files) {
      if (!(await check())) fail();
      const basis = inspectLocalFileBytes(bound.binding, file.path, filesHelper);
      if (
        localRecordHash(localFileVersion(basis)) !== localRecordHash(file.version) ||
        (await objects.putBytes(basis.content)) !== file.contentHash
      )
        fail();
      files.push({
        path: file.path,
        version: structuredClone(file.version),
        metadata: basis.metadata,
        contentRef: file.contentHash,
      });
    }
    const record: LocalUndoCurrentRecord = {
      schemaVersion: 'local-undo-current-v1',
      ...scope,
      writersHash: writers.hash,
      registryHash: writers.record.registryHash,
      registryRevision: registry.revision,
      rootId: bound.root.rootId,
      grantId: bound.grant.grantId,
      grantRevision: bound.grant.revision,
      policyHash: bound.grant.policyHash,
      bindingHash: localRecordHash(bound.binding),
      controlFingerprint,
      metadataHash,
      version,
      directories,
      files,
      protectedPaths: [...manifest.excludedPaths],
    };
    const hash = await objects.put(record);
    await this.verifyCurrent(hash);
    return { hash, record, tree: await this.tree(record) };
  }
  async tree(record: LocalUndoCurrentRecord): Promise<LocalUndoTreeInput> {
    return {
      directories: structuredClone(record.directories),
      protectedPaths: [...record.protectedPaths],
      files: await Promise.all(
        record.files.map(async ({ contentRef, ...file }) => ({
          ...structuredClone(file),
          content: await this.options.objects.getBytes(contentRef),
        })),
      ),
    };
  }
  async read(hash: string): Promise<LocalUndoCurrentRecord> {
    const { objects } = this.options,
      record = (await objects.get(hash)) as LocalUndoCurrentRecord;
    if (
      !record ||
      Object.keys(record).sort().join(',') !==
        'bindingHash,controlFingerprint,directories,files,grantId,grantRevision,metadataHash,policyHash,projectId,protectedPaths,registryHash,registryRevision,rootId,schemaVersion,taskId,version,workspaceId,writersHash' ||
      record.schemaVersion !== 'local-undo-current-v1' ||
      !Array.isArray(record.directories) ||
      !Array.isArray(record.files) ||
      !Array.isArray(record.protectedPaths)
    )
      fail();
    const registry = parseLocalRegistry(await objects.get(record.registryHash)),
      bound = this.bound(registry, record),
      writers = await this.options.writers.read(record.writersHash),
      stateRef = writers.stateHashes.find(
        (s) => s.projectId === record.projectId && s.taskId === record.taskId,
      );
    if (!stateRef) fail();
    const state = (await objects.get(stateRef.hash)) as AppState;
    if (
      writers.registryHash !== record.registryHash ||
      registry.revision !== record.registryRevision ||
      bound.grant.grantId !== record.grantId ||
      bound.grant.revision !== record.grantRevision ||
      bound.grant.policyHash !== record.policyHash ||
      bound.root.rootId !== record.rootId ||
      localRecordHash(bound.binding) !== record.bindingHash ||
      localRecordHash(this.options.fingerprint(state)) !== record.controlFingerprint
    )
      fail();
    await objects.get(record.metadataHash);
    const manifest = await this.options.versions.read(record.version, bound.versionScope);
    if (
      manifest.bindingHash !== record.bindingHash ||
      localRecordHash(manifest.excludedPaths) !== localRecordHash(record.protectedPaths) ||
      localRecordHash(manifest.directories.map((d) => ({ path: d.path, identity: d.identity }))) !==
        localRecordHash(record.directories.map((d) => ({ path: d.path, identity: d.identity }))) ||
      localRecordHash(
        manifest.files.map((f) => ({
          path: f.path,
          version: f.version,
          contentRef: f.contentHash,
        })),
      ) !== localRecordHash(record.files.map(({ metadata: _, ...f }) => f))
    )
      fail();
    for (const file of (await this.tree(record)).files)
      if (
        localRecordHash(
          localFileVersion({
            identity: file.version.identity,
            metadata: file.metadata,
            content: file.content,
          }),
        ) !== localRecordHash(file.version)
      )
        fail();
    if (record.directories.some((d) => !/^\d+:\d+:\d+:[a-f0-9]{64}$/.test(d.metadata))) fail();
    return structuredClone(record);
  }
  async verifyCurrent(hash: string) {
    const record = await this.read(hash),
      registry = parseLocalRegistry(await this.options.objects.get(record.registryHash)),
      bound = await this.authority(record, registry, record.writersHash);
    if (
      localRecordHash(this.options.fingerprint(await this.options.control.assertClosed(record))) !==
        record.controlFingerprint ||
      localRecordHash(await this.options.metadata(record, registry)) !== record.metadataHash
    )
      throw Error('undo_current_changed');
    await this.options.versions.verify(
      record.version,
      bound.versionScope,
      bound.binding,
      async () => {
        await this.authority(record, registry, record.writersHash);
        return true;
      },
    );
    for (const d of record.directories)
      if (
        localRecordHash(
          inspectLocalDirectoryMetadata(bound.binding, d.path, this.options.filesHelper),
        ) !== localRecordHash({ identity: d.identity, metadata: d.metadata })
      )
        throw Error('undo_current_changed');
    if (localRecordHash(await this.options.metadata(record, registry)) !== record.metadataHash)
      throw Error('undo_current_changed');
    await this.authority(record, registry, record.writersHash);
  }
  /** Current root/grant/control/HEAD/index guard after this proposal acquired
   * its own undo writer. Per-path U/C and prefix checks remain the batch's duty. */
  async verifyOwned(hash: string, claim: LocalUndoClaimRecord) {
    const record = await this.read(hash),
      registry = await this.options.control.snapshot(),
      current = registry.claims.find((c) => c.claimId === claim.claimId);
    if (
      current?.kind !== 'undo' ||
      current.status !== 'active' ||
      current.closureReceiptId !== null ||
      localRecordHash(current) !== localRecordHash(claim) ||
      claim.projectId !== record.projectId ||
      claim.taskId !== record.taskId ||
      claim.workspaceId !== record.workspaceId ||
      claim.grantRevision !== record.grantRevision
    )
      fail();
    const state = await this.options.control.assertClosed(record),
      bound = this.bound(registry, record, claim.claimId);
    if (
      bound.grant.grantId !== record.grantId ||
      bound.grant.revision !== record.grantRevision ||
      bound.grant.policyHash !== record.policyHash ||
      localRecordHash(bound.binding) !== record.bindingHash ||
      localRecordHash(this.options.fingerprint(state)) !== record.controlFingerprint
    )
      throw Error('undo_control_changed');
    await this.options.verifyGrant(record, record.grantId);
    if (
      localRecordHash(inspectSelectedLocalRoot(bound.root.path, this.options.inspector)) !==
        bound.root.inspectionHash ||
      localRecordHash(await this.options.metadata(record, registry)) !== record.metadataHash ||
      (await this.options.control.snapshot()).revision !== registry.revision
    )
      throw Error('undo_control_changed');
    return bound;
  }
}
