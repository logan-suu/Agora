/** Trusted serial task-control step for the first TESTER dispatch. The source
 * proves native/Git completion; this service alone rebuilds Coordinator writes. */
import { type AppState, canonicalJson, type Mutation, type RoleSpec } from '@agora/core-domain';
import type {
  ValidationDispatchCall,
  ValidationDispatchCommitSource,
  ValidationDispatchReference,
  ValidationDispatchScope,
  ValidationPreparationPublication,
} from '@agora/runtime-sandbox';
import type { ParallelDecisionContext } from './parallel-coordinator';
import {
  createInitialValidationDispatchPlan,
  type InitialValidationDispatchPlan,
  initialValidationDispatchChanges,
  type ValidationDispatchSeed,
} from './validation-dispatch-plan';

type Options = {
  source: ValidationDispatchCommitSource;
  state: {
    compareAndCommit(
      scope: { projectId: string; taskId: string },
      expected: AppState,
      mutations: readonly Mutation[],
    ): Promise<{ state: AppState; changed: boolean }>;
  };
  readControl(scope: ValidationDispatchReference['scope']): Promise<{
    context: ParallelDecisionContext;
    roster: readonly RoleSpec[];
  }>;
};

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Caller holds trusted task-serial control throughout. A thrown CAS response
 * may follow persistence: retry with the same reference; never mint new IDs. */
export async function commitInitialValidationDispatch(
  input: ValidationDispatchReference,
  options: Options,
  expectation?: {
    seed: ValidationDispatchSeed;
    before?: AppState;
    plan?: InitialValidationDispatchPlan;
  },
): Promise<{ stage: 'dispatched'; planHash: string }> {
  const reference = structuredClone(input);
  const expected = expectation === undefined ? undefined : structuredClone(expectation);
  const first = await options.source.readFixedForCommit(reference);
  if (first.planHash !== reference.planHash) throw Error('initial_validation_preparation_mismatch');
  const plan = structuredClone(first.plan) as InitialValidationDispatchPlan;
  const before = structuredClone(first.before);
  if (
    expected &&
    (!equal(plan.seed, expected.seed) ||
      (expected.before !== undefined && !equal(before, expected.before)) ||
      (expected.plan !== undefined && !equal(plan, expected.plan)))
  )
    throw Error('initial_validation_preparation_mismatch');
  const stateForStage = first.stage === 'released' ? before : plan.after;
  const control = await options.readControl(structuredClone(reference.scope));
  const changes = initialValidationDispatchChanges(
    stateForStage,
    plan,
    control.context,
    control.roster,
  );
  if ((first.stage === 'released') !== changes.length > 0)
    throw Error('initial_validation_preparation_mismatch');

  if (first.stage === 'released') {
    const rechecked = await options.source.readForCommit(reference);
    if (!equal(first, rechecked)) throw Error('initial_validation_preparation_state_changed');
    const latestControl = await options.readControl(structuredClone(reference.scope));
    const latestChanges = initialValidationDispatchChanges(
      before,
      plan,
      latestControl.context,
      latestControl.roster,
    );
    if (!equal(changes, latestChanges)) throw Error('initial_validation_preparation_state_changed');
    // An exception may follow the durable rename. Preserve the original slot
    // and let an explicit retry recognize only the exact canonical after-State.
    const committed = await options.state.compareAndCommit(
      { projectId: reference.scope.projectId, taskId: reference.scope.taskId },
      before,
      latestChanges,
    );
    if (!committed.changed || !equal(committed.state, plan.after))
      throw Error('initial_validation_preparation_state_changed');
  }

  const final = await options.source.readForCommit(reference);
  if (
    final.stage !== 'dispatched' ||
    final.planHash !== reference.planHash ||
    !equal(final.before, before) ||
    !equal(final.plan, plan)
  )
    throw Error('initial_validation_preparation_state_changed');
  return { stage: 'dispatched', planHash: reference.planHash };
}

export type InitialValidationPreparationInput = {
  scope: ValidationDispatchScope;
  call: ValidationDispatchCall;
  actionId: string;
  validationWorkspaceId: string;
  seed: ValidationDispatchSeed;
};

/** Caller holds the task-serial control. Load the exclusive slot before using
 * the seed, so a lost publication or CAS response cannot mint another plan. */
export async function publishAndCommitInitialValidationDispatch(
  input: InitialValidationPreparationInput,
  options: Options & { publication: ValidationPreparationPublication },
): Promise<{ stage: 'dispatched'; planHash: string }> {
  const request = structuredClone(input);
  const { scope, call, actionId, validationWorkspaceId, seed } = request;
  if (
    !equal(
      { projectId: call.projectId, taskId: call.taskId, integrationId: call.integrationId },
      { projectId: scope.projectId, taskId: scope.taskId, integrationId: scope.integrationId },
    )
  )
    throw Error('initial_validation_preparation_mismatch');
  const existing = await options.publication.load(scope);
  if (existing) {
    if (
      existing.actionId !== actionId ||
      existing.validationWorkspaceId !== validationWorkspaceId ||
      !equal(existing.call, call)
    )
      throw Error('initial_validation_preparation_mismatch');
    const reference = { scope, planHash: existing.planHash };
    return commitInitialValidationDispatch(reference, options, { seed });
  }

  const origin = await options.publication.readHandoff(call);
  const wave = origin.state.parallelExecution?.activeWave;
  if (
    !equal(
      {
        projectId: origin.state.projectId,
        taskId: origin.state.taskId,
        waveId: wave?.waveId,
        attempt: wave?.attempt,
        integrationId: origin.state.integration?.integrationId,
      },
      scope,
    ) ||
    origin.version.kind !== 'git' ||
    origin.version.commit !== origin.state.integration?.resultCommit
  )
    throw Error('initial_validation_preparation_mismatch');
  const control = await options.readControl(structuredClone(scope));
  const dispatchPlan = createInitialValidationDispatchPlan(
    origin.state,
    seed,
    control.context,
    control.roster,
  );
  const saved = await options.publication.publish({
    scope,
    call,
    actionId,
    validationWorkspaceId,
    origin,
    dispatchPlan: JSON.parse(JSON.stringify(dispatchPlan)),
  });
  const reference = { scope, planHash: saved.planHash };
  return commitInitialValidationDispatch(reference, options, {
    seed,
    before: origin.state,
    plan: dispatchPlan,
  });
}
