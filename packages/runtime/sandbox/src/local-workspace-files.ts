import type { WorkspaceFileRead, WorkspaceReadSetEntry } from './workspace-port';

export type { WorkspaceFileRead, WorkspaceReadSetEntry } from './workspace-port';

/** Versioned file reads bound to canonical workspace/worker authority. Opaque
 * receipt IDs address private immutable facts, never filesystem paths. */
import {
  type FileVersionV1,
  isFileChangeV1,
  isFileVersionV1,
  isWorkspaceCall,
  type WorkspaceCall,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { inspectLocalCreationBasis, inspectLocalFileBytes } from './local-file-transaction';
import { localRecordHash } from './local-registry-records';
import { LocalVersionStore, localFileVersion } from './local-version-store';
import type { LocalWorkspaceAuthority } from './local-workspace-authority';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type StoredReadSet = {
  schemaVersion: 'workspace-read-set-v1';
  call: WorkspaceCall;
  entries: WorkspaceReadSetEntry[];
};
type StoredRead = WorkspaceCall & {
  schemaVersion: 'workspace-file-read-v1';
  receiptId: string;
  stage: 'applied';
  createdAt: number;
  canonicalSourceRef: string;
  inputHash: string;
  path: string;
  bindingHash: string;
  version: FileVersionV1;
  contentHash: string | null;
  metadata: string | null;
};
function receiptCall(saved: StoredRead): WorkspaceCall {
  return {
    projectId: saved.projectId,
    taskId: saved.taskId,
    workspaceId: saved.workspaceId,
    workerId: saved.workerId,
    actionId: saved.actionId,
    grantRevision: saved.grantRevision,
    writerEpoch: saved.writerEpoch,
  };
}
export class LocalWorkspaceFiles {
  private operationGuard: ((call: WorkspaceCall) => Promise<void>) | undefined;
  constructor(
    private readonly authority: LocalWorkspaceAuthority,
    private readonly objects: LocalControlObjects,
    private readonly helper: string,
  ) {}
  bindOperationGuard(guard: (call: WorkspaceCall) => Promise<void>) {
    if (this.operationGuard) throw Error('workspace_guard_already_bound');
    this.operationGuard = guard;
  }
  async storeContent(input: WorkspaceCall, bytes: Buffer): Promise<string> {
    const call = structuredClone(input),
      content = Buffer.from(bytes);
    await this.authority.assertCall(call, 'edit');
    const hash = await this.objects.putBytes(content);
    await this.authority.assertCall(call, 'edit');
    return hash;
  }
  async readFile(input: WorkspaceCall, path: string): Promise<WorkspaceFileRead> {
    localRecordHash(input);
    const call = structuredClone(input);
    return serializeWorkspaceOperation(call, async () => {
      await this.operationGuard?.(call);
      return this.read(call, path);
    });
  }
  private async read(input: WorkspaceCall, path: string): Promise<WorkspaceFileRead> {
    const call = structuredClone(input);
    if (
      typeof path !== 'string' ||
      !isFileChangeV1({
        op: 'put',
        path,
        expected: { kind: 'absent', parentIdentity: '0:0', name: path.split('/').at(-1) },
        contentRef: 'content',
      })
    )
      throw Error('invalid_workspace_path');
    const admitted = await this.authority.assertCall(call, 'read');
    const inputHash = localRecordHash({ call, path });
    const actionKey = localRecordHash({
      kind: 'workspace-file-action',
      projectId: call.projectId,
      taskId: call.taskId,
      actionId: call.actionId,
    });
    if (admitted.workspace.purpose === 'validation')
      return this.readSnapshot(call, path, admitted, actionKey);
    const existing = await this.objects.getReference(actionKey);
    if (existing) {
      const saved = (await this.objects.get(existing)) as StoredRead;
      if (
        saved.schemaVersion !== 'workspace-file-read-v1' ||
        saved.inputHash !== inputHash ||
        localRecordHash(receiptCall(saved)) !== localRecordHash(call) ||
        saved.path !== path ||
        saved.bindingHash !== localRecordHash(admitted.binding) ||
        saved.canonicalSourceRef !== admitted.sourceReceiptId ||
        saved.receiptId !== `read:${actionKey}`
      )
        throw Error('operation_conflict');
      const result = await this.result(saved);
      await this.authority.assertCall(call, 'read');
      return result;
    }
    let version: FileVersionV1,
      contentHash: string | null = null,
      metadata: string | null = null;
    try {
      const basis = inspectLocalFileBytes(admitted.binding, path, this.helper);
      version = localFileVersion(basis);
      metadata = basis.metadata;
      contentHash = await this.objects.putBytes(basis.content);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'native_read_failed') throw error;
      await this.authority.assertCall(call, 'read');
      const absent = inspectLocalCreationBasis(admitted.binding, path, this.helper);
      version = {
        kind: 'absent',
        parentIdentity: absent.parentIdentity,
        name: path.split('/').at(-1) as string,
      };
    }
    const record: StoredRead = {
      schemaVersion: 'workspace-file-read-v1',
      ...call,
      receiptId: `read:${actionKey}`,
      stage: 'applied',
      createdAt: Date.now(),
      canonicalSourceRef: admitted.sourceReceiptId,
      path,
      inputHash,
      bindingHash: localRecordHash(admitted.binding),
      version,
      contentHash,
      metadata,
    };
    await this.authority.assertCall(call, 'read');
    const receiptHash = await this.objects.put(record);
    await this.objects.bindReference(actionKey, receiptHash);
    const result = await this.result(record);
    await this.authority.assertCall(call, 'read');
    return result;
  }
  private async readSnapshot(
    call: WorkspaceCall,
    path: string,
    admitted: Awaited<ReturnType<LocalWorkspaceAuthority['assertCall']>>,
    actionKey: string,
  ): Promise<WorkspaceFileRead> {
    const workspace = admitted.workspace;
    if (
      workspace.mode !== 'direct' ||
      !/^manifest:[a-f0-9]{64}$/.test(workspace.baselineManifestId)
    )
      throw Error('invalid_workspace_version');
    const version = {
      kind: 'files' as const,
      manifestId: workspace.baselineManifestId,
      manifestHash: workspace.baselineManifestId.slice(9),
    };
    const manifest = await new LocalVersionStore(this.objects, this.helper).read(version, {
      projectId: call.projectId,
      taskId: call.taskId,
      rootId: admitted.root.rootId,
      policyHash: admitted.grant.policyHash,
    });
    if (
      manifest.bindingHash !== localRecordHash(admitted.binding) ||
      manifest.excludedPaths.some(
        (excluded) => path === excluded || path.startsWith(`${excluded}/`),
      ) ||
      manifest.directories.some((directory) => directory.path === path)
    )
      throw Error('unsupported_workspace_entry');
    const file = manifest.files.find((file) => file.path === path);
    const parent = manifest.directories.find(
      (directory) => directory.path === path.split('/').slice(0, -1).join('/'),
    );
    if (!parent) throw Error('invalid_workspace_path');
    const record = {
      schemaVersion: 'workspace-snapshot-read-v1',
      call,
      path,
      canonicalSourceRef: admitted.sourceReceiptId,
      version,
    };
    const existing = await this.objects.getReference(actionKey);
    if (existing && localRecordHash(await this.objects.get(existing)) !== localRecordHash(record))
      throw Error('operation_conflict');
    await this.authority.assertCall(call, 'read');
    if (!existing) await this.objects.bindReference(actionKey, await this.objects.put(record));
    const readReceiptId = `snapshot-read:${actionKey}`;
    const result: WorkspaceFileRead = file
      ? {
          kind: 'file',
          readReceiptId,
          version: file.version,
          content: await this.objects.getBytes(file.contentHash),
        }
      : {
          kind: 'absent',
          readReceiptId,
          version: {
            kind: 'absent',
            parentIdentity: parent.identity,
            name: path.split('/').at(-1) as string,
          },
        };
    await this.authority.assertCall(call, 'read');
    return result;
  }
  async prepareReadSet(
    input: WorkspaceCall,
    inputEntries: readonly WorkspaceReadSetEntry[],
  ): Promise<string> {
    localRecordHash({ input, inputEntries });
    const call = structuredClone(input),
      entries = structuredClone([...inputEntries]);
    return serializeWorkspaceOperation(call, async () => {
      const key = localRecordHash({
        kind: 'workspace-file-action',
        projectId: call.projectId,
        taskId: call.taskId,
        actionId: call.actionId,
      });
      const record = {
        schemaVersion: 'workspace-read-set-v1',
        call,
        entries,
      };
      const previous = await this.objects.getReference(key);
      if (previous) {
        // Replaying an immutable input does not admit another operation. The
        // eventual writer still validates its exact action and terminal facts.
        // In particular, a partial batch must remain queryable under its first
        // action while new reads and writes remain closed for recovery.
        if (localRecordHash(await this.objects.get(previous)) !== localRecordHash(record))
          throw Error('operation_conflict');
        await this.validateReadSet(call, entries);
        await this.authority.assertCall(call, 'edit');
        return `readset:${key}`;
      }
      await this.operationGuard?.(call);
      await this.validateReadSet(call, entries);
      const hash = await this.objects.put(record);
      await this.objects.bindReference(key, hash);
      await this.authority.assertCall(call, 'edit');
      return `readset:${key}`;
    });
  }
  async loadReadSet(call: WorkspaceCall, receiptId: string): Promise<WorkspaceReadSetEntry[]> {
    if (!/^readset:[a-f0-9]{64}$/.test(receiptId)) throw Error('invalid_file_receipt');
    const hash = await this.objects.getReference(receiptId.slice(8));
    if (!hash) throw Error('invalid_file_receipt');
    const value = (await this.objects.get(hash)) as StoredReadSet;
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'call,entries,schemaVersion' ||
      value.schemaVersion !== 'workspace-read-set-v1' ||
      !isWorkspaceCall(value.call) ||
      localRecordHash({ ...value.call, actionId: call.actionId }) !== localRecordHash(call)
    )
      throw Error('file_basis_mismatch');
    const key = localRecordHash({
      kind: 'workspace-file-action',
      projectId: value.call.projectId,
      taskId: value.call.taskId,
      actionId: value.call.actionId,
    });
    if (receiptId !== `readset:${key}`) throw Error('file_basis_mismatch');
    await this.validateReadSet(call, value.entries);
    return value.entries;
  }
  private async validateReadSet(call: WorkspaceCall, entries: WorkspaceReadSetEntry[]) {
    if (
      !isWorkspaceCall(call) ||
      !Array.isArray(entries) ||
      entries.length < 1 ||
      entries.length > 64 ||
      new Set(entries.map((entry) => entry?.path)).size !== entries.length
    )
      throw Error('invalid_file_read_set');
    for (const entry of entries) {
      if (!entry || Object.keys(entry).sort().join(',') !== 'path,readReceiptId,version')
        throw Error('invalid_file_read_set');
      await this.loadBasis(call, entry.path, entry.version, entry.readReceiptId);
    }
  }
  async loadBasis(
    call: WorkspaceCall,
    path: string,
    version: FileVersionV1,
    readReceiptId: string,
  ) {
    const admitted = await this.authority.assertCall(call, 'edit');
    if (!/^read:[a-f0-9]{64}$/.test(readReceiptId)) throw Error('invalid_file_receipt');
    const hash = await this.objects.getReference(readReceiptId.slice(5));
    if (!hash) throw Error('invalid_file_receipt');
    const saved = (await this.objects.get(hash)) as StoredRead;
    if (
      saved.receiptId !== readReceiptId ||
      saved.path !== path ||
      localRecordHash({ ...receiptCall(saved), actionId: call.actionId }) !==
        localRecordHash(call) ||
      localRecordHash(saved.version) !== localRecordHash(version) ||
      saved.bindingHash !== localRecordHash(admitted.binding) ||
      saved.canonicalSourceRef !== admitted.sourceReceiptId
    )
      throw Error('file_basis_mismatch');
    const result = await this.result(saved);
    await this.authority.assertCall(call, 'edit');
    return { ...result, metadata: saved.metadata, contentHash: saved.contentHash };
  }
  private async result(saved: StoredRead): Promise<WorkspaceFileRead> {
    if (
      Object.keys(saved).sort().join(',') !==
        'actionId,bindingHash,canonicalSourceRef,contentHash,createdAt,grantRevision,inputHash,metadata,path,projectId,receiptId,schemaVersion,stage,taskId,version,workerId,workspaceId,writerEpoch' ||
      saved.schemaVersion !== 'workspace-file-read-v1' ||
      !isWorkspaceCall(receiptCall(saved)) ||
      saved.inputHash !== localRecordHash({ call: receiptCall(saved), path: saved.path }) ||
      !isFileVersionV1(saved.version) ||
      saved.stage !== 'applied' ||
      !Number.isSafeInteger(saved.createdAt) ||
      saved.createdAt < 0
    )
      throw Error('invalid_file_receipt');
    const readReceiptId = saved.receiptId;
    if (saved.version.kind === 'absent') {
      if (saved.contentHash !== null || saved.metadata !== null)
        throw Error('invalid_file_receipt');
      return { kind: 'absent', readReceiptId, version: saved.version };
    }
    if (saved.contentHash !== saved.version.sha256 || saved.metadata === null)
      throw Error('invalid_file_receipt');
    const content = await this.objects.getBytes(saved.contentHash);
    if (
      content.length !== saved.version.size ||
      localRecordHash(
        localFileVersion({ identity: saved.version.identity, metadata: saved.metadata, content }),
      ) !== localRecordHash(saved.version)
    )
      throw Error('invalid_file_receipt');
    return { kind: 'file', readReceiptId, version: saved.version, content };
  }
}
