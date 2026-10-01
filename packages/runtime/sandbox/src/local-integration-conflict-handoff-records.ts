/** Immutable conflict origin and the two exact binding-only closure transitions. */
import type { AppState } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalIntegrationCall } from './local-integration-authority';
import { readIntegrationConflictPlan } from './local-integration-conflict-records';
import {
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';

const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
export const conflictHandoffKey = (call: LocalIntegrationCall, stage: string) =>
  localRecordHash({ kind: 'integration-conflict-handoff', call, stage });
export type IntegrationConflictHandoffPlan = {
  schemaVersion: 'local-integration-conflict-handoff-plan-v1';
  call: LocalIntegrationCall;
  conflictedStateHash: string;
  registryHash: string;
  conflictPlanHash: string;
  conflictConfirmedHash: string;
  closureReceiptId: string;
};

import { assertHandoffStage, handoffStages } from './local-integration-handoff-records';
export async function readIntegrationConflictHandoffPlan(
  objects: LocalControlObjects,
  call: LocalIntegrationCall,
  state: AppState,
  snapshot: LocalRegistryRecords,
) {
  const planHash = await objects.getReference(conflictHandoffKey(call, 'plan'));
  if (!planHash || (await objects.getReference(conflictHandoffKey(call, 'invalid'))))
    throw Error('integration_conflict_handoff_recovery_required');
  const plan = (await objects.get(planHash)) as IntegrationConflictHandoffPlan;
  const conflicted = (await objects.get(plan.conflictedStateHash)) as AppState;
  const registry = parseLocalRegistry(await objects.get(plan.registryHash));
  const conflict = await readIntegrationConflictPlan(objects, call, conflicted);
  if (
    !conflict.confirmed ||
    conflict.mutations.length ||
    registry.revision !== conflict.plan.registryRevision ||
    !equal(plan, {
      schemaVersion: 'local-integration-conflict-handoff-plan-v1',
      call,
      conflictedStateHash: localRecordHash(conflicted),
      registryHash: localRecordHash(registry),
      conflictPlanHash: conflict.planHash,
      conflictConfirmedHash: conflict.confirmed,
      closureReceiptId: plan.closureReceiptId,
    })
  )
    throw Error('integration_conflict_handoff_recovery_required');
  const stages = handoffStages(call, conflicted, registry, plan.closureReceiptId);
  const status = assertHandoffStage(stages, state, snapshot);
  return { plan, planHash, conflicted, registry, conflict, stages, status };
}
