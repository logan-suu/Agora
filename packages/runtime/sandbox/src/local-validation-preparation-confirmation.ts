/** Confirm an already committed first-TESTER registration. This internal
 * control-plane receipt is not a test result or an execution capability. */
import type { AppState } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalGitWorkspaces } from './local-git-workspaces';
import { localRecordHash } from './local-registry-records';
import {
  type LocalValidationPreparationRecords,
  type ValidationPreparationScope,
  validationPreparationSlot,
} from './local-validation-preparation-records';
import { serializeWorkspaceOperation } from './local-workspace-operation';
import type { ValidationGitRegistrationRequest } from './validation-dispatch-port';

type Confirmed = {
  schemaVersion: 'local-validation-preparation-confirmed-v1';
  scope: ValidationPreparationScope;
  planHash: string;
  registrationHash: string;
  bindingHash: string;
  stateHash: string;
  registryHash: string;
  workerId: string;
  workspaceId: string;
};
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

function confirmationKey(scope: ValidationPreparationScope) {
  return localRecordHash({
    kind: 'initial-validation-confirmed',
    slot: validationPreparationSlot(scope),
  });
}

function parseConfirmed(value: unknown): Confirmed {
  const record = value as Confirmed;
  if (
    !record ||
    Object.keys(record).sort().join(',') !==
      'bindingHash,planHash,registrationHash,registryHash,schemaVersion,scope,stateHash,workerId,workspaceId' ||
    record.schemaVersion !== 'local-validation-preparation-confirmed-v1' ||
    ![
      record.planHash,
      record.registrationHash,
      record.bindingHash,
      record.stateHash,
      record.registryHash,
    ].every(hash) ||
    ![record.workerId, record.workspaceId].every(
      (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
    )
  )
    throw Error('validation_preparation_confirmation_invalid');
  validationPreparationSlot(record.scope);
  return record;
}

export class LocalValidationPreparationConfirmation {
  constructor(
    private readonly options: {
      control: LocalBindingCoordinator;
      objects: LocalControlObjects;
      records: LocalValidationPreparationRecords;
      workspaces: Pick<LocalGitWorkspaces, 'registerValidation'>;
    },
  ) {}

  /** Caller holds trusted serial task control. A missing/partial registration
   * is rejected before invoking the workspaces service, so this cannot create it. */
  async confirm(input: ValidationPreparationScope): Promise<Confirmed> {
    const scope = structuredClone(input);
    return serializeWorkspaceOperation(
      { ...scope, workspaceId: `validation-preparation:${validationPreparationSlot(scope)}` },
      async () => {
        const existing = await this.load(scope);
        const verified = await this.verify(scope);
        if (existing) {
          if (!equal(existing, verified))
            throw Error('validation_preparation_confirmation_changed');
          return existing;
        }
        if ((await this.options.objects.references()).length >= 4096)
          throw Error('control_reference_limit');
        const reference = confirmationKey(scope);
        const objectHash = await this.options.objects.put(verified);
        await this.assertControl(verified);
        await this.options.objects.bindReference(reference, objectHash);
        return verified;
      },
    );
  }

  /** Re-proves both linked workspaces and the original native completion.
   * Later worker lifecycle states are intentionally outside this stage. */
  async read(input: ValidationPreparationScope): Promise<Confirmed> {
    const scope = structuredClone(input);
    const existing = await this.load(scope);
    if (!existing) throw Error('validation_preparation_unconfirmed');
    const verified = await this.verify(scope);
    if (!equal(existing, verified)) throw Error('validation_preparation_confirmation_changed');
    return existing;
  }

  /** Trusted serial route check, before WorkerRuntime receives a pending
   * TESTER. It re-proves the immutable confirmation and exact current State. */
  async admitPending(state: AppState, workerId: string): Promise<AppState> {
    const wave = state.parallelExecution?.activeWave;
    const integration = state.integration;
    const validation = wave?.validation;
    const worker = state.workers.find((entry) => entry.workerId === workerId);
    const binding = state.localExecution?.bindings.find((entry) => entry.workerId === workerId);
    if (
      !wave ||
      !integration ||
      !validation ||
      state.localExecution?.git === undefined ||
      state.phase !== 'testing' ||
      state.nextRole !== 'TESTER' ||
      state.humanGate !== undefined ||
      integration.status !== 'done' ||
      integration.integrationId !== validation.integrationId ||
      validation.workerId !== workerId ||
      worker?.role !== 'TESTER' ||
      worker.status !== 'pending' ||
      worker.subtaskId !== undefined ||
      !binding ||
      binding.subtaskId !== undefined
    )
      throw Error('validation_preparation_admission_denied');
    const scope = {
      projectId: state.projectId,
      taskId: state.taskId,
      waveId: wave.waveId,
      attempt: wave.attempt,
      integrationId: integration.integrationId,
    };
    const confirmed = await this.read(scope);
    if (
      confirmed.workerId !== workerId ||
      confirmed.workspaceId !== binding.workspaceId ||
      confirmed.stateHash !== localRecordHash(state)
    )
      throw Error('validation_preparation_admission_denied');
    const latest = await this.options.control.assertClosed(scope);
    if (!equal(latest, state)) throw Error('validation_preparation_admission_changed');
    return latest;
  }

  private async load(scope: ValidationPreparationScope) {
    const reference = confirmationKey(scope);
    const objectHash = await this.options.objects.getReference(reference);
    if (!objectHash) return undefined;
    const record = parseConfirmed(await this.options.objects.get(objectHash));
    if (
      !equal(record.scope, scope) ||
      (await this.options.objects.getReference(reference)) !== objectHash
    )
      throw Error('validation_preparation_confirmation_invalid');
    return record;
  }

  private async assertControl(record: Confirmed) {
    const state = await this.options.control.assertClosed(record.scope);
    const registry = await this.options.control.snapshot();
    if (
      !equal(state, await this.options.control.assertClosed(record.scope)) ||
      !equal(registry, await this.options.control.snapshot()) ||
      localRecordHash(state) !== record.stateHash ||
      localRecordHash(registry) !== record.registryHash
    )
      throw Error('validation_preparation_confirmation_changed');
  }

  private async verify(scope: ValidationPreparationScope): Promise<Confirmed> {
    const { objects, records, control, workspaces } = this.options;
    const saved = await records.load(scope);
    if (!saved) throw Error('validation_preparation_unconfirmed');
    const key = localRecordHash({
      kind: 'validation-git-registration',
      projectId: scope.projectId,
      taskId: scope.taskId,
      actionId: saved.plan.actionId,
    });
    const registrationHash = await objects.getReference(key);
    const bindingHash = await objects.getReference(localRecordHash({ key, stage: 'binding' }));
    if (!registrationHash || !bindingHash) throw Error('validation_registration_recovery_required');
    const stored = (await objects.get(registrationHash)) as {
      request?: ValidationGitRegistrationRequest;
      gitOptions?: unknown;
    };
    const request = stored.request;
    if (
      !stored ||
      Object.keys(stored).sort().join(',') !== 'gitOptions,request' ||
      !request ||
      !equal(
        {
          projectId: request.projectId,
          taskId: request.taskId,
          waveId: request.waveId,
          attempt: request.attempt,
          integrationId: request.integrationId,
        },
        scope,
      ) ||
      request.planHash !== saved.planHash ||
      request.actionId !== saved.plan.actionId ||
      request.dispatchId !== saved.plan.dispatchId ||
      request.targets?.length !== 1 ||
      request.targets[0]?.workerId !== saved.plan.workerId ||
      request.targets[0]?.workspaceId !== saved.plan.validationWorkspaceId ||
      localRecordHash(stored) !== registrationHash
    )
      throw Error('validation_preparation_confirmation_invalid');
    const beforeState = await control.assertClosed(scope);
    const beforeRegistry = await control.snapshot();
    const operation = beforeRegistry.operations.find((op) => op.actionId === request.actionId);
    if (operation?.stage !== 'committed' || operation.inputHash !== bindingHash)
      throw Error('validation_registration_recovery_required');
    const references = await objects.references();
    // The exclusive input and committed operation force registerValidation down
    // its read-only recovery branch. That branch re-proves both physical roots.
    const result = await workspaces.registerValidation(request);
    if (
      result.length !== 1 ||
      result[0]?.workspaceId !== saved.plan.validationWorkspaceId ||
      !equal(await control.assertClosed(scope), beforeState) ||
      !equal(await control.snapshot(), beforeRegistry) ||
      !equal(await objects.references(), references) ||
      (await records.load(scope))?.planHash !== saved.planHash
    )
      throw Error('validation_preparation_confirmation_changed');
    return {
      schemaVersion: 'local-validation-preparation-confirmed-v1',
      scope,
      planHash: saved.planHash,
      registrationHash,
      bindingHash,
      stateHash: localRecordHash(beforeState),
      registryHash: localRecordHash(beforeRegistry),
      workerId: saved.plan.workerId,
      workspaceId: saved.plan.validationWorkspaceId,
    };
  }
}
