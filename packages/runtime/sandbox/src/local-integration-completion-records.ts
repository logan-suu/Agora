/** Immutable completion control evidence. Physical proofs are checked separately. */
import {
  type AppState,
  applyMutations,
  planIntegrationCompletion,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { readConfirmedApplicationPrefix } from './local-integration-application-records';
import type { LocalIntegrationCall } from './local-integration-authority';
import { localRecordHash } from './local-registry-records';

export const completionKey = (call: LocalIntegrationCall, stage: string) =>
  localRecordHash({ kind: 'integration-completion', call, stage });
export type IntegrationCompletionPlan = {
  schemaVersion: 'local-integration-completion-plan-v1';
  call: LocalIntegrationCall;
  beforeHash: string;
  afterHash: string;
  registryRevision: number;
  applications: { key: string; inputHash: string; resultHash: string; confirmationHash: string }[];
  version: WorkspaceVersionV1;
};
export const completionApplications = (
  proofs: Awaited<ReturnType<typeof readConfirmedApplicationPrefix>>,
) =>
  proofs.map(({ key, inputHash, resultHash, confirmationHash }) => ({
    key,
    inputHash,
    resultHash,
    confirmationHash,
  }));
export const completionReceipt = (planHash: string, plan: IntegrationCompletionPlan) => ({
  schemaVersion: 'local-integration-completion-confirmed-v1',
  planHash,
  stateHash: plan.afterHash,
  version: plan.version,
});
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);

export async function readIntegrationCompletionPlan(
  objects: LocalControlObjects,
  call: LocalIntegrationCall,
  current: AppState,
) {
  const planHash = await objects.getReference(completionKey(call, 'plan'));
  if (!planHash || (await objects.getReference(completionKey(call, 'invalid'))))
    throw Error('integration_completion_recovery_required');
  const plan = (await objects.get(planHash)) as IntegrationCompletionPlan;
  const before = (await objects.get(plan.beforeHash)) as AppState;
  const changes = planIntegrationCompletion(before, before);
  const after = applyMutations(before, changes);
  const proofs = await readConfirmedApplicationPrefix(objects, before, call);
  const latest = proofs[0];
  if (
    !latest ||
    before.integration?.integrationId !== call.integrationId ||
    !Number.isSafeInteger(plan.registryRevision) ||
    plan.registryRevision < 0 ||
    !equal(plan, {
      schemaVersion: 'local-integration-completion-plan-v1',
      call,
      beforeHash: localRecordHash(before),
      afterHash: localRecordHash(after),
      registryRevision: plan.registryRevision,
      applications: completionApplications(proofs),
      version: latest.result.version,
    })
  )
    throw Error('integration_completion_recovery_required');
  const mutations = planIntegrationCompletion(current, before);
  const confirmed = await objects.getReference(completionKey(call, 'confirmed'));
  if (
    confirmed &&
    (mutations.length || !equal(await objects.get(confirmed), completionReceipt(planHash, plan)))
  )
    throw Error('integration_completion_recovery_required');
  return { planHash, plan, before, after, mutations, confirmed };
}
