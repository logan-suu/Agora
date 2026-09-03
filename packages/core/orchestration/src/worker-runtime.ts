import type { AppState, Mutation, RoleSpec } from '@agora/core-domain';
import { applyMutations } from '@agora/core-domain';
import { type Executor, project, type StepResult } from '@agora/runtime-executor';
import type { Assignment } from './coordinator';

export interface WorkerRuntimeDeps {
  roster: readonly RoleSpec[];
  loadRoster?: () => Promise<readonly RoleSpec[]>;
  buildExecutor(spec: RoleSpec, assign: Assignment): Executor;
  buildChannelContext?: (
    state: AppState,
    role: string,
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  handleOutput?: StepOutputHandler;
  transition?: StateTransition;
  transitionStep?: WorkerStepTransition;
}

export type StepOutputHandler = (
  state: AppState,
  role: string,
  output: StepResult['output'],
) => Promise<void>;

export type StateTransition = (
  state: AppState,
  mutations: readonly Mutation[],
) => Promise<AppState>;

export type WorkerStepTransition = (
  state: AppState,
  role: string,
  mutations: readonly Mutation[],
) => Promise<AppState>;

interface WorkerHandle {
  id: string;
  role: string;
  executor: Executor;
  done: boolean;
  drainRequested: boolean;
  drainPromise?: Promise<string>;
  resolveDrain?: (safePointRef: string) => void;
  rejectDrain?: (error: unknown) => void;
}

export interface RoleDrainResult {
  role: string;
  activeWorkers: number;
  safePointRefs: readonly string[];
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
    const spec = this.specOf(assign.role, await this.currentRoster());
    const executor = this.deps.buildExecutor(spec, assign);
    const handle: WorkerHandle = {
      id: crypto.randomUUID(),
      role: assign.role,
      executor,
      done: false,
      drainRequested: false,
    };
    this.active.set(handle.id, handle);
    try {
      return await this.loop(state, handle);
    } catch (error) {
      handle.rejectDrain?.(error);
      throw error;
    } finally {
      this.active.delete(handle.id);
    }
  }

  async awaitRoleSafePoint(role: string): Promise<RoleDrainResult> {
    const handles = [...this.active.values()].filter((handle) => handle.role === role);
    const safePointRefs = await Promise.all(handles.map((handle) => this.requestDrain(handle)));
    return { role, activeWorkers: handles.length, safePointRefs };
  }

  async runParallel(state: AppState, batch: readonly Assignment[]): Promise<AppState> {
    let current = state;
    for (const assign of batch) {
      current = await this.runOne(current, assign);
    }
    return current;
  }

  private specOf(role: string, roster: readonly RoleSpec[]): RoleSpec {
    const spec = roster.find((entry) => entry.role === role);
    if (spec === undefined) throw new UnknownRoleError(role);
    return spec;
  }

  private async loop(state: AppState, handle: WorkerHandle): Promise<AppState> {
    let current = state;
    while (!handle.done) {
      if (this.paused || handle.drainRequested) {
        await this.saveDrainSafePoint(handle);
        return current;
      }
      const roster = await this.currentRoster();
      if (!roster.some((entry) => entry.role === handle.role)) {
        await this.saveDrainSafePoint(handle);
        return current;
      }
      const channelContext =
        this.deps.buildChannelContext === undefined
          ? []
          : await this.deps.buildChannelContext(current, handle.role);
      if (
        this.paused ||
        handle.drainRequested ||
        !(await this.currentRoster()).some((entry) => entry.role === handle.role)
      ) {
        await this.saveDrainSafePoint(handle);
        return current;
      }
      const result = await handle.executor.step({
        sessionId: crypto.randomUUID(),
        view: project(current, handle.role, roster, channelContext),
      });
      const roleStillEnabled = (await this.currentRoster()).some(
        (entry) => entry.role === handle.role,
      );
      if (this.deps.handleOutput !== undefined && !handle.drainRequested && roleStillEnabled) {
        await this.deps.handleOutput(current, handle.role, result.output);
      }
      current = await this.transitionStep(current, handle.role, result.mutations);
      if (result.kind === 'done') handle.done = true;
      if (handle.drainRequested || !roleStillEnabled) {
        await this.saveDrainSafePoint(handle);
        return current;
      }
    }
    return current;
  }

  private requestDrain(handle: WorkerHandle): Promise<string> {
    handle.drainRequested = true;
    if (handle.drainPromise !== undefined) return handle.drainPromise;
    handle.drainPromise = new Promise<string>((resolve, reject) => {
      handle.resolveDrain = resolve;
      handle.rejectDrain = reject;
    });
    return handle.drainPromise;
  }

  private async saveDrainSafePoint(handle: WorkerHandle): Promise<string> {
    const safePointRef = await handle.executor.saveSafePoint();
    handle.resolveDrain?.(safePointRef);
    return safePointRef;
  }

  private currentRoster(): Promise<readonly RoleSpec[]> {
    return this.deps.loadRoster?.() ?? Promise.resolve(this.deps.roster);
  }

  private transition(state: AppState, mutations: readonly Mutation[]): Promise<AppState> {
    if (this.deps.transition !== undefined) return this.deps.transition(state, mutations);
    return Promise.resolve(applyMutations(state, mutations));
  }

  private transitionStep(
    state: AppState,
    role: string,
    mutations: readonly Mutation[],
  ): Promise<AppState> {
    if (this.deps.transitionStep !== undefined) {
      return this.deps.transitionStep(state, role, mutations);
    }
    return this.transition(state, mutations);
  }
}
