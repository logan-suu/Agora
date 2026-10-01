/** Bind the first validation dispatch to one confirmed integration handoff.
 * This checks durable control only; physical source proof and execution admission
 * remain separate trusted steps.
 */
import type { AppState, WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalIntegrationCall } from './local-integration-authority';
import { completionKey } from './local-integration-completion-records';
import { handoffKey, readIntegrationHandoffPlan } from './local-integration-handoff-records';
import {
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';
import type {
  LocalValidationPreparationRecords,
  ValidationPreparationPlan,
} from './local-validation-preparation-records';
import type {
  ValidationDispatchReference,
  ValidationDispatchVerifier,
} from './validation-dispatch-port';

export type ValidationPreparationReference = ValidationDispatchReference;
/** A proof-only view of the fixed original handoff. Registered readers must
 * independently authenticate their exact current State and registry. */
export type ValidationPreparationProofReader = {
  read(input: ValidationPreparationReference): Promise<{
    stage: 'released' | 'dispatched' | 'registered';
    call: LocalIntegrationCall;
    version: WorkspaceVersionV1;
    planHash: string;
  }>;
  readFixedHandoff(input: ValidationPreparationReference): Promise<{
    stage: 'released' | 'dispatched' | 'registered';
    call: LocalIntegrationCall;
    version: WorkspaceVersionV1;
    planHash: string;
    releasedState: AppState;
    releasedRegistry: LocalRegistryRecords;
  }>;
};

const equal = (left: unknown, right: unknown) => localRecordHash(left) === localRecordHash(right);

export class LocalValidationPreparationControl {
  constructor(
    private readonly options: {
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      records: LocalValidationPreparationRecords;
      verifier: ValidationDispatchVerifier;
    },
  ) {}

  private async checkOriginalReferences(
    reference: ValidationPreparationReference,
    plan: ValidationPreparationPlan,
    call: LocalIntegrationCall,
    handoff: Awaited<ReturnType<typeof readIntegrationHandoffPlan>>,
  ) {
    const { objects, records } = this.options;
    const final = await records.load(reference.scope);
    if (
      final?.planHash !== reference.planHash ||
      (await objects.getReference(completionKey(call, 'plan'))) !== handoff.completion.planHash ||
      (await objects.getReference(completionKey(call, 'confirmed'))) !==
        handoff.completion.confirmed ||
      (await objects.getReference(completionKey(call, 'invalid'))) ||
      (await objects.getReference(handoffKey(call, 'plan'))) !== plan.handoffPlanHash ||
      (await objects.getReference(handoffKey(call, 'confirmed'))) !== plan.handoffConfirmedHash ||
      (await objects.getReference(handoffKey(call, 'invalid')))
    )
      throw Error('initial_validation_preparation_state_changed');
  }

  private async readOriginal(input: ValidationPreparationReference) {
    const reference = structuredClone(input);
    if (
      !reference ||
      Object.keys(reference).sort().join(',') !== 'planHash,scope' ||
      typeof reference.planHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(reference.planHash)
    )
      throw Error('initial_validation_preparation_mismatch');
    const { objects, records } = this.options;
    const saved = await records.load(reference.scope);
    if (!saved || saved.planHash !== reference.planHash)
      throw Error('initial_validation_preparation_mismatch');
    const { plan } = saved;
    const call = (await objects.get(plan.callHash)) as LocalIntegrationCall;
    const before = (await objects.get(plan.beforeStateHash)) as AppState;
    const releasedRegistry = parseLocalRegistry(await objects.get(plan.registryHash));
    const version = (await objects.get(plan.versionHash)) as WorkspaceVersionV1;
    const dispatch = await objects.get(plan.dispatchPlanHash);
    if (
      !call ||
      !equal(
        { projectId: call.projectId, taskId: call.taskId, integrationId: call.integrationId },
        {
          projectId: plan.scope.projectId,
          taskId: plan.scope.taskId,
          integrationId: plan.scope.integrationId,
        },
      )
    )
      throw Error('initial_validation_preparation_mismatch');
    const handoff = await readIntegrationHandoffPlan(objects, call, before, releasedRegistry);
    const confirmedHash = await objects.getReference(handoffKey(call, 'confirmed'));
    if (
      handoff.status !== 'released' ||
      handoff.planHash !== plan.handoffPlanHash ||
      confirmedHash !== plan.handoffConfirmedHash ||
      !equal(version, handoff.completion.plan.version) ||
      !equal(await objects.get(confirmedHash), {
        schemaVersion: 'local-integration-handoff-confirmed-v1',
        planHash: handoff.planHash,
        stateHash: localRecordHash(before),
        registryHash: localRecordHash(releasedRegistry),
        version: handoff.completion.plan.version,
        closureReceiptId: handoff.plan.closureReceiptId,
      })
    )
      throw Error('initial_validation_preparation_mismatch');
    await this.checkOriginalReferences(reference, plan, call, handoff);
    return {
      plan,
      call,
      before,
      releasedRegistry,
      version,
      dispatch,
      handoff,
      planHash: saved.planHash,
    };
  }

  /** Historical source is inert; a registered reader must separately prove the
   * exact current State/registry before it can use this original pair. */
  async readHistorical(input: ValidationPreparationReference) {
    const reference = structuredClone(input);
    const first = await this.readOriginal(reference);
    const dispatched = (first.dispatch as { after?: AppState })?.after;
    if (
      !dispatched ||
      (await this.options.verifier.verify({
        identity: {
          scope: first.plan.scope,
          dispatchId: first.plan.dispatchId,
          workerId: first.plan.workerId,
        },
        before: first.before,
        current: dispatched,
        plan: first.dispatch,
      })) !== 'dispatched'
    )
      throw Error('initial_validation_preparation_mismatch');
    await this.checkOriginalReferences(reference, first.plan, first.call, first.handoff);
    return {
      ...first,
      dispatchedState: structuredClone(dispatched),
    };
  }

  /** Every read rechecks the unique slot, original closure and full current control. */
  async read(input: ValidationPreparationReference) {
    const reference = structuredClone(input);
    const first = await this.readOriginal(reference);
    const { control, verifier } = this.options;
    const current = await control.assertClosed(first.plan.scope);
    const registry = await control.snapshot();
    if (!equal(registry, first.releasedRegistry))
      throw Error('initial_validation_preparation_state_changed');
    const stage = await verifier.verify({
      identity: {
        scope: first.plan.scope,
        dispatchId: first.plan.dispatchId,
        workerId: first.plan.workerId,
      },
      before: first.before,
      current,
      plan: first.dispatch,
    });
    const finalCurrent = await control.assertClosed(first.plan.scope);
    const finalRegistry = await control.snapshot();
    if (
      !equal(finalCurrent, current) ||
      !equal(finalRegistry, registry) ||
      (await verifier.verify({
        identity: {
          scope: first.plan.scope,
          dispatchId: first.plan.dispatchId,
          workerId: first.plan.workerId,
        },
        before: first.before,
        current: finalCurrent,
        plan: first.dispatch,
      })) !== stage
    )
      throw Error('initial_validation_preparation_state_changed');
    await this.checkOriginalReferences(reference, first.plan, first.call, first.handoff);
    return {
      stage,
      call: structuredClone(first.call),
      version: structuredClone(first.version),
      planHash: first.planHash,
    };
  }

  /** Fixed historical pair for the internal proof-only integration reader. The
   * caller cannot supply either snapshot; current control is checked twice. */
  async readFixedHandoff(input: ValidationPreparationReference) {
    const reference = structuredClone(input);
    const before = await this.read(reference);
    const saved = await this.options.records.load(reference.scope);
    if (saved?.planHash !== reference.planHash)
      throw Error('initial_validation_preparation_state_changed');
    const releasedState = (await this.options.objects.get(saved.plan.beforeStateHash)) as AppState;
    const releasedRegistry = parseLocalRegistry(
      await this.options.objects.get(saved.plan.registryHash),
    );
    const after = await this.read(reference);
    if (!equal(before, after)) throw Error('initial_validation_preparation_state_changed');
    return { ...after, releasedState, releasedRegistry };
  }

  /** Fixed plan for trusted L2 CAS only. This does not itself authorize a commit. */
  async readFixedDispatch(input: ValidationPreparationReference) {
    const reference = structuredClone(input);
    const before = await this.read(reference);
    const saved = await this.options.records.load(reference.scope);
    if (saved?.planHash !== reference.planHash)
      throw Error('initial_validation_preparation_state_changed');
    const releasedState = (await this.options.objects.get(saved.plan.beforeStateHash)) as AppState;
    const plan = await this.options.objects.get(saved.plan.dispatchPlanHash);
    const after = await this.read(reference);
    if (!equal(before, after)) throw Error('initial_validation_preparation_state_changed');
    return { ...after, before: releasedState, plan };
  }
}
