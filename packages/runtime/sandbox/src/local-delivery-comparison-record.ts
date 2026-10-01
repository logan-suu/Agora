/** Private, immutable direct-directory B/A/U/C comparison. The injected source reader must
 * prove canonical task, grant and live U facts on every call. This layer only
 * binds those facts to verified fixed manifests; it grants no execution. */
import { isWorkspaceVersionV1, type WorkspaceVersionV1 } from '@agora/core-domain';
import type { TreeComparison } from '../../../core/domain/src/local-tree-comparison';
import type { LocalControlObjects } from './local-control-objects';
import { localRecordHash } from './local-registry-records';
import { type LocalTreePlan, planLocalTreeApplication } from './local-tree-plan';
import type { LocalVersionScope, LocalVersionStore } from './local-version-store';

type Scope = { projectId: string; taskId: string };
export interface LocalDeliverySources {
  scope: LocalVersionScope;
  baseline: WorkspaceVersionV1;
  artifact: WorkspaceVersionV1;
  current: Extract<WorkspaceVersionV1, { kind: 'files' }>;
  grantId: string;
  grantRevision: number;
  goal: 'apply_to_directory' | 'artifact_only';
  sourceReceipts: { baseline: string; artifact: string; current: string };
  targetIndexHash: string | null;
  controlFingerprint: string;
}
type SourceReader = (scope: Scope) => Promise<LocalDeliverySources>;
interface ComparisonRecord {
  schemaVersion: 'local-delivery-comparison-v1';
  source: LocalDeliverySources;
  sourceHash: string;
  plan: LocalTreePlan;
  planHash: string;
  candidateTreeHash: string | null;
  inputHash: string;
}
export type LocalDeliveryComparisonRecord = ComparisonRecord & {
  deliveryComparisonId: string;
  comparison: TreeComparison;
};

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable === true && Object.hasOwn(field, 'value');
    })
  );
}
function validSource(value: unknown, scope: Scope): value is LocalDeliverySources {
  if (
    !exact(value, [
      'scope',
      'baseline',
      'artifact',
      'current',
      'grantId',
      'grantRevision',
      'goal',
      'sourceReceipts',
      'targetIndexHash',
      'controlFingerprint',
    ]) ||
    !exact(value.scope, ['projectId', 'taskId', 'rootId', 'policyHash']) ||
    value.scope.projectId !== scope.projectId ||
    value.scope.taskId !== scope.taskId ||
    !id(value.scope.rootId) ||
    !hash(value.scope.policyHash) ||
    !isWorkspaceVersionV1(value.baseline) ||
    !isWorkspaceVersionV1(value.artifact) ||
    !isWorkspaceVersionV1(value.current) ||
    value.current.kind !== 'files' ||
    !id(value.grantId) ||
    typeof value.grantRevision !== 'number' ||
    !Number.isSafeInteger(value.grantRevision) ||
    value.grantRevision < 0 ||
    (value.goal !== 'apply_to_directory' && value.goal !== 'artifact_only') ||
    !exact(value.sourceReceipts, ['baseline', 'artifact', 'current']) ||
    !['baseline', 'artifact', 'current'].every((key) =>
      id((value.sourceReceipts as Record<string, unknown>)[key]),
    ) ||
    (value.targetIndexHash !== null && !hash(value.targetIndexHash)) ||
    !hash(value.controlFingerprint)
  )
    return false;
  return true;
}
function selection(record: ComparisonRecord): LocalDeliveryComparisonRecord {
  return {
    ...structuredClone(record),
    deliveryComparisonId: `comparison:${localRecordHash(record)}`,
    comparison: structuredClone(record.plan.comparison),
  };
}

export class LocalDeliveryComparisonStore {
  constructor(
    private readonly objects: LocalControlObjects,
    private readonly versions: LocalVersionStore,
    private readonly readSource: SourceReader,
  ) {}

  private async source(scope: Scope): Promise<LocalDeliverySources> {
    if (!exact(scope, ['projectId', 'taskId']) || !id(scope.projectId) || !id(scope.taskId))
      throw Error('invalid_delivery_scope');
    const source: unknown = structuredClone(await this.readSource(scope));
    if (!validSource(source, scope)) throw Error('invalid_delivery_source');
    return source;
  }

  private async assertCurrent(scope: Scope, expected: LocalDeliverySources): Promise<void> {
    if (localRecordHash(await this.source(scope)) !== localRecordHash(expected))
      throw Error('delivery_stale');
  }

  async prepare(scope: Scope): Promise<LocalDeliveryComparisonRecord> {
    const source = await this.source(scope);
    const plan = await planLocalTreeApplication(this.versions, {
      scope: source.scope,
      baseline: source.baseline,
      artifact: source.artifact,
      current: source.current,
    });
    await this.assertCurrent(scope, source);
    const sourceHash = localRecordHash(source),
      planHash = localRecordHash(plan),
      candidateTreeHash =
        plan.comparison.candidate === null ? null : localRecordHash(plan.comparison.candidate);
    const record: ComparisonRecord = {
      schemaVersion: 'local-delivery-comparison-v1',
      source,
      sourceHash,
      plan,
      planHash,
      candidateTreeHash,
      inputHash: localRecordHash({ sourceHash, planHash, candidateTreeHash }),
    };
    const objectHash = await this.objects.put(record);
    const result = await this.readHistorical(`comparison:${objectHash}`);
    await this.assertCurrent(scope, source);
    return result;
  }

  async readHistorical(deliveryComparisonId: string): Promise<LocalDeliveryComparisonRecord> {
    if (!/^comparison:[a-f0-9]{64}$/.test(deliveryComparisonId))
      throw Error('invalid_delivery_comparison');
    const value = await this.objects.get(deliveryComparisonId.slice(11));
    if (
      !exact(value, [
        'schemaVersion',
        'source',
        'sourceHash',
        'plan',
        'planHash',
        'candidateTreeHash',
        'inputHash',
      ]) ||
      value.schemaVersion !== 'local-delivery-comparison-v1' ||
      !exact(value.source, [
        'scope',
        'baseline',
        'artifact',
        'current',
        'grantId',
        'grantRevision',
        'goal',
        'sourceReceipts',
        'targetIndexHash',
        'controlFingerprint',
      ]) ||
      !exact(value.source.scope, ['projectId', 'taskId', 'rootId', 'policyHash']) ||
      typeof value.source.scope.projectId !== 'string' ||
      typeof value.source.scope.taskId !== 'string' ||
      !validSource(value.source, {
        projectId: value.source.scope.projectId,
        taskId: value.source.scope.taskId,
      }) ||
      !hash(value.sourceHash) ||
      !hash(value.planHash) ||
      (value.candidateTreeHash !== null && !hash(value.candidateTreeHash)) ||
      !hash(value.inputHash)
    )
      throw Error('invalid_delivery_comparison');
    const record = value as unknown as ComparisonRecord;
    const plan = await planLocalTreeApplication(this.versions, {
      scope: record.source.scope,
      baseline: record.source.baseline,
      artifact: record.source.artifact,
      current: record.source.current,
    });
    const sourceHash = localRecordHash(record.source),
      planHash = localRecordHash(plan),
      candidateTreeHash =
        plan.comparison.candidate === null ? null : localRecordHash(plan.comparison.candidate);
    if (
      record.sourceHash !== sourceHash ||
      record.planHash !== planHash ||
      localRecordHash(record.plan) !== planHash ||
      record.candidateTreeHash !== candidateTreeHash ||
      record.inputHash !== localRecordHash({ sourceHash, planHash, candidateTreeHash })
    )
      throw Error('invalid_delivery_comparison');
    return selection(record);
  }

  async verifyCurrent(deliveryComparisonId: string): Promise<LocalDeliveryComparisonRecord> {
    const record = await this.readHistorical(deliveryComparisonId);
    await this.assertCurrent(
      { projectId: record.source.scope.projectId, taskId: record.source.scope.taskId },
      record.source,
    );
    if (record.comparison.status === 'conflict') throw Error('delivery_conflict');
    return record;
  }
}
