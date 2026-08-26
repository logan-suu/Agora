import type { AppState } from '@agora/core-domain';
import { applyMutations, setMutation } from '@agora/core-domain';
import { decide } from './coordinator';
import type { WorkerRuntime } from './worker-runtime';

export interface OrchestrationDeps {
  workerRuntime: WorkerRuntime;
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
    const decision = decide(state);
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
        throw new Error('humanGate node is excluded from the Phase 0 slice (spec §9)');
    }
  }
  return state;
}
