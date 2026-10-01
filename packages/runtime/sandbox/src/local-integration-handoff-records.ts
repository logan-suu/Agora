/** Immutable completion origin and the two exact binding-only closure transitions. */
import type { AppState } from '@agora/core-domain';
import type { LocalBindingRequest } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalIntegrationCall } from './local-integration-authority';
import { readIntegrationCompletionPlan } from './local-integration-completion-records';
import {
  type LocalBindingOperation,
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';

const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
export const handoffKey = (call: LocalIntegrationCall, stage: string) =>
  localRecordHash({ kind: 'integration-handoff', call, stage });
export type IntegrationHandoffPlan = {
  schemaVersion: 'local-integration-handoff-plan-v1';
  call: LocalIntegrationCall;
  completedStateHash: string;
  registryHash: string;
  completionPlanHash: string;
  completionConfirmedHash: string;
  closureReceiptId: string;
};
type Stage = {
  status: 'active' | 'draining' | 'released';
  state: AppState;
  snapshot: LocalRegistryRecords;
};

/** Reconstruct the existing binding protocol, without committing or granting authority. */
export function handoffStages(
  call: LocalIntegrationCall,
  completed: AppState,
  registry: LocalRegistryRecords,
  closureReceiptId: string,
): Stage[] {
  const claim = registry.claims.find((c) => c.claimId === call.claimId);
  const workspace = registry.workspaces.find((w) => w.workspaceId === call.workspaceId);
  const grant = registry.grants.find((g) => g.grantId === workspace?.grantId);
  if (
    completed.projectId !== call.projectId ||
    completed.taskId !== call.taskId ||
    !completed.localExecution ||
    claim?.kind !== 'integration' ||
    claim.status !== 'active' ||
    claim.closureReceiptId !== null ||
    !grant ||
    grant.status !== 'active' ||
    grant.revision !== call.grantRevision ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(closureReceiptId) ||
    !equal(call, {
      projectId: claim.projectId,
      taskId: claim.taskId,
      workspaceId: claim.workspaceId,
      claimId: claim.claimId,
      integrationId: claim.integrationId,
      writerEpoch: claim.writerEpoch,
      grantRevision: claim.grantRevision,
    })
  )
    throw Error('integration_handoff_state_changed');
  const stages: Stage[] = [
    {
      status: 'active',
      state: structuredClone(completed),
      snapshot: structuredClone(registry),
    },
  ];
  const key = localRecordHash({ kind: 'integration-release', call });
  for (const status of ['draining', 'released'] as const) {
    const previous = stages.at(-1);
    if (!previous?.state.localExecution) throw Error('integration_handoff_state_changed');
    const snapshot = previous.snapshot;
    const actionId = `${status === 'draining' ? 'drain' : 'release'}:${key}`;
    if (snapshot.operations.some((o) => o.actionId === actionId))
      throw Error('integration_handoff_state_changed');
    const request: LocalBindingRequest = {
      projectId: call.projectId,
      taskId: call.taskId,
      actionId,
      sourceMessageId: grant.leaderMessageId,
      expectedRevision: snapshot.revision,
      nextLocalExecution: structuredClone(previous.state.localExecution),
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        workspaces: snapshot.workspaces,
        linkedRoots: snapshot.linkedRoots ?? [],
        claims: snapshot.claims.map((c) =>
          c.claimId === call.claimId
            ? { ...c, status, closureReceiptId: status === 'released' ? closureReceiptId : null }
            : c,
        ),
      },
    };
    const inputHash = localRecordHash(request),
      preparedRevision = snapshot.revision + 1;
    const receiptId = `binding:${actionId}`;
    const nextLocalExecution = structuredClone(request.nextLocalExecution);
    nextLocalExecution.receipts.push({
      actionId,
      inputHash,
      receiptId,
      registryRevision: preparedRevision,
    });
    const operation: LocalBindingOperation = {
      actionId,
      inputHash,
      receiptId,
      projectId: call.projectId,
      taskId: call.taskId,
      preparedRevision,
      stage: 'committed',
      sourceMessageId: grant.leaderMessageId,
      previousLocalHash: localRecordHash(previous.state.localExecution),
      nextLocalExecution,
    };
    stages.push({
      status,
      state: { ...structuredClone(previous.state), localExecution: nextLocalExecution },
      snapshot: parseLocalRegistry({
        ...snapshot,
        ...request.records,
        revision: snapshot.revision + 2,
        operations: [...snapshot.operations, operation],
      }),
    });
  }
  return stages;
}

export function assertHandoffStage(
  stages: Stage[],
  state: AppState,
  snapshot: LocalRegistryRecords,
) {
  const stage = stages.find((s) => equal(s.state, state) && equal(s.snapshot, snapshot));
  if (!stage) throw Error('integration_handoff_state_changed');
  return stage.status;
}

export async function readIntegrationHandoffPlan(
  objects: LocalControlObjects,
  call: LocalIntegrationCall,
  state: AppState,
  snapshot: LocalRegistryRecords,
) {
  const planHash = await objects.getReference(handoffKey(call, 'plan'));
  if (!planHash || (await objects.getReference(handoffKey(call, 'invalid'))))
    throw Error('integration_handoff_recovery_required');
  const plan = (await objects.get(planHash)) as IntegrationHandoffPlan;
  const completed = (await objects.get(plan.completedStateHash)) as AppState;
  const registry = parseLocalRegistry(await objects.get(plan.registryHash));
  const completion = await readIntegrationCompletionPlan(objects, call, completed);
  if (
    !completion.confirmed ||
    completion.mutations.length ||
    registry.revision !== completion.plan.registryRevision ||
    !equal(plan, {
      schemaVersion: 'local-integration-handoff-plan-v1',
      call,
      completedStateHash: localRecordHash(completed),
      registryHash: localRecordHash(registry),
      completionPlanHash: completion.planHash,
      completionConfirmedHash: completion.confirmed,
      closureReceiptId: plan.closureReceiptId,
    })
  )
    throw Error('integration_handoff_recovery_required');
  const stages = handoffStages(call, completed, registry, plan.closureReceiptId);
  const status = assertHandoffStage(stages, state, snapshot);
  return { plan, planHash, completed, registry, completion, stages, status };
}
