/** Immutable native conflict control evidence; physical proofs are checked separately. */
import { type AppState, applyMutations, planIntegrationConflict } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { readConfirmedApplicationPrefix } from './local-integration-application-records';
import type { LocalIntegrationCall } from './local-integration-authority';
import type { LocalIntegrationConflictCandidate } from './local-integration-candidates';
import { completionApplications } from './local-integration-completion-records';
import { localRecordHash } from './local-registry-records';

export const conflictKey = (call: LocalIntegrationCall, stage: string) =>
  localRecordHash({ kind: 'integration-conflict', call, stage });
export type IntegrationConflictPlan = {
  schemaVersion: 'local-integration-conflict-plan-v1';
  call: LocalIntegrationCall;
  beforeHash: string;
  afterHash: string;
  registryRevision: number;
  actionId: string;
  candidate: LocalIntegrationConflictCandidate;
  applications: ReturnType<typeof completionApplications>;
};
export const conflictReceipt = (planHash: string, plan: IntegrationConflictPlan) => ({
  schemaVersion: 'local-integration-conflict-confirmed-v1',
  planHash,
  stateHash: plan.afterHash,
});
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
export async function readIntegrationConflictPlan(
  objects: LocalControlObjects,
  call: LocalIntegrationCall,
  current: AppState,
) {
  const planHash = await objects.getReference(conflictKey(call, 'plan'));
  if (!planHash || (await objects.getReference(conflictKey(call, 'invalid'))))
    throw Error('integration_conflict_recovery_required');
  const plan = (await objects.get(planHash)) as IntegrationConflictPlan;
  const before = (await objects.get(plan.beforeHash)) as AppState;
  if (
    !before.integration ||
    plan.candidate?.schemaVersion !== 'local-integration-conflict-candidate-v1'
  )
    throw Error('integration_conflict_recovery_required');
  const expected = {
    projectId: before.projectId,
    taskId: before.taskId,
    integration: before.integration,
    selection: plan.candidate.sources.selection,
  };
  const files = plan.candidate.conflict.result.paths;
  const changes = planIntegrationConflict(before, expected, files),
    after = applyMutations(before, changes);
  const prefix = await readConfirmedApplicationPrefix(objects, before, call);
  if (
    !equal(plan, {
      schemaVersion: 'local-integration-conflict-plan-v1',
      call,
      beforeHash: localRecordHash(before),
      afterHash: localRecordHash(after),
      registryRevision: plan.registryRevision,
      actionId: plan.actionId,
      candidate: plan.candidate,
      applications: completionApplications(prefix),
    }) ||
    !Number.isSafeInteger(plan.registryRevision) ||
    plan.registryRevision < 0 ||
    (!equal(current, before) && !equal(current, after))
  )
    throw Error('integration_conflict_recovery_required');
  const mutations = planIntegrationConflict(current, expected, files);
  const confirmed = await objects.getReference(conflictKey(call, 'confirmed'));
  if (
    confirmed &&
    (mutations.length || !equal(await objects.get(confirmed), conflictReceipt(planHash, plan)))
  )
    throw Error('integration_conflict_recovery_required');
  return { planHash, plan, before, after, mutations, confirmed };
}
