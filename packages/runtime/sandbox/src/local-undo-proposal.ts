/** Immutable B / actual A / current U / candidate C binding. Only trusted
 * actual-effect and current-authority readers may construct these proposals. */
import { createHash } from 'node:crypto';
import type { WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import {
  inspectLocalPreservedDirectory,
  inspectLocalPreservedFile,
} from './local-file-transaction';
import { localRecordHash, parseLocalRegistry } from './local-registry-records';
import type { LocalUndoCurrentSource } from './local-undo-current-source';
import type { LocalUndoOriginalEffects } from './local-undo-original-effects';
import { planLocalUndoTree } from './local-undo-tree-plan';
import { localRootBinding } from './local-workspace-authority';

type Scope = { projectId: string; taskId: string; workspaceId: string };
type Options = {
  objects: LocalControlObjects;
  original: Pick<LocalUndoOriginalEffects, 'read'>;
  current: Pick<LocalUndoCurrentSource, 'capture' | 'read' | 'tree' | 'verifyCurrent'>;
  filesHelper: string;
};
export type LocalUndoProposalRecord = {
  schemaVersion: 'local-undo-proposal-v1';
  source: Scope;
  target: Scope;
  fileApplyReceiptId: string;
  originalReceiptHash: string;
  originalProofHash: string;
  originalEffectsHash: string;
  currentHash: string;
  currentVersion: WorkspaceVersionV1;
  rootId: string;
  bindingHash: string;
  grantId: string;
  grantRevision: number;
  expectedRevision: number;
  controlFingerprint: string;
  plan: unknown;
  planHash: string;
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function scope(value: Scope) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'projectId,taskId,workspaceId' ||
    Object.values(value).some(
      (v) => typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
    )
  )
    throw Error('undo_proposal_invalid');
}
function fail(): never {
  throw Error('undo_proposal_unverified');
}
export class LocalUndoProposalStore {
  constructor(private readonly options: Options) {}
  private async encode(value: unknown, publish: boolean): Promise<unknown> {
    if (Buffer.isBuffer(value)) {
      const contentRef = hash(value);
      if (publish) await this.options.objects.putBytes(value);
      if (!(await this.options.objects.getBytes(contentRef)).equals(value)) fail();
      return { kind: 'private-bytes', contentRef, size: value.length };
    }
    if (Array.isArray(value)) return Promise.all(value.map((v) => this.encode(v, publish)));
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) result[key] = await this.encode(v, publish);
      return result;
    }
    return value;
  }
  private async sources(
    record: Pick<
      LocalUndoProposalRecord,
      'source' | 'target' | 'fileApplyReceiptId' | 'currentHash'
    >,
  ) {
    scope(record.source);
    scope(record.target);
    const original = await this.options.original.read(record.source, record.fileApplyReceiptId),
      current = await this.options.current.read(record.currentHash);
    if (
      original.projectId !== record.source.projectId ||
      original.taskId !== record.source.taskId ||
      original.workspaceId !== record.source.workspaceId ||
      original.receiptId !== record.fileApplyReceiptId ||
      current.projectId !== record.target.projectId ||
      current.taskId !== record.target.taskId ||
      current.workspaceId !== record.target.workspaceId ||
      current.bindingHash !== original.bindingHash ||
      localRecordHash(original.proof) !== original.proofHash
    )
      fail();
    const tree = await this.options.current.tree(current),
      plan = planLocalUndoTree(original.effects, tree);
    return { original, current, tree, plan };
  }
  async prepare(source: Scope, target: Scope, fileApplyReceiptId: string) {
    scope(source);
    scope(target);
    const current = await this.options.current.capture(target),
      input = {
        source: structuredClone(source),
        target: structuredClone(target),
        fileApplyReceiptId,
        currentHash: current.hash,
      },
      facts = await this.sources(input);
    const originalEffectsHash = localRecordHash(await this.encode(facts.original.effects, true)),
      plan = await this.encode(facts.plan, true),
      record: LocalUndoProposalRecord = {
        schemaVersion: 'local-undo-proposal-v1',
        ...input,
        originalReceiptHash: facts.original.receiptHash,
        originalProofHash: await this.options.objects.put(facts.original.proof),
        originalEffectsHash,
        currentVersion: structuredClone(facts.current.version),
        rootId: facts.current.rootId,
        bindingHash: facts.current.bindingHash,
        grantId: facts.current.grantId,
        grantRevision: facts.current.grantRevision,
        expectedRevision: facts.current.registryRevision,
        controlFingerprint: facts.current.controlFingerprint,
        plan,
        planHash: localRecordHash(plan),
      };
    const inputHash = await this.options.objects.put(record);
    await this.verifyFresh(inputHash);
    return { inputHash, proposal: record, plan: facts.plan };
  }
  async read(inputHash: string) {
    const record = (await this.options.objects.get(inputHash)) as LocalUndoProposalRecord;
    if (
      !record ||
      Object.keys(record).sort().join(',') !==
        'bindingHash,controlFingerprint,currentHash,currentVersion,expectedRevision,fileApplyReceiptId,grantId,grantRevision,originalEffectsHash,originalProofHash,originalReceiptHash,plan,planHash,rootId,schemaVersion,source,target' ||
      record.schemaVersion !== 'local-undo-proposal-v1'
    )
      fail();
    const facts = await this.sources(record),
      plan = await this.encode(facts.plan, false);
    if (
      record.originalReceiptHash !== facts.original.receiptHash ||
      record.originalProofHash !== facts.original.proofHash ||
      localRecordHash(await this.options.objects.get(record.originalProofHash)) !==
        facts.original.proofHash ||
      record.originalEffectsHash !==
        localRecordHash(await this.encode(facts.original.effects, false)) ||
      localRecordHash(record.currentVersion) !== localRecordHash(facts.current.version) ||
      record.rootId !== facts.current.rootId ||
      record.bindingHash !== facts.current.bindingHash ||
      record.grantId !== facts.current.grantId ||
      record.grantRevision !== facts.current.grantRevision ||
      record.expectedRevision !== facts.current.registryRevision ||
      record.controlFingerprint !== facts.current.controlFingerprint ||
      record.planHash !== localRecordHash(plan) ||
      localRecordHash(record.plan) !== record.planHash
    )
      fail();
    return { proposal: structuredClone(record), ...facts };
  }
  async verifyFresh(inputHash: string) {
    const result = await this.read(inputHash);
    await this.options.current.verifyCurrent(result.proposal.currentHash);
    const registry = parseLocalRegistry(
        await this.options.objects.get(result.current.registryHash),
      ),
      root =
        registry.linkedRoots?.find(
          (r) =>
            r.projectId === result.current.projectId &&
            r.taskId === result.current.taskId &&
            r.workspaceId === result.current.workspaceId,
        ) ??
        registry.roots.find(
          (r) => r.projectId === result.current.projectId && r.rootId === result.current.rootId,
        );
    if (!root) fail();
    const binding = localRootBinding(root);
    for (const effect of result.original.effects) {
      if (!effect.effect || (effect.operation !== 'remove' && effect.operation !== 'rmdir'))
        continue;
      const observed =
        effect.operation === 'remove'
          ? inspectLocalPreservedFile(
              binding,
              effect.preserved.candidateName,
              this.options.filesHelper,
            )
          : inspectLocalPreservedDirectory(
              binding,
              effect.preserved.candidateName,
              this.options.filesHelper,
            );
      if (
        observed.identity !== effect.preserved.identity ||
        observed.metadata !== effect.preserved.metadata ||
        (effect.operation === 'remove' &&
          (!('content' in observed) ||
            !Buffer.isBuffer(observed.content) ||
            !observed.content.equals(effect.baseline.content)))
      )
        throw Error('undo_preserved_source_changed');
    }
    await this.options.current.verifyCurrent(result.proposal.currentHash);
    return result;
  }
}
