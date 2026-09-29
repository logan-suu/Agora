import type { AppState, HumanGateRequest, Mutation, RoleSpec } from '@agora/core-domain';
import {
  applyMutations,
  assertDeliveryCompletion,
  canonicalJson,
  currentDeliveryApplicationMessage,
  type DeliveryRepairSource,
  deliveryRepairAssignment,
  deliveryValidationDispatch,
  localDeliveryAwaitsApplication,
  setMutation,
} from '@agora/core-domain';
import { evaluateComplexity } from './complexity';
import { decide } from './coordinator';
import { materializeHumanGate } from './human-gate';
import type { ParallelDecisionContext } from './parallel-coordinator';
import { ParallelBatchError, type StateTransition, type WorkerRuntime } from './worker-runtime';

export interface OrchestrationDeps {
  workerRuntime: WorkerRuntime;
  /**
   * Team composition forwarded to the coordinator's conditional routing
   * (task 2.2). Phase 0/1 composition roots pass their 3-role roster to keep
   * the fixed CODER↔TESTER slice; omit for the full 6-role machine.
   */
  roster?: readonly RoleSpec[];
  loadRoster?: () => Promise<readonly RoleSpec[]>;
  transition?: StateTransition;
  /** D4 composition-root hook: flush durable checkpoints before persisting a complete gate. */
  suspendAtHumanGate?: (state: AppState, request: HumanGateRequest) => Promise<AppState>;
  /** Phase 9 explicit integration node; Coordinator topology wiring lands in 9.4. */
  integrate?: (state: AppState) => Promise<{ state: AppState; gateRequest?: HumanGateRequest }>;
  parallelContext?: (state: AppState) => Promise<ParallelDecisionContext>;
  /** Trusted task-serial control publishes the unique first validation plan,
   * registers its worktree, and confirms preparation before normal routing. */
  prepareLocalValidation?: (state: AppState) => Promise<AppState>;
  /** Re-prove the same pending TESTER on first and recovered dispatch before
   * handing it to WorkerRuntime, which would otherwise acquire a lease. */
  admitLocalValidation?: (state: AppState, workerId: string) => Promise<AppState>;
  /** Re-prove the current application and commit completion atomically. */
  prepareLocalDeliveryRepair?: (state: AppState, source: DeliveryRepairSource) => Promise<AppState>;
  completeLocalDeliveryRepair?: (state: AppState, workerId: string) => Promise<AppState>;
  finalizeLocalDelivery?: (state: AppState) => Promise<AppState>;
  /** Explicit post-application run: no worker, integration or new gate allowed. */
  deliveryFinalizationOnly?: boolean;
}

export function entry(state: AppState): AppState {
  if (state.complexity !== undefined) return state;
  return applyMutations(state, [
    setMutation('complexity', evaluateComplexity({ goal: state.goal })),
  ]);
}

export async function runOrchestration(
  initialState: AppState,
  deps: OrchestrationDeps,
): Promise<AppState> {
  const transition = (state: AppState, mutations: readonly Mutation[]): Promise<AppState> =>
    deps.transition?.(state, mutations) ?? Promise.resolve(applyMutations(state, mutations));
  let state = initialState;
  if (deps.deliveryFinalizationOnly && !deps.finalizeLocalDelivery)
    throw Error('local_delivery_finalization_required');
  if (state.humanGate !== undefined) return state;
  if (state.complexity === undefined) {
    state = await transition(state, [
      setMutation('complexity', evaluateComplexity({ goal: state.goal })),
    ]);
  }
  while (state.phase !== 'done') {
    if (deps.deliveryFinalizationOnly && !localDeliveryAwaitsApplication(state))
      throw Error('delivery_finalization_only');
    // An external lifecycle pause may close while a worker is returning.
    // Preserve its canonical gate until Leader resolution starts a new run.
    if (state.humanGate !== undefined) return state;
    const roster = (await deps.loadRoster?.()) ?? deps.roster;
    const resumingWorkerIds = deps.workerRuntime.resumableWorkerIds;
    const parallel = await deps.parallelContext?.(state);
    const decision = decide(state, {
      ...(parallel === undefined ? {} : { parallel }),
      ...(roster === undefined ? {} : { roster }),
      ...(resumingWorkerIds.length === 0 ? {} : { resumingWorkerIds }),
    });
    if (
      state.localExecution?.git !== undefined &&
      state.phase === 'integrating' &&
      state.integration?.status === 'done' &&
      decision.route.kind === 'worker'
    ) {
      if (
        decision.route.batch.length !== 1 ||
        decision.route.batch[0]?.role !== 'TESTER' ||
        decision.route.batch[0]?.subtaskId !== undefined
      )
        throw Error('local_validation_dispatch_mismatch');
      if (!deps.prepareLocalValidation) throw Error('local_validation_preparation_required');
      const prepared = await deps.prepareLocalValidation(state);
      const validation = prepared.parallelExecution?.activeWave?.validation;
      if (
        prepared.projectId !== state.projectId ||
        prepared.taskId !== state.taskId ||
        prepared.localExecution?.git === undefined ||
        prepared.phase !== 'testing' ||
        prepared.nextRole !== 'TESTER' ||
        prepared.humanGate !== undefined ||
        canonicalJson(prepared.integration) !== canonicalJson(state.integration) ||
        validation?.integrationId !== state.integration.integrationId ||
        !prepared.workers.some(
          (worker) =>
            worker.workerId === validation.workerId &&
            worker.role === 'TESTER' &&
            worker.subtaskId === undefined &&
            worker.status === 'pending',
        )
      )
        throw Error('local_validation_preparation_changed');
      state = prepared;
      continue;
    }
    if (decision.mutations.length > 0) {
      state = await transition(state, decision.mutations);
    }
    const route = decision.route;
    switch (route.kind) {
      case 'repair_delivery': {
        if (!deps.prepareLocalDeliveryRepair) throw Error('local_delivery_repair_required');
        const prepared = await deps.prepareLocalDeliveryRepair(state, route.source);
        const worker = prepared.workers.at(-1);
        const assignment = worker && deliveryRepairAssignment(prepared, worker.workerId);
        if (
          prepared.projectId !== state.projectId ||
          prepared.taskId !== state.taskId ||
          prepared.phase !== 'coding' ||
          prepared.nextRole !== 'CODER' ||
          prepared.humanGate ||
          prepared.iterationCount !== state.iterationCount + 1 ||
          !assignment ||
          worker?.status !== 'pending' ||
          canonicalJson(assignment.source) !== canonicalJson(route.source) ||
          canonicalJson(prepared.workers.slice(0, -1)) !== canonicalJson(state.workers) ||
          canonicalJson(prepared.subtasks) !== canonicalJson(state.subtasks) ||
          canonicalJson(prepared.parallelExecution) !== canonicalJson(state.parallelExecution) ||
          canonicalJson(prepared.localExecution?.delivery) !==
            canonicalJson(state.localExecution?.delivery)
        )
          throw Error('local_delivery_repair_registration_changed');
        state = prepared;
        break;
      }
      case 'validate_delivery_repair': {
        if (!deps.completeLocalDeliveryRepair)
          throw Error('local_delivery_repair_completion_required');
        const completed = await deps.completeLocalDeliveryRepair(state, route.workerId);
        const selected = deliveryValidationDispatch(completed);
        if (
          completed.projectId !== state.projectId ||
          completed.taskId !== state.taskId ||
          completed.phase !== 'testing' ||
          completed.nextRole !== 'TESTER' ||
          completed.humanGate ||
          completed.testResults !== undefined ||
          completed.iterationCount !== state.iterationCount ||
          selected?.repairCandidate?.candidate.workerId !== route.workerId ||
          canonicalJson(completed.workers) !== canonicalJson(state.workers) ||
          canonicalJson(completed.subtasks) !== canonicalJson(state.subtasks) ||
          canonicalJson(completed.parallelExecution) !== canonicalJson(state.parallelExecution) ||
          canonicalJson(completed.localExecution) !== canonicalJson(state.localExecution)
        )
          throw Error('local_delivery_repair_completion_changed');
        state = completed;
        break;
      }
      case 'worker':
        try {
          const validation = state.parallelExecution?.activeWave?.validation;
          if (
            state.localExecution?.git !== undefined &&
            state.phase === 'testing' &&
            validation !== undefined &&
            route.batch.some((assignment) => assignment.workerId === validation.workerId)
          ) {
            if (
              route.batch.length !== 1 ||
              route.batch[0]?.role !== 'TESTER' ||
              route.batch[0]?.subtaskId !== undefined
            )
              throw Error('local_validation_dispatch_mismatch');
            const pending = state.workers.find((worker) => worker.workerId === validation.workerId);
            if (pending?.status === 'pending') {
              if (!deps.admitLocalValidation) throw Error('local_validation_admission_required');
              const admitted = await deps.admitLocalValidation(state, pending.workerId);
              if (canonicalJson(admitted) !== canonicalJson(state))
                throw Error('local_validation_admission_changed');
            }
          }
          state =
            route.parallel || (state.parallelExecution !== undefined && state.phase === 'coding')
              ? await deps.workerRuntime.runParallel(state, route.batch)
              : await deps.workerRuntime.runOne(state, route.batch[0]);
        } catch (error) {
          if (
            !(error instanceof ParallelBatchError) ||
            !error.retryable ||
            error.state.parallelExecution === undefined ||
            error.state.phase !== 'coding'
          )
            throw error;
          state = error.state;
        }
        break;
      case 'await_application':
        if (deps.finalizeLocalDelivery) {
          const completed = await deps.finalizeLocalDelivery(state);
          if (completed.phase === 'done') {
            const application = currentDeliveryApplicationMessage(completed);
            if (!application) throw Error('delivery_completion_incomplete');
            assertDeliveryCompletion(completed, application);
          } else if (canonicalJson(completed) !== canonicalJson(state)) {
            throw Error('delivery_completion_state_changed');
          }
          return completed;
        }
        return state;
      case 'finalize':
        state = await transition(state, [setMutation('phase', 'done')]);
        break;
      case 'integrate':
        if (deps.integrate === undefined) {
          throw new Error('integrate node requires the Phase 9 integration service');
        }
        {
          const result = await deps.integrate(state);
          state = result.state;
          if (result.gateRequest !== undefined) {
            state =
              deps.suspendAtHumanGate === undefined
                ? await transition(state, [
                    setMutation('humanGate', materializeHumanGate(result.gateRequest, [])),
                  ])
                : await deps.suspendAtHumanGate(state, result.gateRequest);
            return state;
          }
        }
        break;
      case 'human_gate':
        state =
          deps.suspendAtHumanGate === undefined
            ? await transition(state, [
                setMutation('humanGate', materializeHumanGate(route.request, [])),
              ])
            : await deps.suspendAtHumanGate(state, route.request);
        return state;
    }
  }
  return state;
}
