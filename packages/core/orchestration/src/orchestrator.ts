import type { AppState, RoleSpec } from '@agora/core-domain';
import { applyMutations, setMutation } from '@agora/core-domain';
import { decide } from './coordinator';
import type { WorkerRuntime } from './worker-runtime';

export interface OrchestrationDeps {
  workerRuntime: WorkerRuntime;
  /**
   * Team composition forwarded to the coordinator's conditional routing
   * (task 2.2). Phase 0/1 composition roots pass their 3-role roster to keep
   * the fixed CODER↔TESTER slice; omit for the full 6-role machine.
   */
  roster?: readonly RoleSpec[];
}

export function entry(state: AppState): AppState {
  // Phase 0 退化：State 已由 createInitialAppState 初始化；complexity 评估归 Tier 任务（4.1）。
  return state;
}

export async function runOrchestration(
  initialState: AppState,
  deps: OrchestrationDeps,
): Promise<AppState> {
  let state = entry(initialState);
  while (state.phase !== 'done') {
    const decision = decide(state, deps.roster === undefined ? undefined : { roster: deps.roster });
    if (decision.mutations.length > 0) {
      state = applyMutations(state, decision.mutations);
    }
    const route = decision.route;
    switch (route.kind) {
      case 'worker':
        state = await deps.workerRuntime.runOne(state, route.batch[0]);
        break;
      case 'finalize':
        state = applyMutations(state, [setMutation('phase', 'done')]);
        break;
      case 'integrate':
        throw new Error('integrate node is excluded from the Phase 0 slice (spec §9)');
      case 'human_gate':
        // Spec §3 pseudocode awaits humanGate(state) then continues; the leader
        // ruling loop does not exist until Phase 8, so continuing would re-trigger
        // the gate forever. The Phase 2 escalation hook halts instead: state
        // carries state.humanGate + the escalation message awaiting the leader.
        // Phase 8 replaces this halt with the terminate-and-fork body (D4).
        return state;
    }
  }
  return state;
}
