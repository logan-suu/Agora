/** Immutable preparation storage only. Referenced objects must also be validated
 * by the trusted Coordinator/source service before CAS or execution admission. */
import type { LocalControlObjects } from './local-control-objects';
import { localRecordHash } from './local-registry-records';
import { serializeWorkspaceOperation } from './local-workspace-operation';

export type ValidationPreparationScope = {
  projectId: string;
  taskId: string;
  waveId: string;
  attempt: number;
  integrationId: string;
};
export type ValidationPreparationPlan = {
  schemaVersion: 'local-validation-preparation-plan-v1';
  scope: ValidationPreparationScope;
  actionId: string;
  dispatchId: string;
  workerId: string;
  validationWorkspaceId: string;
  callHash: string;
  handoffPlanHash: string;
  handoffConfirmedHash: string;
  versionHash: string;
  beforeStateHash: string;
  registryHash: string;
  dispatchPlanHash: string;
};
const references = [
  'callHash',
  'handoffPlanHash',
  'handoffConfirmedHash',
  'versionHash',
  'beforeStateHash',
  'registryHash',
  'dispatchPlanHash',
] as const;
const identifier = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function checkScope(scope: ValidationPreparationScope) {
  if (
    !scope ||
    Object.keys(scope).sort().join(',') !== 'attempt,integrationId,projectId,taskId,waveId' ||
    ![scope.projectId, scope.taskId, scope.waveId, scope.integrationId].every(identifier) ||
    !Number.isSafeInteger(scope.attempt) ||
    scope.attempt < 0
  )
    throw Error('invalid_validation_preparation_record');
}
export function validationPreparationSlot(scope: ValidationPreparationScope): string {
  checkScope(scope);
  return localRecordHash({ kind: 'initial-validation-preparation', scope });
}
function checkPlan(value: unknown): ValidationPreparationPlan {
  const plan = value as ValidationPreparationPlan;
  if (
    !plan ||
    Object.keys(plan).sort().join(',') !==
      [
        ...references,
        'schemaVersion',
        'scope',
        'actionId',
        'dispatchId',
        'workerId',
        'validationWorkspaceId',
      ]
        .sort()
        .join(',') ||
    plan.schemaVersion !== 'local-validation-preparation-plan-v1' ||
    ![plan.actionId, plan.dispatchId, plan.workerId, plan.validationWorkspaceId].every(
      identifier,
    ) ||
    references.some((key) => typeof plan[key] !== 'string' || !/^[a-f0-9]{64}$/.test(plan[key]))
  )
    throw Error('invalid_validation_preparation_record');
  checkScope(plan.scope);
  return plan;
}

/** No model-facing export, State writes, registry mutations, grants or confirmed receipt. */
export class LocalValidationPreparationRecords {
  constructor(private readonly objects: LocalControlObjects) {}

  async load(input: ValidationPreparationScope) {
    const scope = structuredClone(input),
      slot = validationPreparationSlot(scope);
    const planHash = await this.objects.getReference(slot);
    if (!planHash) return undefined;
    const plan = checkPlan(await this.objects.get(planHash));
    if (localRecordHash(plan.scope) !== localRecordHash(scope)) throw Error('operation_conflict');
    await this.checkReferences(plan);
    if ((await this.objects.getReference(slot)) !== planHash) throw Error('operation_conflict');
    return { plan, planHash };
  }

  /** Caller holds trusted task control and supplies a previously verified plan.
   * Publishing this record alone does not verify its business/native provenance. */
  async publish(input: ValidationPreparationPlan) {
    const plan = checkPlan(structuredClone(input)),
      slot = validationPreparationSlot(plan.scope);
    return serializeWorkspaceOperation(
      { ...plan.scope, workspaceId: `validation-preparation:${slot}` },
      async () => {
        const existing = await this.load(plan.scope);
        if (existing) {
          if (existing.planHash !== localRecordHash(plan)) throw Error('operation_conflict');
          return existing;
        }
        // An incomplete source object cannot acquire the exclusive slot.
        await this.checkReferences(plan);
        if ((await this.objects.references()).length >= 4096)
          throw Error('control_reference_limit');
        const planHash = await this.objects.put(plan);
        // This single reference is the only durable publication point. A thrown
        // response may follow persistence; callers recover through load, not a new seed.
        await this.objects.bindReference(slot, planHash);
        const saved = await this.load(plan.scope);
        if (saved?.planHash !== planHash) throw Error('operation_conflict');
        return saved;
      },
    );
  }

  private async checkReferences(plan: ValidationPreparationPlan) {
    for (const key of references) await this.objects.get(plan[key]);
  }
}
