/** Publish the sole first-TESTER preparation plan from a confirmed handoff.
 * The caller owns task-serial control and supplies the L2 Coordinator plan;
 * this adapter never creates a worker, claim, lease or executable authority. */
import type { AppState } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalIntegrationCall } from './local-integration-authority';
import type { LocalIntegrationHandoff } from './local-integration-handoff';
import { handoffKey, readIntegrationHandoffPlan } from './local-integration-handoff-records';
import { localRecordHash, parseLocalRegistry } from './local-registry-records';
import type { LocalValidationPreparationRecords } from './local-validation-preparation-records';
import type {
  ValidationDispatchCall,
  ValidationDispatchScope,
  ValidationHandoffOrigin,
  ValidationPreparationPublication,
} from './validation-dispatch-port';

const equal = (left: unknown, right: unknown) => localRecordHash(left) === localRecordHash(right);

export class LocalValidationPreparationPublication implements ValidationPreparationPublication {
  constructor(
    private readonly options: {
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      records: LocalValidationPreparationRecords;
      handoff: LocalIntegrationHandoff;
    },
  ) {}

  async load(scope: ValidationDispatchScope) {
    const saved = await this.options.records.load(structuredClone(scope));
    if (!saved) return undefined;
    const call = (await this.options.objects.get(saved.plan.callHash)) as LocalIntegrationCall;
    if (
      !equal(
        { projectId: call.projectId, taskId: call.taskId, integrationId: call.integrationId },
        {
          projectId: scope.projectId,
          taskId: scope.taskId,
          integrationId: scope.integrationId,
        },
      )
    )
      throw Error('initial_validation_preparation_mismatch');
    return {
      planHash: saved.planHash,
      actionId: saved.plan.actionId,
      validationWorkspaceId: saved.plan.validationWorkspaceId,
      call: structuredClone(call),
    };
  }

  async readHandoff(input: ValidationDispatchCall): Promise<ValidationHandoffOrigin> {
    const call = structuredClone(input) as LocalIntegrationCall;
    const released = await this.options.handoff.read(call);
    const registry = await this.options.control.snapshot();
    const confirmedHash = await this.options.objects.getReference(handoffKey(call, 'confirmed'));
    if (!confirmedHash) throw Error('initial_validation_preparation_mismatch');
    const origin = {
      state: released.state,
      version: released.version,
      registry,
      handoffPlanHash: released.planHash,
      handoffConfirmedHash: confirmedHash,
    };
    await this.assertCurrent(call, origin);
    return structuredClone(origin);
  }

  async publish(input: {
    scope: ValidationDispatchScope;
    call: ValidationDispatchCall;
    actionId: string;
    validationWorkspaceId: string;
    origin: ValidationHandoffOrigin;
    dispatchPlan: unknown;
  }) {
    const request = structuredClone(input);
    const { scope, call, actionId, validationWorkspaceId, origin, dispatchPlan } = request;
    if (
      !equal(
        { projectId: call.projectId, taskId: call.taskId, integrationId: call.integrationId },
        {
          projectId: scope.projectId,
          taskId: scope.taskId,
          integrationId: scope.integrationId,
        },
      ) ||
      !equal((dispatchPlan as { before?: AppState })?.before, origin.state)
    )
      throw Error('initial_validation_preparation_mismatch');
    await this.assertCurrent(call, origin);
    const { objects, records } = this.options;
    const plan = {
      schemaVersion: 'local-validation-preparation-plan-v1' as const,
      scope,
      actionId,
      dispatchId: (dispatchPlan as { seed: { dispatchId: string } }).seed.dispatchId,
      workerId: `worker:${(dispatchPlan as { seed: { dispatchId: string } }).seed.dispatchId}:0`,
      validationWorkspaceId,
      callHash: await objects.put(call),
      handoffPlanHash: origin.handoffPlanHash,
      handoffConfirmedHash: origin.handoffConfirmedHash,
      versionHash: await objects.put(origin.version),
      beforeStateHash: await objects.put(origin.state),
      registryHash: await objects.put(parseLocalRegistry(origin.registry)),
      dispatchPlanHash: await objects.put(dispatchPlan),
    };
    const saved = await records.publish(plan);
    await this.assertCurrent(call, origin);
    return { planHash: saved.planHash };
  }

  private async assertCurrent(call: ValidationDispatchCall, input: ValidationHandoffOrigin) {
    const { control, objects } = this.options;
    const origin = structuredClone(input);
    const state = await control.assertClosed(call);
    const registry = await control.snapshot();
    if (!equal(state, origin.state) || !equal(registry, origin.registry))
      throw Error('initial_validation_preparation_state_changed');
    const proof = await readIntegrationHandoffPlan(
      objects,
      call,
      state,
      parseLocalRegistry(registry),
    );
    const confirmedHash = await objects.getReference(handoffKey(call, 'confirmed'));
    if (
      proof.status !== 'released' ||
      proof.planHash !== origin.handoffPlanHash ||
      confirmedHash !== origin.handoffConfirmedHash ||
      !equal(proof.completion.plan.version, origin.version) ||
      !equal(await objects.get(confirmedHash), {
        schemaVersion: 'local-integration-handoff-confirmed-v1',
        planHash: proof.planHash,
        stateHash: localRecordHash(state),
        registryHash: localRecordHash(registry),
        version: origin.version,
        closureReceiptId: proof.plan.closureReceiptId,
      })
    )
      throw Error('initial_validation_preparation_state_changed');
    if (
      !equal(await control.assertClosed(call), state) ||
      !equal(await control.snapshot(), registry)
    )
      throw Error('initial_validation_preparation_state_changed');
  }
}
