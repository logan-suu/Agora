/** Preserve an exact completed version before closing its integration writer. */
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import type { LocalIntegrationCompletion } from './local-integration-completion';
import { readIntegrationCompletionPlan } from './local-integration-completion-records';
import {
  handoffKey,
  type IntegrationHandoffPlan,
  readIntegrationHandoffPlan,
} from './local-integration-handoff-records';
import type { LocalIntegrationTreeBatch } from './local-integration-tree-batch';
import { localRecordHash } from './local-registry-records';
import { serializeWorkspaceOperation } from './local-workspace-operation';

export class LocalIntegrationHandoff {
  constructor(
    private readonly options: {
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      authority: LocalIntegrationAuthority;
      completion: LocalIntegrationCompletion;
      batches: LocalIntegrationTreeBatch;
    },
  ) {}

  /** Caller holds serial task control. No phase/worker/TESTER capability is created. */
  async release(input: LocalIntegrationCall) {
    const call = structuredClone(input);
    return serializeWorkspaceOperation(
      { ...call, workspaceId: `application:${call.integrationId}` },
      async () => {
        const { objects, control, completion, authority, batches } = this.options;
        if (await objects.getReference(handoffKey(call, 'invalid')))
          throw Error('integration_handoff_recovery_required');
        if (!(await objects.getReference(handoffKey(call, 'plan')))) {
          const completed = await completion.read(call);
          const registry = await control.snapshot();
          const proof = await readIntegrationCompletionPlan(objects, call, completed);
          const claim = registry.claims.find((c) => c.claimId === call.claimId);
          if (
            !proof.confirmed ||
            claim?.kind !== 'integration' ||
            claim.status !== 'active' ||
            registry.revision !== proof.plan.registryRevision
          )
            throw Error('integration_handoff_recovery_required');
          const closureReceiptId = await batches.closure(claim);
          const checkpoint = await authority.completionReader(call).readCheckpoint(call);
          if (
            localRecordHash(await control.assertClosed(call)) !== localRecordHash(completed) ||
            localRecordHash(checkpoint.snapshot) !== localRecordHash(registry)
          )
            throw Error('integration_handoff_state_changed');
          const plan: IntegrationHandoffPlan = {
            schemaVersion: 'local-integration-handoff-plan-v1',
            call,
            completedStateHash: await objects.put(completed),
            registryHash: await objects.put(registry),
            completionPlanHash: proof.planHash,
            completionConfirmedHash: proof.confirmed,
            closureReceiptId,
          };
          if ((await objects.references()).length > 4093) throw Error('control_reference_limit');
          await checkpoint.authorize();
          await objects.bindReference(handoffKey(call, 'plan'), await objects.put(plan));
        }
        const proof = await this.proof(call);
        if (await objects.getReference(handoffKey(call, 'confirmed'))) return this.read(call);
        await this.verify(call);
        // Failure can follow a durable drain/release. Never discard the original plan.
        await authority.release(call);
        try {
          const checked = await this.verify(call);
          if (checked.status !== 'released') throw Error('integration_handoff_state_changed');
          await objects.bindReference(
            handoffKey(call, 'confirmed'),
            await objects.put({
              schemaVersion: 'local-integration-handoff-confirmed-v1',
              planHash: proof.planHash,
              stateHash: localRecordHash(checked.state),
              registryHash: localRecordHash(checked.snapshot),
              version: checked.completion.plan.version,
              closureReceiptId: checked.plan.closureReceiptId,
            }),
          );
          await this.proof(call);
          return {
            state: checked.state,
            version: checked.completion.plan.version,
            planHash: checked.planHash,
          };
        } catch (error) {
          await objects.bindReference(
            handoffKey(call, 'invalid'),
            await objects.put({
              schemaVersion: 'local-integration-handoff-invalid-v1',
              planHash: proof.planHash,
            }),
          );
          throw error;
        }
      },
    );
  }

  /** Confirmed closure only. This is not admission for a new validation dispatch. */
  async read(input: LocalIntegrationCall) {
    const call = structuredClone(input);
    const proof = await this.proof(call);
    const hash = await this.options.objects.getReference(handoffKey(call, 'confirmed'));
    if (
      !hash ||
      proof.status !== 'released' ||
      localRecordHash(await this.options.objects.get(hash)) !==
        localRecordHash({
          schemaVersion: 'local-integration-handoff-confirmed-v1',
          planHash: proof.planHash,
          stateHash: localRecordHash(proof.state),
          registryHash: localRecordHash(proof.snapshot),
          version: proof.completion.plan.version,
          closureReceiptId: proof.plan.closureReceiptId,
        })
    )
      throw Error('integration_handoff_recovery_required');
    const checked = await this.verify(call);
    if (
      checked.planHash !== proof.planHash ||
      localRecordHash(checked.state) !== localRecordHash(proof.state)
    )
      throw Error('integration_handoff_state_changed');
    return {
      state: checked.state,
      version: checked.completion.plan.version,
      planHash: checked.planHash,
    };
  }

  private async proof(call: LocalIntegrationCall) {
    const { objects, control } = this.options;
    const state = await control.assertClosed(call),
      snapshot = await control.snapshot();
    return {
      ...(await readIntegrationHandoffPlan(objects, call, state, snapshot)),
      state,
      snapshot,
    };
  }
  private async verify(call: LocalIntegrationCall) {
    const before = await this.proof(call);
    await this.options.completion.readHandoff(call);
    const claim = before.snapshot.claims.find((c) => c.claimId === call.claimId);
    if (
      claim?.kind !== 'integration' ||
      (await this.options.batches.closure(claim)) !== before.plan.closureReceiptId
    )
      throw Error('integration_closure_changed');
    const after = await this.proof(call);
    if (localRecordHash(before) !== localRecordHash(after))
      throw Error('integration_handoff_state_changed');
    return after;
  }
}
