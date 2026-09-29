/** Host-owned first-TESTER preparation. The caller supplies the task-serial
 * queue and trusted identity source; no model or HTTP input reaches this port. */
import { type AppState, canonicalJson } from '@agora/core-domain';
import {
  type InitialValidationPreparationInput,
  publishAndCommitInitialValidationDispatch,
} from '@agora/core-orchestration';
import { createInitialValidationRegistrationRequest } from '../../../../packages/core/orchestration/src/initial-validation-registration-plan';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalControlObjects } from '../../../../packages/runtime/sandbox/src/local-control-objects';
import type { LocalGitWorkspaces } from '../../../../packages/runtime/sandbox/src/local-git-workspaces';
import type { LocalValidationPreparationConfirmation } from '../../../../packages/runtime/sandbox/src/local-validation-preparation-confirmation';
import type { LocalValidationPreparationRecords } from '../../../../packages/runtime/sandbox/src/local-validation-preparation-records';
import type { LocalValidationPreparationSource } from '../../../../packages/runtime/sandbox/src/local-validation-preparation-source';
import type { ValidationDispatchScope } from '../../../../packages/runtime/sandbox/src/validation-dispatch-port';

type Scope = Pick<ValidationDispatchScope, 'projectId' | 'taskId'>;
type Options = {
  runTaskSerial<T>(scope: Scope, operation: () => Promise<T>): Promise<T>;
  createInitialInput(
    state: AppState,
    scope: ValidationDispatchScope,
  ): Promise<InitialValidationPreparationInput>;
  dispatch: Parameters<typeof publishAndCommitInitialValidationDispatch>[1];
  control: LocalBindingCoordinator;
  objects: LocalControlObjects;
  records: LocalValidationPreparationRecords;
  physical: Pick<LocalValidationPreparationSource, 'read'>;
  workspaces: Pick<LocalGitWorkspaces, 'registerValidation'>;
  confirmation: Pick<LocalValidationPreparationConfirmation, 'confirm' | 'admitPending'>;
};

const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

function preparationScope(state: AppState): ValidationDispatchScope {
  const wave = state.parallelExecution?.activeWave;
  const integration = state.integration;
  if (
    !state.localExecution?.git ||
    state.phase !== 'integrating' ||
    !wave ||
    !integration ||
    integration.status !== 'done' ||
    integration.waveId !== wave.waveId ||
    wave.validation ||
    state.humanGate !== undefined
  )
    throw Error('initial_validation_preparation_mismatch');
  return {
    projectId: state.projectId,
    taskId: state.taskId,
    waveId: wave.waveId,
    attempt: wave.attempt,
    integrationId: integration.integrationId,
  };
}

/** This service closes only the first registered validation stage. Later
 * worker lifecycle and accepted waves use their own recovery protocols. */
export class LocalInitialValidationPreparation {
  constructor(private readonly options: Options) {}

  async prepare(state: AppState): Promise<AppState> {
    const original = structuredClone(state);
    const scope = preparationScope(original);
    return this.options.runTaskSerial(scope, async () => {
      const { control, records, objects, confirmation } = this.options;
      const saved = await records.load(scope);
      if (saved) {
        const before = await objects.get(saved.plan.beforeStateHash);
        if (!equal(original, before)) throw Error('initial_validation_preparation_mismatch');
        const registry = await control.snapshot();
        if (registry.operations.some((operation) => operation.actionId === saved.plan.actionId)) {
          await confirmation.confirm(scope);
          const registered = await control.assertClosed(scope);
          return confirmation.admitPending(registered, saved.plan.workerId);
        }
      } else if (!equal(await control.assertClosed(scope), original)) {
        throw Error('initial_validation_preparation_state_changed');
      }

      const input = saved
        ? {
            scope,
            call: await objects.get(saved.plan.callHash),
            actionId: saved.plan.actionId,
            validationWorkspaceId: saved.plan.validationWorkspaceId,
            seed: (
              (await objects.get(saved.plan.dispatchPlanHash)) as {
                seed: InitialValidationPreparationInput['seed'];
              }
            ).seed,
          }
        : await this.options.createInitialInput(original, scope);
      if (!equal(input.scope, scope)) throw Error('initial_validation_preparation_mismatch');
      const dispatched = await publishAndCommitInitialValidationDispatch(
        input as InitialValidationPreparationInput,
        this.options.dispatch,
      );
      const fixed = await records.load(scope);
      if (!fixed || fixed.planHash !== dispatched.planHash)
        throw Error('initial_validation_preparation_mismatch');
      const reference = { scope, planHash: fixed.planHash };
      const physical = await this.options.physical.read(reference);
      if (physical.stage !== 'dispatched')
        throw Error('initial_validation_preparation_state_changed');
      const current = await control.assertClosed(scope);
      const registry = await control.snapshot();
      const { context, roster } = await this.options.dispatch.readControl(scope);
      const request = createInitialValidationRegistrationRequest(
        {
          scope,
          planHash: fixed.planHash,
          actionId: fixed.plan.actionId,
          validationWorkspaceId: fixed.plan.validationWorkspaceId,
          call: physical.call,
          version: physical.version,
          plan: (await objects.get(fixed.plan.dispatchPlanHash)) as Parameters<
            typeof createInitialValidationRegistrationRequest
          >[0]['plan'],
          current,
          registry,
        },
        context,
        roster,
      );
      await this.options.workspaces.registerValidation(request);
      await confirmation.confirm(scope);
      const registered = await control.assertClosed(scope);
      return confirmation.admitPending(registered, fixed.plan.workerId);
    });
  }

  admit(state: AppState, workerId: string): Promise<AppState> {
    const scope = { projectId: state.projectId, taskId: state.taskId };
    return this.options.runTaskSerial(scope, () =>
      this.options.confirmation.admitPending(state, workerId),
    );
  }
}
