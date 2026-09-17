import type { WorkspaceFileBatchApply } from './workspace-port';

export type { WorkspaceFileBatchApply } from './workspace-port';

/** Bounded read-set validation and sequential, durable file application. A batch
 * is never a filesystem transaction; interrupted effects require explicit recovery. */
import {
  type FileChangeV1,
  type FileVersionV1,
  isFileChangeV1,
  isFileVersionV1,
  isWorkspaceCall,
  type WorkspaceCall,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { inspectLocalCreationBasis, inspectLocalFileBytes } from './local-file-transaction';
import { localRecordHash } from './local-registry-records';
import { localFileVersion } from './local-version-store';
import type { WorkspaceFileApply } from './local-workspace-apply';
import type { LocalWorkspaceAuthority } from './local-workspace-authority';
import type { LocalWorkspaceFiles } from './local-workspace-files';

type Put = Extract<FileChangeV1, { op: 'put' }>;
type Prepared = {
  schemaVersion: 'workspace-file-batch-prepared-v1';
  call: WorkspaceCall;
  changes: Put[];
  basisReceiptId: string;
  bindingHash: string;
  canonicalSourceRef: string;
  inputHash: string;
};
export const workspaceFileActionKey = (call: WorkspaceCall) =>
  localRecordHash({
    kind: 'workspace-file-action',
    projectId: call.projectId,
    taskId: call.taskId,
    actionId: call.actionId,
  });
const resultKey = (key: string) => localRecordHash({ key, phase: 'batch-result' });
export class LocalWorkspaceBatch {
  constructor(
    private readonly authority: LocalWorkspaceAuthority,
    private readonly objects: LocalControlObjects,
    private readonly files: LocalWorkspaceFiles,
    private readonly helper: string,
    private readonly applyOne: (
      call: WorkspaceCall,
      change: Put,
      basis: string,
      batchKey: string,
    ) => Promise<WorkspaceFileApply>,
    private readonly verifyOne: (call: WorkspaceCall) => Promise<WorkspaceFileApply>,
  ) {}
  async assertQuiescent(call: WorkspaceCall, allowedKey?: string) {
    for (const ref of await this.objects.references()) {
      const value = (await this.objects.get(ref.valueHash)) as Partial<Prepared>;
      if (value.schemaVersion !== 'workspace-file-batch-prepared-v1') continue;
      const prepared = this.prepared(value);
      if (ref.key !== workspaceFileActionKey(prepared.call)) throw Error('invalid_file_receipt');
      if (
        prepared.call.projectId !== call.projectId ||
        prepared.call.taskId !== call.taskId ||
        prepared.call.workspaceId !== call.workspaceId ||
        ref.key === allowedKey
      )
        continue;
      const hash = await this.objects.getReference(resultKey(ref.key));
      if (!hash) throw Error('workspace_file_recovery_required');
      const receipt = await this.terminal(prepared, hash);
      if (receipt.needsAttention || !receipt.quiescent)
        throw Error('workspace_file_recovery_required');
    }
  }
  async apply(
    call: WorkspaceCall,
    changes: Put[],
    basisReceiptId: string,
  ): Promise<WorkspaceFileBatchApply> {
    const key = workspaceFileActionKey(call);
    await this.assertQuiescent(call, key);
    const admitted = await this.authority.assertCall(call, 'edit');
    const readSet = await this.files.loadReadSet(call, basisReceiptId);
    for (const change of changes) {
      if (
        !readSet.some(
          (entry) =>
            entry.path === change.path &&
            localRecordHash(entry.version) === localRecordHash(change.expected),
        )
      )
        throw Error('file_basis_mismatch');
      await this.objects.getBytes(change.contentRef);
    }
    const input = {
      call,
      changes,
      basisReceiptId,
      bindingHash: localRecordHash(admitted.binding),
      canonicalSourceRef: admitted.sourceReceiptId,
    };
    const prepared: Prepared = {
      schemaVersion: 'workspace-file-batch-prepared-v1',
      ...input,
      inputHash: localRecordHash(input),
    };
    const previous = await this.objects.getReference(key);
    if (previous) {
      if (
        localRecordHash(this.prepared(await this.objects.get(previous))) !==
        localRecordHash(prepared)
      )
        throw Error('operation_conflict');
      const hash = await this.objects.getReference(resultKey(key));
      if (!hash) throw Error('workspace_file_recovery_required');
      const result = await this.terminal(prepared, hash);
      await this.authority.assertCall(call, 'edit');
      return result;
    }
    await this.objects.bindReference(key, await this.objects.put(prepared));
    const observations = new Map<string, FileVersionV1 | null>();
    let mismatch = false;
    try {
      for (const entry of readSet) {
        await this.authority.assertCall(call, 'edit');
        let current: FileVersionV1 | null = null;
        try {
          current = localFileVersion(
            inspectLocalFileBytes(admitted.binding, entry.path, this.helper),
          );
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'native_read_failed') throw error;
          try {
            const absent = inspectLocalCreationBasis(admitted.binding, entry.path, this.helper);
            current = {
              kind: 'absent',
              parentIdentity: absent.parentIdentity,
              name: entry.path.split('/').at(-1) as string,
            };
          } catch {
            /* A changed file type or parent is a preflight conflict. */
          }
        }
        observations.set(entry.path, current);
        if (localRecordHash(current) !== localRecordHash(entry.version)) mismatch = true;
      }
      await this.authority.assertCall(call, 'edit');
    } catch {
      return this.finish(prepared, [], observations, 'authority_or_evidence_changed');
    }
    if (mismatch) return this.finish(prepared, [], observations, 'preflight_conflict');
    const results: WorkspaceFileApply[] = [];
    try {
      for (let index = 0; index < changes.length; index++) {
        const change = changes[index] as Put;
        const basis = readSet.find((entry) => entry.path === change.path);
        if (!basis) throw Error('file_basis_mismatch');
        const result = await this.applyOne(
          this.childCall(call, index),
          change,
          basis.readReceiptId,
          key,
        );
        results.push(result);
        if (result.stage !== 'applied')
          return this.finish(prepared, results, observations, 'item_failed');
      }
      await this.authority.assertCall(call, 'edit');
      // Recheck every read dependency and each actual installed version. This
      // does not promise instantaneous invalidation after the last observation.
      for (const entry of readSet) {
        const index = changes.findIndex((change) => change.path === entry.path);
        const expected = index < 0 ? entry.version : results[index]?.items[0]?.result;
        let current: FileVersionV1;
        if (expected?.kind === 'absent') {
          const absent = inspectLocalCreationBasis(admitted.binding, entry.path, this.helper);
          current = {
            kind: 'absent',
            parentIdentity: absent.parentIdentity,
            name: entry.path.split('/').at(-1) as string,
          };
        } else
          current = localFileVersion(
            inspectLocalFileBytes(admitted.binding, entry.path, this.helper),
          );
        if (!expected || localRecordHash(current) !== localRecordHash(expected))
          return this.finish(prepared, results, observations, 'read_set_changed');
      }
      await this.authority.assertCall(call, 'edit');
      return this.finish(prepared, results, observations, 'none');
    } catch {
      return this.finish(prepared, results, observations, 'authority_or_evidence_changed');
    }
  }
  private childCall(call: WorkspaceCall, index: number): WorkspaceCall {
    return { ...call, actionId: `batch-item:${workspaceFileActionKey(call)}:${index}` };
  }
  private prepared(value: unknown): Prepared {
    const prepared = value as Prepared;
    if (
      !prepared ||
      Object.keys(prepared).sort().join(',') !==
        'basisReceiptId,bindingHash,call,canonicalSourceRef,changes,inputHash,schemaVersion' ||
      prepared.schemaVersion !== 'workspace-file-batch-prepared-v1' ||
      !isWorkspaceCall(prepared.call) ||
      !Array.isArray(prepared.changes) ||
      prepared.changes.length < 1 ||
      prepared.changes.length > 64 ||
      prepared.changes.some((change) => !isFileChangeV1(change) || change.op !== 'put') ||
      new Set(prepared.changes.map((change) => change.path)).size !== prepared.changes.length ||
      !/^readset:[a-f0-9]{64}$/.test(prepared.basisReceiptId) ||
      !/^[a-f0-9]{64}$/.test(prepared.bindingHash) ||
      typeof prepared.canonicalSourceRef !== 'string'
    )
      throw Error('invalid_file_receipt');
    const { schemaVersion: _, inputHash, ...input } = prepared;
    if (localRecordHash(input) !== inputHash) throw Error('invalid_file_receipt');
    return prepared;
  }
  private async finish(
    prepared: Prepared,
    results: WorkspaceFileApply[],
    observations: Map<string, FileVersionV1 | null>,
    reason: WorkspaceFileBatchApply['reason'],
  ) {
    const applied =
      reason === 'none' &&
      results.length === prepared.changes.length &&
      results.every((result) => result.stage === 'applied');
    const effect = results.some((result) => result.effect === true)
      ? true
      : reason === 'authority_or_evidence_changed' ||
          results.some((result) => result.effect === null)
        ? null
        : false;
    const quiescent =
      reason !== 'authority_or_evidence_changed' && results.every((result) => result.quiescent);
    const stage = applied
      ? 'applied'
      : effect === true
        ? 'partial'
        : effect === false && quiescent
          ? 'conflict'
          : 'recoveryRequired';
    const receipt: WorkspaceFileBatchApply = {
      ...prepared.call,
      schemaVersion: 'workspace-file-batch-v1',
      receiptId: `batch:${workspaceFileActionKey(prepared.call)}`,
      inputHash: prepared.inputHash,
      stage,
      createdAt: Date.now(),
      canonicalSourceRef: prepared.canonicalSourceRef,
      effect,
      quiescent,
      needsAttention: stage === 'partial' || stage === 'recoveryRequired',
      reason,
      childReceipts: await Promise.all(results.map((result) => this.objects.put(result))),
      items: prepared.changes.map(
        (change, index) =>
          results[index]?.items[0] ?? {
            path: change.path,
            expected: change.expected,
            observed: observations.get(change.path) ?? null,
            result: null,
            baselineContentRef: change.expected.kind === 'regular' ? change.expected.sha256 : null,
            candidateContentRef: change.contentRef,
            nativeReceiptRef: null,
          },
      ),
    };
    await this.objects.bindReference(
      resultKey(workspaceFileActionKey(prepared.call)),
      await this.objects.put(receipt),
    );
    if (receipt.stage === 'applied') {
      try {
        await this.authority.assertCall(prepared.call, 'edit');
      } catch {
        await this.objects.bindReference(
          localRecordHash({
            key: workspaceFileActionKey(prepared.call),
            phase: 'batch-invalidation',
          }),
          await this.objects.put({
            schemaVersion: 'workspace-batch-invalidation-v1',
            receiptHash: localRecordHash(receipt),
            reason: 'authority_or_root_changed',
          }),
        );
        throw Error('workspace_file_recovery_required');
      }
    }
    return receipt;
  }
  private async terminal(prepared: Prepared, hash: string): Promise<WorkspaceFileBatchApply> {
    if (
      await this.objects.getReference(
        localRecordHash({
          key: workspaceFileActionKey(prepared.call),
          phase: 'batch-invalidation',
        }),
      )
    )
      throw Error('workspace_file_recovery_required');
    const receipt = (await this.objects.get(hash)) as WorkspaceFileBatchApply;
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !==
        'actionId,canonicalSourceRef,childReceipts,createdAt,effect,grantRevision,inputHash,items,needsAttention,projectId,quiescent,reason,receiptId,schemaVersion,stage,taskId,workerId,workspaceId,writerEpoch' ||
      receipt.schemaVersion !== 'workspace-file-batch-v1' ||
      receipt.inputHash !== prepared.inputHash ||
      receipt.canonicalSourceRef !== prepared.canonicalSourceRef ||
      receipt.receiptId !== `batch:${workspaceFileActionKey(prepared.call)}` ||
      !Number.isSafeInteger(receipt.createdAt) ||
      receipt.createdAt < 0 ||
      !Array.isArray(receipt.childReceipts) ||
      receipt.childReceipts.length > prepared.changes.length ||
      !Array.isArray(receipt.items) ||
      receipt.items.length !== prepared.changes.length ||
      ![
        'none',
        'preflight_conflict',
        'item_failed',
        'read_set_changed',
        'authority_or_evidence_changed',
      ].includes(receipt.reason) ||
      typeof receipt.quiescent !== 'boolean' ||
      ![true, false, null].includes(receipt.effect) ||
      typeof receipt.needsAttention !== 'boolean'
    )
      throw Error('invalid_file_receipt');
    for (const key of Object.keys(prepared.call) as (keyof WorkspaceCall)[])
      if (receipt[key] !== prepared.call[key]) throw Error('invalid_file_receipt');
    const children: WorkspaceFileApply[] = [];
    for (let index = 0; index < receipt.childReceipts.length; index++) {
      const result = await this.verifyOne(this.childCall(prepared.call, index));
      children.push(result);
      if (
        localRecordHash(result) !== receipt.childReceipts[index] ||
        localRecordHash(result.items[0]) !== localRecordHash(receipt.items[index])
      )
        throw Error('invalid_file_receipt');
    }
    const effect = children.some((child) => child.effect === true)
      ? true
      : receipt.reason === 'authority_or_evidence_changed' ||
          children.some((child) => child.effect === null)
        ? null
        : false;
    const quiescent =
      receipt.reason !== 'authority_or_evidence_changed' &&
      children.every((child) => child.quiescent);
    const applied =
      receipt.reason === 'none' &&
      children.length === prepared.changes.length &&
      children.every((child) => child.stage === 'applied');
    const stage = applied
      ? 'applied'
      : effect === true
        ? 'partial'
        : effect === false && quiescent
          ? 'conflict'
          : 'recoveryRequired';
    if (
      receipt.effect !== effect ||
      receipt.quiescent !== quiescent ||
      receipt.stage !== stage ||
      receipt.needsAttention !== (stage === 'partial' || stage === 'recoveryRequired') ||
      (receipt.reason === 'preflight_conflict' && children.length !== 0) ||
      children.slice(0, -1).some((child) => child.stage !== 'applied')
    )
      throw Error('invalid_file_receipt');
    if (
      receipt.stage === 'applied'
        ? receipt.childReceipts.length !== prepared.changes.length ||
          receipt.needsAttention ||
          !receipt.quiescent ||
          receipt.effect !== true ||
          receipt.reason !== 'none' ||
          receipt.items.some((item) => item.result === null)
        : receipt.stage === 'conflict'
          ? receipt.effect !== false || !receipt.quiescent || receipt.needsAttention
          : !['partial', 'recoveryRequired'].includes(receipt.stage) || !receipt.needsAttention
    )
      throw Error('invalid_file_receipt');
    for (let index = 0; index < prepared.changes.length; index++) {
      const item = receipt.items[index],
        change = prepared.changes[index];
      if (
        !item ||
        Object.keys(item).sort().join(',') !==
          'baselineContentRef,candidateContentRef,expected,nativeReceiptRef,observed,path,result' ||
        (item.observed !== null && !isFileVersionV1(item.observed)) ||
        (item.result !== null && !isFileVersionV1(item.result)) ||
        !change ||
        item.baselineContentRef !==
          (change.expected.kind === 'regular' ? change.expected.sha256 : null) ||
        item.path !== change.path ||
        localRecordHash(item.expected) !== localRecordHash(change.expected) ||
        item.candidateContentRef !== change.contentRef ||
        (index >= receipt.childReceipts.length &&
          (item.result !== null || item.nativeReceiptRef !== null))
      )
        throw Error('invalid_file_receipt');
    }
    return receipt;
  }
}
