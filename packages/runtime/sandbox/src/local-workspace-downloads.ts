/** Trusted installation input broker. No worker-facing URL proxy or arbitrary
 * path write is exposed; immutable bytes are private inputs for the installer. */
import { createHash } from 'node:crypto';
import {
  isWorkspaceCall,
  isWorkspaceVersionV1,
  type WorkspaceCall,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { downloadLocalPackage } from './local-download';
import { qualifyDownloadUrl } from './local-download-policy';
import { type LocalGrantPolicy, validateLocalGrantPolicy } from './local-grant-policy';
import { localRecordHash } from './local-registry-records';
import type { LocalVersionStore } from './local-version-store';
import type { LocalWorkspaceApply } from './local-workspace-apply';
import type { LocalWorkspaceAuthority } from './local-workspace-authority';
import { workspaceFileActionKey } from './local-workspace-batch';
import { serializeWorkspaceOperation } from './local-workspace-operation';

export type WorkspaceDownloadRequest = {
  inputVersion: WorkspaceVersionV1;
  url: string;
  integrity: string;
};
export type WorkspaceDownloadReceipt = {
  schemaVersion: 'workspace-download-receipt-v1';
  inputHash: string;
  contentRef: string;
  byteLength: number;
  integrity: string;
  hops: { url: string; address: string; status: number }[];
};
const resultKey = (key: string) => localRecordHash({ key, phase: 'download-result' });
export class LocalWorkspaceDownloads {
  constructor(
    private readonly authority: LocalWorkspaceAuthority,
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly files: LocalWorkspaceApply,
  ) {}
  async download(
    input: WorkspaceCall,
    inputRequest: WorkspaceDownloadRequest,
  ): Promise<WorkspaceDownloadReceipt> {
    localRecordHash({ input, inputRequest });
    if (
      !isWorkspaceCall(input) ||
      !inputRequest ||
      Object.keys(inputRequest).sort().join(',') !== 'inputVersion,integrity,url' ||
      !isWorkspaceVersionV1(inputRequest.inputVersion) ||
      inputRequest.inputVersion.kind !== 'files' ||
      typeof inputRequest.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(inputRequest.integrity) ||
      Buffer.from(inputRequest.integrity.slice(7), 'base64').toString('base64') !==
        inputRequest.integrity.slice(7)
    )
      throw Error('invalid_workspace_download');
    const call = structuredClone(input),
      request = structuredClone(inputRequest);
    return serializeWorkspaceOperation(call, async () => {
      const key = workspaceFileActionKey(call);
      await this.files.assertQuiescent(call, key);
      const admitted = await this.authority.assertCall(call, 'install');
      const policy = validateLocalGrantPolicy(
        (await this.objects.get(admitted.grant.policyHash)) as LocalGrantPolicy,
      );
      if (
        policy.network.mode !== 'brokered-https' ||
        localRecordHash(policy.network) !== admitted.grant.networkHash ||
        localRecordHash(policy.toolchain) !== admitted.grant.toolchainHash ||
        localRecordHash(policy.actions) !== localRecordHash(admitted.grant.actions)
      )
        throw Error('download_policy_mismatch');
      qualifyDownloadUrl(request.url, policy.network);
      const expected = localRecordHash(admitted);
      const current = async () => {
        if (localRecordHash(await this.authority.assertCall(call, 'install')) !== expected)
          throw Error('authorization_closed');
        return true;
      };
      const scope = {
        projectId: call.projectId,
        taskId: call.taskId,
        rootId: admitted.root.rootId,
        policyHash: admitted.grant.policyHash,
      };
      const authorize = async () => {
        await this.versions.verify(request.inputVersion, scope, admitted.binding, current);
      };
      await authorize();
      const prepared = {
        schemaVersion: 'workspace-download-prepared-v1',
        call,
        request,
        authorityHash: expected,
        canonicalSourceRef: admitted.sourceReceiptId,
      };
      const inputHash = localRecordHash(prepared);
      const existing = await this.objects.getReference(key);
      if (existing && existing !== inputHash) throw Error('operation_conflict');
      await this.objects.bindReference(key, await this.objects.put(prepared));
      let receiptHash = await this.objects.getReference(resultKey(key));
      if (!receiptHash) {
        // GET may be repeated after a crash; no package execution or source write
        // occurs here. The first complete immutable result remains authoritative.
        const result = await downloadLocalPackage({
          ...request,
          policy: policy.network,
          authorize,
        });
        await authorize();
        const contentRef = await this.objects.putBytes(result.bytes);
        const receipt: WorkspaceDownloadReceipt = {
          schemaVersion: 'workspace-download-receipt-v1',
          inputHash,
          contentRef,
          byteLength: result.bytes.length,
          integrity: result.integrity,
          hops: result.hops,
        };
        receiptHash = await this.objects.put(receipt);
        await authorize();
        await this.objects.bindReference(resultKey(key), receiptHash);
      }
      const receipt = (await this.objects.get(receiptHash)) as WorkspaceDownloadReceipt;
      if (
        !receipt ||
        Object.keys(receipt).sort().join(',') !==
          'byteLength,contentRef,hops,inputHash,integrity,schemaVersion' ||
        receipt.schemaVersion !== 'workspace-download-receipt-v1' ||
        receipt.inputHash !== inputHash ||
        receipt.integrity !== request.integrity ||
        !Array.isArray(receipt.hops) ||
        !receipt.hops.length ||
        receipt.hops.length > policy.network.maxRedirects + 1
      )
        throw Error('invalid_download_receipt');
      const bytes = await this.objects.getBytes(receipt.contentRef);
      if (
        bytes.length !== receipt.byteLength ||
        bytes.length > policy.network.maxBytes ||
        `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== request.integrity
      )
        throw Error('invalid_download_receipt');
      await authorize();
      return receipt;
    });
  }
}
