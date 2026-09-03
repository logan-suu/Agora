import type { AppState, HumanGateRequest, Mutation, RoleSpec } from '@agora/core-domain';
import { applyMutations, setMutation } from '@agora/core-domain';
import { evaluateComplexity } from './complexity';
import { decide } from './coordinator';
import { materializeHumanGate } from './human-gate';
import type { StateTransition, WorkerRuntime } from './worker-runtime';

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
  if (state.complexity === undefined) {
    state = await transition(state, [
      setMutation('complexity', evaluateComplexity({ goal: state.goal })),
    ]);
  }
  while (state.phase !== 'done') {
    const roster = (await deps.loadRoster?.()) ?? deps.roster;
    const decision = decide(state, roster === undefined ? undefined : { roster });
    if (decision.mutations.length > 0) {
      state = await transition(state, decision.mutations);
    }
    const route = decision.route;
    switch (route.kind) {
      case 'worker':
        state = await deps.workerRuntime.runOne(state, route.batch[0]);
        break;
      case 'finalize':
        state = await transition(state, [setMutation('phase', 'done')]);
        break;
      case 'integrate':
        throw new Error('integrate node is excluded from the Phase 0 slice (spec §9)');
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
