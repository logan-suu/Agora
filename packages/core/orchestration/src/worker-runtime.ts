import type { AppState, Mutation, RoleSpec } from '@agora/core-domain';
import { applyMutations } from '@agora/core-domain';
import { type Executor, project } from '@agora/runtime-executor';
import type { Assignment } from './coordinator';

export interface WorkerRuntimeDeps {
  roster: readonly RoleSpec[];
  buildExecutor(spec: RoleSpec, assign: Assignment): Executor;
  transition?: StateTransition;
}

export type StateTransition = (
  state: AppState,
  mutations: readonly Mutation[],
) => Promise<AppState>;

interface WorkerHandle {
  id: string;
  role: string;
  executor: Executor;
  done: boolean;
}

export class UnknownRoleError extends Error {
  constructor(role: string) {
    super(`role "${role}" is not present in the roster`);
    this.name = 'UnknownRoleError';
  }
}

export class WorkerRuntime {
  paused = false;

  private readonly active = new Map<string, WorkerHandle>();

  constructor(private readonly deps: WorkerRuntimeDeps) {}

  /**
   * Roster visibility for composition-root binding assertions (DEF-008,
   * task 2.5): lets the assembly point verify that the routing roster and
   * the execution roster agree before any dispatch can hit specOf().
   */
  get roster(): readonly RoleSpec[] {
    return this.deps.roster;
  }

  async runOne(state: AppState, assign: Assignment): Promise<AppState> {
    const spec = this.specOf(assign.role);
    const executor = this.deps.buildExecutor(spec, assign);
    const handle: WorkerHandle = {
      id: crypto.randomUUID(),
      role: assign.role,
      executor,
      done: false,
    };
    this.active.set(handle.id, handle);
    try {
      return await this.loop(state, handle);
    } finally {
      this.active.delete(handle.id);
    }
  }

  async runParallel(state: AppState, batch: readonly Assignment[]): Promise<AppState> {
    let current = state;
    for (const assign of batch) {
      current = await this.runOne(current, assign);
    }
    return current;
  }

  private specOf(role: string): RoleSpec {
    const spec = this.deps.roster.find((entry) => entry.role === role);
    if (spec === undefined) throw new UnknownRoleError(role);
    return spec;
  }

  private async loop(state: AppState, handle: WorkerHandle): Promise<AppState> {
    let current = state;
    while (!handle.done) {
      if (this.paused) {
        await handle.executor.saveSafePoint();
        return current;
      }
      const result = await handle.executor.step({
        sessionId: crypto.randomUUID(),
        view: project(current, handle.role, this.deps.roster),
      });
      current = await this.transition(current, result.mutations);
      if (result.kind === 'done') handle.done = true;
    }
    return current;
  }

  private transition(state: AppState, mutations: readonly Mutation[]): Promise<AppState> {
    if (this.deps.transition !== undefined) return this.deps.transition(state, mutations);
    return Promise.resolve(applyMutations(state, mutations));
  }
}
