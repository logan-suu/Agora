/** Trusted control planning only. Persistence, native provenance and execution admission are separate. */
import {
  type AppState,
  applyMutations,
  assertParallelState,
  canonicalJson,
  isIntegration,
  type Mutation,
  type RoleSpec,
} from '@agora/core-domain';
import type { ValidationDispatchScope, ValidationDispatchVerifier } from '@agora/runtime-sandbox';
import { type CoordinatorDecision, decide } from './coordinator';
import type { ParallelDecisionContext } from './parallel-coordinator';

export type ValidationDispatchSeed = {
  dispatchId: string;
  dispatchTs: number;
  ledgerId: string;
  ledgerTs: number;
};
export type InitialValidationDispatchPlan = {
  schemaVersion: 'initial-validation-dispatch-plan-v1';
  before: AppState;
  seed: ValidationDispatchSeed;
  context: ParallelDecisionContext;
  decision: CoordinatorDecision;
  after: AppState;
};
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const id = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);

/** Uses the existing Coordinator, including its ledger and objection/roster gates. */
export function createInitialValidationDispatchPlan(
  input: AppState,
  identity: ValidationDispatchSeed,
  currentContext: ParallelDecisionContext,
  roster: readonly RoleSpec[],
): InitialValidationDispatchPlan {
  const before = structuredClone(input),
    seed = structuredClone(identity),
    context = structuredClone(currentContext);
  const execution = before.parallelExecution,
    wave = execution?.activeWave,
    integration = before.integration;
  assertParallelState(before);
  if (
    Object.keys(seed).sort().join(',') !== 'dispatchId,dispatchTs,ledgerId,ledgerTs' ||
    !id(seed.dispatchId) ||
    !id(seed.ledgerId) ||
    seed.dispatchId === seed.ledgerId ||
    !Number.isSafeInteger(seed.dispatchTs) ||
    seed.dispatchTs < 0 ||
    !Number.isSafeInteger(seed.ledgerTs) ||
    seed.ledgerTs < seed.dispatchTs ||
    Object.keys(context).sort().join(',') !== 'controlFingerprint,initialBase' ||
    !/^[a-f0-9]{64}$/.test(context.controlFingerprint) ||
    !execution ||
    !wave ||
    !equal(context.initialBase, execution.initialBase) ||
    before.phase !== 'integrating' ||
    before.humanGate !== undefined ||
    wave.validation ||
    !isIntegration(integration) ||
    integration.status !== 'done' ||
    integration.waveId !== wave.waveId ||
    !integration.resultCommit ||
    integration.resultCommit !== integration.integrationWorktree.headCommit ||
    before.workers.some((worker) => worker.status === 'running' || worker.status === 'paused') ||
    before.messages.some((message) => [seed.dispatchId, seed.ledgerId].includes(message.msgId)) ||
    before.workers.some(
      (worker) =>
        worker.workerId === `worker:${seed.dispatchId}:0` ||
        worker.sessionId === `session:worker:${seed.dispatchId}:0`,
    )
  )
    throw Error('initial_validation_dispatch_mismatch');
  const ids = [seed.dispatchId, seed.ledgerId],
    timestamps = [seed.dispatchTs, seed.ledgerTs];
  const decision = decide(before, {
    parallel: context,
    roster,
    newId: () => {
      const value = ids.shift();
      if (value === undefined) throw Error('initial_validation_dispatch_mismatch');
      return value;
    },
    now: () => {
      const value = timestamps.shift();
      if (value === undefined) throw Error('initial_validation_dispatch_mismatch');
      return value;
    },
  });
  if (
    ids.length ||
    timestamps.length ||
    decision.route.kind !== 'worker' ||
    decision.route.parallel ||
    decision.route.batch.length !== 1 ||
    !equal(decision.route.batch[0], { workerId: `worker:${seed.dispatchId}:0`, role: 'TESTER' }) ||
    decision.completionCandidate !== undefined ||
    decision.requestSatisfied !== undefined
  )
    throw Error('initial_validation_dispatch_mismatch');
  const after = applyMutations(before, decision.mutations);
  return structuredClone({
    schemaVersion: 'initial-validation-dispatch-plan-v1',
    before,
    seed,
    context,
    decision,
    after,
  });
}

/** Reconstruct a stored plan; return only mutations, never permission to start a worker. */
export function initialValidationDispatchChanges(
  current: AppState,
  plan: InitialValidationDispatchPlan,
  context: ParallelDecisionContext,
  roster: readonly RoleSpec[],
): Mutation[] {
  const canonical = createInitialValidationDispatchPlan(plan.before, plan.seed, context, roster);
  if (!equal(plan, canonical)) throw Error('initial_validation_dispatch_mismatch');
  if (equal(current, canonical.after)) return [];
  if (!equal(current, canonical.before)) throw Error('initial_validation_dispatch_state_changed');
  return canonical.decision.mutations;
}

/** Construct only in trusted composition. The reader reloads current control on
 * every call; callers cannot supply a cached roster or substitute Coordinator rules. */
export function createValidationDispatchVerifier(
  readControl: (scope: ValidationDispatchScope) => Promise<{
    context: ParallelDecisionContext;
    roster: readonly RoleSpec[];
  }>,
): ValidationDispatchVerifier {
  return {
    async verify(input) {
      const { identity, before, current, plan: value } = structuredClone(input);
      const plan = value as InitialValidationDispatchPlan;
      const wave = before.parallelExecution?.activeWave;
      if (
        !plan ||
        !identity ||
        !wave ||
        !before.integration ||
        !equal(identity, {
          scope: {
            projectId: before.projectId,
            taskId: before.taskId,
            waveId: wave.waveId,
            attempt: wave.attempt,
            integrationId: before.integration.integrationId,
          },
          dispatchId: plan.seed?.dispatchId,
          workerId: `worker:${plan.seed?.dispatchId}:0`,
        }) ||
        !equal(before, plan.before)
      )
        throw Error('initial_validation_preparation_mismatch');
      const { context, roster } = await readControl(structuredClone(identity.scope));
      initialValidationDispatchChanges(current, plan, context, roster);
      return equal(current, before) ? 'released' : 'dispatched';
    },
  };
}
