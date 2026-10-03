/** Read original sealed effects only. No current workspace, grant, lease or
 * model is opened; this adapter never executes or repairs an original action. */
import type { LocalControlObjects } from './local-control-objects';
import type { LocalControlledTreeBatch } from './local-integration-tree-batch';
import { localRecordHash } from './local-registry-records';
import type { LocalUndoTreeEffect } from './local-undo-tree-plan';
import type { LocalWorkspaceApply } from './local-workspace-apply';

type Scope = { projectId: string; taskId: string; workspaceId: string };
type FileEffect = Awaited<ReturnType<LocalWorkspaceApply['readActualFileEffect']>>;
type Options = {
  objects: LocalControlObjects;
  files: LocalWorkspaceApply;
  integrationTree?: LocalControlledTreeBatch;
  deliveryTree?: LocalControlledTreeBatch;
};
function fail(): never {
  throw Error('undo_effect_unverified');
}
export class LocalUndoOriginalEffects {
  constructor(private readonly options: Options) {}
  private async file(effect: FileEffect): Promise<LocalUndoTreeEffect> {
    const baseline = effect.baselineContentRef
      ? await this.options.objects.getBytes(effect.baselineContentRef)
      : Buffer.alloc(0);
    const installed = await this.options.objects.getBytes(effect.candidateContentRef);
    if (effect.effect && (!effect.installedVersion || !effect.installedMetadata)) fail();
    return {
      operation: 'put',
      path: effect.path,
      effect: effect.effect,
      kind: effect.kind,
      baselineVersion: structuredClone(effect.baselineVersion),
      baselineMetadata: effect.baselineMetadata,
      baseline,
      installedVersion: effect.installedVersion && structuredClone(effect.installedVersion),
      installedMetadata: effect.installedMetadata,
      installed,
    };
  }
  async read(input: Scope, receiptId: string) {
    const scope = structuredClone(input),
      { objects } = this.options;
    if (!/^(apply|batch|tree):[a-f0-9]{64}$/.test(receiptId)) fail();
    let proof: unknown, receiptHash: string, rootId: string, bindingHash: string;
    const effects: LocalUndoTreeEffect[] = [];
    if (receiptId.startsWith('apply:')) {
      const original = await this.options.files.readActualFileEffect(scope, receiptId);
      proof = original;
      receiptHash = original.receiptHash;
      rootId = original.rootId;
      bindingHash = original.bindingHash;
      effects.push(await this.file(original));
    } else if (receiptId.startsWith('batch:')) {
      const original = await this.options.files.readActualBatch(scope, receiptId);
      proof = original;
      receiptHash = original.receiptHash;
      const first = original.effects[0];
      if (!first) fail();
      rootId = first.rootId;
      bindingHash = first.bindingHash;
      for (const effect of original.effects) {
        if (effect.rootId !== rootId || effect.bindingHash !== bindingHash) fail();
        effects.push(await this.file(effect));
      }
    } else {
      const ref = await objects.getReference(receiptId.slice(5));
      if (!ref) fail();
      const prepared = (await objects.get(ref)) as { schemaVersion?: string };
      const reader =
        prepared.schemaVersion === 'integration-tree-prepared-v1'
          ? this.options.integrationTree
          : prepared.schemaVersion === 'delivery-tree-prepared-v1'
            ? this.options.deliveryTree
            : undefined;
      if (!reader) fail();
      const original = await reader.readActual(scope, receiptId);
      proof = original;
      receiptHash = original.resultHash;
      rootId = original.plan.scope.rootId;
      bindingHash = localRecordHash(original.binding);
      for (const effect of original.effects) {
        const { path } = effect;
        if (effect.operation === 'put') {
          if (!effect.baselineVersion || !effect.candidateContentRef) fail();
          const baseline = effect.baselineContentRef
            ? await objects.getBytes(effect.baselineContentRef)
            : Buffer.alloc(0);
          effects.push({
            operation: 'put',
            path,
            effect: effect.effect,
            kind: effect.baselineVersion.kind === 'absent' ? 'create' : 'replace',
            baselineVersion: structuredClone(effect.baselineVersion),
            baselineMetadata: effect.baselineMetadata,
            baseline,
            installedVersion: effect.installedVersion && structuredClone(effect.installedVersion),
            installedMetadata: effect.installedMetadata,
            installed: await objects.getBytes(effect.candidateContentRef),
          });
        } else if (effect.operation === 'remove') {
          if (
            effect.baselineVersion?.kind !== 'regular' ||
            !effect.baselineContentRef ||
            !effect.baselineMetadata
          )
            fail();
          const baseline = {
            path,
            version: structuredClone(effect.baselineVersion),
            metadata: effect.baselineMetadata,
            content: await objects.getBytes(effect.baselineContentRef),
          };
          effects.push({
            operation: 'remove',
            path,
            effect: effect.effect,
            baseline,
            preserved: {
              candidateName: effect.native.candidateName,
              identity: baseline.version.identity,
              metadata: baseline.metadata,
            },
          });
        } else if (effect.operation === 'mkdir') {
          if (effect.effect && !effect.directory) fail();
          effects.push({
            operation: 'mkdir',
            path,
            effect: effect.effect,
            installed: effect.directory ? { path, ...effect.directory } : null,
          });
        } else {
          const baseline = effect.baselineDirectory;
          if (!baseline?.identity || !baseline.metadata) fail();
          effects.push({
            operation: 'rmdir',
            path,
            effect: effect.effect,
            baseline: { path, identity: baseline.identity, metadata: baseline.metadata },
            preserved: {
              candidateName: effect.native.candidateName,
              identity: baseline.identity,
              metadata: baseline.metadata,
            },
          });
        }
      }
    }
    const proofHash = localRecordHash(proof);
    return {
      schemaVersion: 'local-undo-original-effects-v1' as const,
      ...scope,
      receiptId,
      receiptHash,
      rootId,
      bindingHash,
      proofHash,
      proof,
      effects,
    };
  }
}
