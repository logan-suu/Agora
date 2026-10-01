/** Read-only historical admission anchored to a canonical Leader conflict receipt. */
import { type AppState, readCodingWorkerLineage } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalIntegrationCall } from './local-integration-authority';
import {
  conflictHandoffKey,
  type IntegrationConflictHandoffPlan,
  readIntegrationConflictHandoffPlan,
} from './local-integration-conflict-handoff-records';
import { handoffStages } from './local-integration-handoff-records';
import {
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';

const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
export async function readConflictReworkHistory(
  objects: LocalControlObjects,
  call: LocalIntegrationCall,
  state: AppState,
  snapshot: LocalRegistryRecords,
) {
  const lineage = readCodingWorkerLineage(state);
  const rework = lineage.conflictReworks.find(
    (r) => r.integration.integrationId === call.integrationId,
  );
  const planHash = await objects.getReference(conflictHandoffKey(call, 'plan'));
  const confirmedHash = await objects.getReference(conflictHandoffKey(call, 'confirmed'));
  if (
    !rework ||
    !planHash ||
    !confirmedHash ||
    state.projectId !== call.projectId ||
    state.taskId !== call.taskId
  )
    throw Error('integration_conflict_rework_mismatch');
  const plan = (await objects.get(planHash)) as IntegrationConflictHandoffPlan;
  const conflicted = (await objects.get(plan.conflictedStateHash)) as AppState;
  const registry = parseLocalRegistry(await objects.get(plan.registryHash));
  const released = handoffStages(call, conflicted, registry, plan.closureReceiptId).at(-1);
  if (!released || !same(conflicted.integration, rework.integration))
    throw Error('integration_conflict_rework_mismatch');
  const proof = await readIntegrationConflictHandoffPlan(
    objects,
    call,
    released.state,
    released.snapshot,
  );
  if (
    proof.status !== 'released' ||
    proof.planHash !== planHash ||
    !same(await objects.get(confirmedHash), {
      schemaVersion: 'local-integration-conflict-handoff-confirmed-v1',
      planHash,
      stateHash: localRecordHash(released.state),
      registryHash: localRecordHash(released.snapshot),
      version: proof.conflict.plan.candidate.targetVersion,
      closureReceiptId: plan.closureReceiptId,
    })
  )
    throw Error('integration_conflict_rework_mismatch');
  // Original ownership and closed claims must survive subsequent append-only registration.
  for (const [oldRecords, currentRecords, key] of [
    [released.snapshot.workspaces, snapshot.workspaces, 'workspaceId'],
    [released.snapshot.linkedRoots ?? [], snapshot.linkedRoots ?? [], 'workspaceId'],
    [released.snapshot.claims, snapshot.claims, 'claimId'],
    [released.snapshot.operations, snapshot.operations, 'actionId'],
  ] as const) {
    for (const old of oldRecords) {
      const record = old as unknown as Record<string, unknown>;
      if (record.projectId !== call.projectId || record.taskId !== call.taskId) continue;
      if (
        !currentRecords.some(
          (entry) =>
            (entry as unknown as Record<string, unknown>)[key] === record[key] && same(entry, old),
        )
      )
        throw Error('integration_conflict_rework_mismatch');
    }
  }
  for (const branch of rework.integration.pendingBranches) {
    const old = conflicted.workers.find((w) => w.workerId === branch.workerId);
    if (
      !old ||
      !same(
        state.workers.find((w) => w.workerId === branch.workerId),
        old,
      )
    )
      throw Error('integration_conflict_rework_mismatch');
  }
  for (const workspace of conflicted.localExecution?.workspaces ?? []) {
    if (!state.localExecution?.workspaces.some((w) => same(w, workspace)))
      throw Error('integration_conflict_rework_mismatch');
  }
  for (const receipt of released.state.localExecution?.receipts ?? []) {
    if (!state.localExecution?.receipts.some((r) => same(r, receipt)))
      throw Error('integration_conflict_rework_mismatch');
  }
  return { rework, proof, released, planHash, confirmedHash };
}
