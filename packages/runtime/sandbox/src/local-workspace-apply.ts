import type { WorkspaceFileApply } from './workspace-port';

export type { WorkspaceFileApply } from './workspace-port';

/** Versioned native file transactions composed with durable batch accounting. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FileChangeV1,
  type FileVersionV1,
  isFileChangeV1,
  isFileVersionV1,
  isWorkspaceCall,
  type WorkspaceCall,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import {
  applyLocalCreation,
  applyLocalReplacement,
  inspectLocalFileBytes,
  type LocalCreationReceipt,
  type LocalReplacementReceipt,
} from './local-file-transaction';
import type { LocalRegistryOwner } from './local-registry-file';
import { localRecordHash } from './local-registry-records';
import { localFileVersion } from './local-version-store';
import type { LocalWorkspaceAuthority } from './local-workspace-authority';
import { LocalWorkspaceBatch, type WorkspaceFileBatchApply } from './local-workspace-batch';
import type { LocalWorkspaceFiles } from './local-workspace-files';
import { serializeWorkspaceOperation } from './local-workspace-operation';

type Put = Extract<FileChangeV1, { op: 'put' }>;
type Prepared = WorkspaceCall & {
  schemaVersion: 'workspace-file-apply-prepared-v1';
  receiptId: string;
  inputHash: string;
  stage: 'prepared';
  createdAt: number;
  canonicalSourceRef: string;
  rootId: string;
  bindingHash: string;
  change: Put;
  basisReceiptId: string;
  nativeActionId: string;
};
const actionKey = (call: WorkspaceCall) =>
  localRecordHash({
    kind: 'workspace-file-action',
    projectId: call.projectId,
    taskId: call.taskId,
    actionId: call.actionId,
  });
const phaseKey = (key: string, phase: string) => localRecordHash({ key, phase });
export class LocalWorkspaceApply {
  private readonly batch: LocalWorkspaceBatch;
  private commandGuard: ((call: WorkspaceCall, allowed?: string) => Promise<void>) | undefined;
  bindCommandGuard(guard: (call: WorkspaceCall, allowed?: string) => Promise<void>) {
    if (this.commandGuard) throw Error('workspace_guard_already_bound');
    this.commandGuard = guard;
  }
  private constructor(
    private readonly owner: LocalRegistryOwner,
    private readonly authority: LocalWorkspaceAuthority,
    private readonly objects: LocalControlObjects,
    private readonly files: LocalWorkspaceFiles,
    private readonly helper: string,
    private readonly journalRoot: string,
    private readonly identity: string,
  ) {
    this.batch = new LocalWorkspaceBatch(
      authority,
      objects,
      files,
      helper,
      (call, change, basis, key) => this.apply(call, change, basis, key),
      async (call) => {
        const key = actionKey(call),
          hash = await objects.getReference(key),
          result = await objects.getReference(phaseKey(key, 'result'));
        if (!hash || !result || (await objects.getReference(phaseKey(key, 'invalidation'))))
          throw Error('workspace_file_recovery_required');
        const prepared = (await objects.get(hash)) as Prepared;
        for (const field of Object.keys(call) as (keyof WorkspaceCall)[])
          if (prepared[field] !== call[field]) throw Error('invalid_file_receipt');
        return this.terminal(prepared, result);
      },
    );
  }
  static async open(
    owner: LocalRegistryOwner,
    authority: LocalWorkspaceAuthority,
    objects: LocalControlObjects,
    files: LocalWorkspaceFiles,
    helper: string,
  ) {
    await owner.assertHeld();
    const parent = join(owner.root, 'local-workspaces'),
      root = join(parent, 'file-transactions');
    if ((await realpath(parent)) !== parent) throw Error('untrusted_runtime_path');
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const fd = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    const stat = await lstat(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error('untrusted_runtime_path');
    const service = new LocalWorkspaceApply(
      owner,
      authority,
      objects,
      files,
      helper,
      root,
      `${stat.dev}:${stat.ino}`,
    );
    files.bindOperationGuard((call) => service.assertQuiescent(call));
    return service;
  }
  private async assertRoot() {
    await this.owner.assertHeld();
    const stat = await lstat(this.journalRoot);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      `${stat.dev}:${stat.ino}` !== this.identity ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error('untrusted_runtime_path');
  }
  async assertQuiescent(call: WorkspaceCall, allowedAction?: string, allowedBatch?: string) {
    await this.authority.assertCall(call, 'read');
    await this.assertClosedOperations(call, allowedAction, allowedBatch);
  }
  /** Closing a paused session audits existing operations without admitting
   * new tools. The original live lease and canonical binding remain required. */
  async assertLifecycleQuiescent(call: WorkspaceCall) {
    await this.authority.assertQuiescence(call);
    await this.assertClosedOperations(call);
  }
  private async assertClosedOperations(
    call: WorkspaceCall,
    allowedAction?: string,
    allowedBatch?: string,
  ) {
    await this.assertRoot();
    await this.commandGuard?.(call, allowedAction);
    await this.batch.assertQuiescent(call, allowedBatch ?? allowedAction);
    for (const ref of await this.objects.references()) {
      const value = (await this.objects.get(ref.valueHash)) as Partial<Prepared>;
      if (
        value.schemaVersion !== 'workspace-file-apply-prepared-v1' ||
        value.projectId !== call.projectId ||
        value.taskId !== call.taskId ||
        value.workspaceId !== call.workspaceId ||
        ref.key === allowedAction
      )
        continue;
      if (ref.key !== actionKey(value as Prepared)) continue;
      const resultHash = await this.objects.getReference(phaseKey(ref.key, 'result'));
      if (!resultHash) throw Error('workspace_file_recovery_required');
      const result = await this.terminal(value as Prepared, resultHash);
      if (await this.objects.getReference(phaseKey(ref.key, 'invalidation')))
        throw Error('workspace_file_recovery_required');
      if (
        result.schemaVersion !== 'workspace-file-apply-v1' ||
        result.inputHash !== value.inputHash ||
        !result.quiescent ||
        result.needsAttention ||
        (result.stage !== 'applied' && !(result.stage === 'conflict' && result.effect === false))
      )
        throw Error('workspace_file_recovery_required');
    }
  }
  async applyFiles(
    input: WorkspaceCall,
    changes: readonly FileChangeV1[],
    basisReceiptId: string,
  ): Promise<WorkspaceFileApply | WorkspaceFileBatchApply> {
    localRecordHash({ input, changes, basisReceiptId });
    if (
      !isWorkspaceCall(input) ||
      changes.length < 1 ||
      changes.length > 64 ||
      changes.some((change) => !isFileChangeV1(change) || change.op !== 'put') ||
      new Set(changes.map((change) => change.path)).size !== changes.length ||
      (changes.length > 1 && !basisReceiptId.startsWith('readset:'))
    )
      throw Error('unsupported_file_apply_request');
    const call = structuredClone(input),
      copied = structuredClone([...changes]) as Put[];
    return serializeWorkspaceOperation(call, async () => {
      if (basisReceiptId.startsWith('readset:')) {
        await this.assertQuiescent(call, actionKey(call));
        return this.batch.apply(call, copied, basisReceiptId);
      }
      return this.apply(call, copied[0] as Put, basisReceiptId);
    });
  }
  private async apply(
    call: WorkspaceCall,
    change: Put,
    basisReceiptId: string,
    allowedBatch?: string,
  ): Promise<WorkspaceFileApply> {
    const key = actionKey(call);
    await this.assertQuiescent(call, key, allowedBatch);
    const admitted = await this.authority.assertCall(call, 'edit');
    const basis = await this.files.loadBasis(call, change.path, change.expected, basisReceiptId);
    const candidate = await this.objects.getBytes(change.contentRef);
    const inputHash = localRecordHash({
      call,
      change,
      basisReceiptId,
      bindingHash: localRecordHash(admitted.binding),
      canonicalSourceRef: admitted.sourceReceiptId,
    });
    let preparedHash = await this.objects.getReference(key);
    let prepared: Prepared;
    if (preparedHash) {
      prepared = (await this.objects.get(preparedHash)) as Prepared;
      if (
        Object.keys(prepared).sort().join(',') !==
          'actionId,basisReceiptId,bindingHash,canonicalSourceRef,change,createdAt,grantRevision,inputHash,nativeActionId,projectId,receiptId,rootId,schemaVersion,stage,taskId,workerId,workspaceId,writerEpoch' ||
        prepared.schemaVersion !== 'workspace-file-apply-prepared-v1' ||
        prepared.inputHash !== inputHash ||
        prepared.nativeActionId !== `file-${key}` ||
        prepared.receiptId !== `apply:${key}` ||
        prepared.bindingHash !== localRecordHash(admitted.binding) ||
        prepared.rootId !== admitted.root.rootId ||
        prepared.canonicalSourceRef !== admitted.sourceReceiptId ||
        prepared.stage !== 'prepared' ||
        prepared.basisReceiptId !== basisReceiptId ||
        localRecordHash(prepared.change) !== localRecordHash(change) ||
        !Number.isSafeInteger(prepared.createdAt) ||
        prepared.createdAt < 0
      )
        throw Error('operation_conflict');
      for (const field of Object.keys(call) as (keyof WorkspaceCall)[])
        if (prepared[field] !== call[field]) throw Error('operation_conflict');
    } else {
      prepared = {
        ...call,
        schemaVersion: 'workspace-file-apply-prepared-v1',
        receiptId: `apply:${key}`,
        inputHash,
        stage: 'prepared',
        createdAt: Date.now(),
        canonicalSourceRef: admitted.sourceReceiptId,
        rootId: admitted.root.rootId,
        bindingHash: localRecordHash(admitted.binding),
        change,
        basisReceiptId,
        nativeActionId: `file-${key}`,
      };
      preparedHash = await this.objects.put(prepared);
      await this.objects.bindReference(key, preparedHash);
    }
    const resultKey = phaseKey(key, 'result'),
      resultHash = await this.objects.getReference(resultKey);
    if (await this.objects.getReference(phaseKey(key, 'invalidation')))
      throw Error('workspace_file_recovery_required');
    if (resultHash) {
      const result = await this.terminal(prepared, resultHash);
      await this.authority.assertCall(call, 'edit');
      return result;
    }
    const startedKey = phaseKey(key, 'native-start'),
      started = await this.objects.getReference(startedKey);
    if (started && started !== preparedHash) throw Error('operation_conflict');
    if (started) {
      // Missing native evidence cannot prove whether an earlier side effect started.
      try {
        await lstat(join(this.journalRoot, prepared.nativeActionId, 'result.json'));
      } catch {
        throw Error('workspace_file_recovery_required');
      }
    } else await this.objects.bindReference(startedKey, preparedHash);
    let native: LocalCreationReceipt | LocalReplacementReceipt | undefined,
      observed: FileVersionV1 | null = null;
    let authorizationClosed = false;
    try {
      await this.assertRoot();
      const authorize = async () => {
        try {
          await this.assertRoot();
          await this.authority.assertCall(call, 'edit');
          return true;
        } catch {
          authorizationClosed = true;
          return false;
        }
      };
      const common = {
        actionId: prepared.nativeActionId,
        binding: admitted.binding,
        path: change.path,
        content: candidate,
        journalRoot: this.journalRoot,
        helper: this.helper,
        authorize,
      };
      if (basis.kind === 'absent' && basis.version.kind === 'absent')
        native = await applyLocalCreation({
          ...common,
          expected: { parentIdentity: basis.version.parentIdentity },
        });
      else if (basis.kind === 'file' && basis.version.kind === 'regular' && basis.metadata !== null)
        native = await applyLocalReplacement({
          ...common,
          expected: {
            identity: basis.version.identity,
            metadata: basis.metadata,
            content: basis.content,
          },
        });
      else throw Error('invalid_file_receipt');
      if (await authorize()) {
        try {
          observed = localFileVersion(
            inspectLocalFileBytes(admitted.binding, change.path, this.helper),
          );
        } catch {
          observed = null;
        }
      }
    } catch {
      /* The prepared/native-start facts remain durable; uncertainty is explicit. */
    }
    const effect = native ? ('created' in native ? native.created : native.exchanged) : null;
    const applied =
      native?.stage === 'applied' &&
      native.quiescent &&
      !authorizationClosed &&
      observed?.kind === 'regular' &&
      observed.sha256 === change.contentRef;
    const conflict =
      native?.stage === 'conflict' && effect === false && native.quiescent && !authorizationClosed;
    const stage = applied ? 'applied' : conflict ? 'conflict' : 'recoveryRequired';
    const receipt: WorkspaceFileApply = {
      ...call,
      schemaVersion: 'workspace-file-apply-v1',
      receiptId: prepared.receiptId,
      inputHash,
      stage,
      createdAt: Date.now(),
      canonicalSourceRef: admitted.sourceReceiptId,
      quiescent: native?.quiescent ?? false,
      effect,
      needsAttention: stage === 'recoveryRequired',
      items: [
        {
          path: change.path,
          expected: change.expected,
          observed,
          result: applied ? observed : null,
          baselineContentRef: basis.contentHash,
          candidateContentRef: change.contentRef,
          nativeReceiptRef: native ? await this.objects.put(native) : null,
        },
      ],
    };
    const terminalHash = await this.objects.put(receipt);
    await this.objects.bindReference(resultKey, terminalHash);
    if (receipt.stage === 'applied') {
      try {
        await this.authority.assertCall(call, 'edit');
      } catch {
        const invalidation = await this.objects.put({
          schemaVersion: 'workspace-file-invalidation-v1',
          receiptHash: terminalHash,
          inputHash,
          reason: 'authority_or_root_changed',
        });
        await this.objects.bindReference(phaseKey(key, 'invalidation'), invalidation);
        throw Error('workspace_file_recovery_required');
      }
    }
    return receipt;
  }
  private async terminal(prepared: Prepared, hash: string): Promise<WorkspaceFileApply> {
    if (prepared.nativeActionId !== `file-${actionKey(prepared)}`)
      throw Error('invalid_file_receipt');
    const receipt = (await this.objects.get(hash)) as WorkspaceFileApply;
    const keys =
      'actionId,canonicalSourceRef,createdAt,effect,grantRevision,inputHash,items,needsAttention,projectId,quiescent,receiptId,schemaVersion,stage,taskId,workerId,workspaceId,writerEpoch';
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !== keys ||
      receipt.schemaVersion !== 'workspace-file-apply-v1' ||
      receipt.receiptId !== prepared.receiptId ||
      receipt.inputHash !== prepared.inputHash ||
      receipt.canonicalSourceRef !== prepared.canonicalSourceRef ||
      !Number.isSafeInteger(receipt.createdAt) ||
      receipt.createdAt < 0 ||
      !['applied', 'conflict', 'recoveryRequired'].includes(receipt.stage) ||
      typeof receipt.quiescent !== 'boolean' ||
      ![true, false, null].includes(receipt.effect) ||
      receipt.needsAttention !== (receipt.stage === 'recoveryRequired') ||
      !Array.isArray(receipt.items) ||
      receipt.items.length !== 1
    )
      throw Error('invalid_file_receipt');
    for (const key of [
      'projectId',
      'taskId',
      'workspaceId',
      'workerId',
      'actionId',
      'grantRevision',
      'writerEpoch',
    ] as const)
      if (receipt[key] !== prepared[key]) throw Error('invalid_file_receipt');
    const item = receipt.items[0];
    if (
      !item ||
      Object.keys(item).sort().join(',') !==
        'baselineContentRef,candidateContentRef,expected,nativeReceiptRef,observed,path,result' ||
      item.path !== prepared.change.path ||
      localRecordHash(item.expected) !== localRecordHash(prepared.change.expected) ||
      item.candidateContentRef !== prepared.change.contentRef ||
      item.baselineContentRef !==
        (prepared.change.expected.kind === 'regular' ? prepared.change.expected.sha256 : null) ||
      (item.observed !== null && !isFileVersionV1(item.observed)) ||
      (receipt.stage === 'applied'
        ? !receipt.quiescent ||
          receipt.effect !== true ||
          item.result?.kind !== 'regular' ||
          item.result.sha256 !== item.candidateContentRef ||
          localRecordHash(item.result) !== localRecordHash(item.observed)
        : item.result !== null) ||
      (receipt.stage === 'conflict' && (!receipt.quiescent || receipt.effect !== false))
    )
      throw Error('invalid_file_receipt');
    if (item.nativeReceiptRef === null) {
      if (receipt.stage !== 'recoveryRequired' || receipt.effect !== null || receipt.quiescent)
        throw Error('invalid_file_receipt');
      return receipt;
    }
    const native = (await this.objects.get(item.nativeReceiptRef)) as
      | LocalCreationReceipt
      | LocalReplacementReceipt;
    await this.assertRoot();
    const directory = join(this.journalRoot, prepared.nativeActionId);
    if ((await realpath(directory)) !== directory) throw Error('workspace_file_recovery_required');
    const fd = await open(
      join(directory, 'result.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await fd.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o400 ||
        stat.size > 16384
      )
        throw Error('workspace_file_recovery_required');
      const bytes = Buffer.alloc(16385),
        { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
      if (
        bytesRead !== stat.size ||
        localRecordHash(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))) !==
          localRecordHash(native)
      )
        throw Error('workspace_file_recovery_required');
      const after = await fd.stat(),
        current = await lstat(join(directory, 'result.json'));
      if (
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.isSymbolicLink() ||
        (await realpath(directory)) !== directory
      )
        throw Error('workspace_file_recovery_required');
    } finally {
      await fd.close();
    }
    if (
      native.actionId !== prepared.nativeActionId ||
      native.quiescent !== receipt.quiescent ||
      ('created' in native ? native.created : native.exchanged) !== receipt.effect ||
      (receipt.stage === 'applied' && native.stage !== 'applied') ||
      (receipt.stage === 'conflict' && native.stage !== 'conflict')
    )
      throw Error('invalid_file_receipt');
    await this.assertRoot();
    return receipt;
  }
}
