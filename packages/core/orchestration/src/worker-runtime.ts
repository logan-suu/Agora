import type { AppState, Mutation, RoleSpec, WorkerState, WorktreeRef } from '@agora/core-domain';
import { applyMutations, mergeByIdMutation } from '@agora/core-domain';
import {
  type PauseMode,
  type PauseReceipt,
  type PauseRequest,
  Preemptor,
  type WorkerPauseReceipt,
} from '@agora/core-preemption';
import { type Executor, project, type StepResult } from '@agora/runtime-executor';
import type { Assignment } from './coordinator';
import { GlobalScheduler, type SlotLease } from './global-scheduler';
import { planObjectionMutations } from './objection';

export interface WorkerRuntimeDeps {
  roster: readonly RoleSpec[];
  resumingWorkers?: readonly { workerId: string; resumeSessionId: string }[];
  loadRoster?: () => Promise<readonly RoleSpec[]>;
  loadState?: () => Promise<AppState | undefined>;
  sessionIdForAssignment?: (assignment: Assignment) => string | undefined;
  buildExecutor(spec: RoleSpec, assign: Assignment, worktree?: WorktreeRef): Executor;
  resolveWorktree?: (state: AppState, assignment: Assignment) => Promise<WorktreeRef>;
  refreshWorktree?: (worktree: WorktreeRef) => Promise<WorktreeRef>;
  buildChannelContext?: (
    state: AppState,
    role: string,
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  handleOutput?: StepOutputHandler;
  planOutput?: StepOutputPlanner;
  transition?: StateTransition;
  transitionStep?: WorkerStepTransition;
  now?: () => number;
}

export type StepOutputHandler = (
  state: AppState,
  role: string,
  output: StepResult['output'],
) => Promise<void>;

export type StepOutputPlanner = (
  state: AppState,
  role: string,
  result: StepResult,
) => readonly Mutation[] | Promise<readonly Mutation[]>;

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
  subtaskId?: string;
  sessionId: string;
  executor: Executor;
  join: CanonicalTaskJoin;
  done: boolean;
  drainRequested: boolean;
  drainPromise?: Promise<string>;
  resolveDrain?: (safePointRef: string) => void;
  rejectDrain?: (error: unknown) => void;
  pause?: WorkerPauseControl;
  worktree?: WorktreeRef;
}

interface WorkerPauseControl {
  actionId: string;
  mode: PauseMode;
  receipt: Promise<WorkerPauseReceipt>;
  resolveReceipt(receipt: WorkerPauseReceipt): void;
  rejectReceipt(error: unknown): void;
  outcome: Promise<'reproject' | 'suspend' | 'abort'>;
  resolveOutcome(outcome: 'reproject' | 'suspend' | 'abort'): void;
}

interface TaskPauseControl {
  actionId: string;
  mode: PauseMode;
  closed: Promise<'reproject' | 'suspend' | 'abort'>;
  resolve(outcome: 'reproject' | 'suspend' | 'abort'): void;
}

interface LeaseReleaseControl {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

export interface RoleDrainResult {
  role: string;
  activeWorkers: number;
  safePointRefs: readonly string[];
}

export interface WorkerFailure {
  workerId: string;
  status: 'failed' | 'not_started_due_to_batch_failure';
  message: string;
}

export class ParallelBatchError extends Error {
  constructor(
    readonly state: AppState,
    readonly failures: readonly WorkerFailure[],
  ) {
    super(
      `parallel worker batch failed: ${failures
        .map((failure) => `${failure.workerId}:${failure.status}:${failure.message}`)
        .join('; ')}`,
    );
    this.name = 'ParallelBatchError';
  }
}

export class UnknownRoleError extends Error {
  constructor(role: string) {
    super(`role "${role}" is not present in the roster`);
    this.name = 'UnknownRoleError';
  }
}

class CanonicalTaskJoin {
  readonly failures: WorkerFailure[] = [];
  #current: AppState;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    state: AppState,
    private readonly loadState: WorkerRuntimeDeps['loadState'],
  ) {
    this.#current = state;
  }

  get projectId(): string {
    return this.#current.projectId;
  }

  get taskId(): string {
    return this.#current.taskId;
  }

  get hasFailure(): boolean {
    return this.failures.some((failure) => failure.status === 'failed');
  }

  async latest(): Promise<AppState> {
    await this.#tail;
    this.#current = await this.#loadCurrent();
    return this.#current;
  }

  commit(operation: (state: AppState) => Promise<AppState>): Promise<AppState> {
    const result = this.#tail
      .catch(() => undefined)
      .then(async () => {
        this.#current = await this.#loadCurrent();
        this.#current = await operation(this.#current);
        return this.#current;
      });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  recordFailure(workerId: string, error: unknown): void {
    if (this.failures.some((failure) => failure.workerId === workerId)) return;
    this.failures.push({ workerId, status: 'failed', message: errorMessage(error) });
  }

  recordNotStarted(workerId: string): void {
    if (this.failures.some((failure) => failure.workerId === workerId)) return;
    this.failures.push({
      workerId,
      status: 'not_started_due_to_batch_failure',
      message: 'a sibling worker failed before this assignment acquired a slot',
    });
  }

  async drainAndLoad(): Promise<AppState> {
    await this.#tail;
    this.#current = await this.#loadCurrent();
    return this.#current;
  }

  async #loadCurrent(): Promise<AppState> {
    if (this.loadState === undefined) return this.#current;
    const loaded = await this.loadState();
    if (loaded === undefined)
      throw new Error('canonical task state disappeared during worker join');
    if (loaded.projectId !== this.#current.projectId || loaded.taskId !== this.#current.taskId) {
      throw new Error('canonical task state identity changed during worker join');
    }
    return loaded;
  }
}

export class WorkerRuntime {
  private readonly active = new Map<string, WorkerHandle>();
  private readonly queuedAcquires = new Map<string, AbortController>();
  private readonly leaseReleases = new Map<string, LeaseReleaseControl>();
  private readonly preemptor: Preemptor;
  private taskPause: TaskPauseControl | undefined;
  private suspended = false;
  private readonly maxParallel: number;
  private readonly resumingWorkerSessions: ReadonlyMap<string, string>;

  constructor(
    private readonly deps: WorkerRuntimeDeps,
    private readonly scheduler: GlobalScheduler = new GlobalScheduler(),
    maxParallel = scheduler.cap,
  ) {
    if (!Number.isInteger(maxParallel) || maxParallel <= 0) {
      throw new Error('WorkerRuntime maxParallel must be a positive integer');
    }
    if (maxParallel > scheduler.cap) {
      throw new Error('WorkerRuntime maxParallel cannot exceed GlobalScheduler cap');
    }
    this.maxParallel = maxParallel;
    this.resumingWorkerSessions = new Map(
      (deps.resumingWorkers ?? []).map((entry) => [entry.workerId, entry.resumeSessionId]),
    );
    if (this.resumingWorkerSessions.size !== (deps.resumingWorkers ?? []).length) {
      throw new Error('resuming workerIds must be unique');
    }
    for (const [workerId, sessionId] of this.resumingWorkerSessions) {
      assertWorkerId(workerId);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) {
        throw new Error('resumeSessionId must match [A-Za-z0-9][A-Za-z0-9._:-]*');
      }
    }
    this.preemptor = new Preemptor({
      activeWorkerIds: (scope) =>
        [...this.active.values()]
          .filter(
            (handle) =>
              !handle.done &&
              handle.join.projectId === scope.projectId &&
              handle.join.taskId === scope.taskId,
          )
          .map((handle) => handle.id),
      cancelQueued: async (scope, actionId, mode) => this.cancelQueued(scope, actionId, mode),
      pauseWorker: async (scope, workerId, actionId, mode) =>
        this.requestWorkerPause(scope, workerId, actionId, mode),
      resumeReprojected: async (scope, workerIds, actionId) =>
        this.resumeReprojected(scope, workerIds, actionId),
      suspendPaused: async (scope, workerIds, actionId) =>
        this.suspendPaused(scope, workerIds, actionId),
      abortPause: async (scope, workerIds, actionId) =>
        this.abortPaused(scope, workerIds, actionId),
    });
  }

  get roster(): readonly RoleSpec[] {
    return this.deps.roster;
  }

  get hasActivePause(): boolean {
    return this.taskPause !== undefined;
  }

  get resumableWorkerIds(): readonly string[] {
    return [...this.resumingWorkerSessions.keys()].sort();
  }

  requestPause(request: PauseRequest): Promise<PauseReceipt> {
    return this.preemptor.requestPause(request);
  }

  completePause(receipt: PauseReceipt): Promise<void> {
    return this.preemptor.complete(receipt);
  }

  abortPause(receipt: PauseReceipt): Promise<void> {
    return this.preemptor.abort(receipt);
  }

  async runOne(state: AppState, assign: Assignment): Promise<AppState> {
    const prepared = await this.prepareAssignments(await this.loadStartState(state), [assign]);
    const join = new CanonicalTaskJoin(prepared, this.deps.loadState);
    const lease = await this.acquireLease(prepared.projectId, prepared.taskId, assign.workerId);
    if (lease === undefined) return join.drainAndLoad();
    this.beginLeaseRelease(assign.workerId);
    try {
      await this.runAssignment(join, assign, false);
    } catch (error) {
      await this.markFailed(join, assign.workerId).catch(() => undefined);
      throw error;
    } finally {
      await this.releaseLease(assign.workerId, lease);
    }
    return join.drainAndLoad();
  }

  async awaitRoleSafePoint(role: string): Promise<RoleDrainResult> {
    const handles = [...this.active.values()].filter(
      (handle) => handle.role === role && !handle.done,
    );
    const safePointRefs = await Promise.all(handles.map((handle) => this.requestDrain(handle)));
    return { role, activeWorkers: handles.length, safePointRefs };
  }

  async runParallel(state: AppState, batch: readonly Assignment[]): Promise<AppState> {
    const prepared = await this.prepareAssignments(await this.loadStartState(state), batch);
    const join = new CanonicalTaskJoin(prepared, this.deps.loadState);
    const queue = [...batch];
    const pumpCount = Math.min(this.maxParallel, queue.length);
    const pumps = Array.from({ length: pumpCount }, () => this.pump(queue, join));
    const settled = await Promise.allSettled(pumps);
    for (const result of settled) {
      if (result.status === 'rejected') join.recordFailure('worker:pool', result.reason);
    }
    if (!this.suspended) {
      for (const assignment of queue) join.recordNotStarted(assignment.workerId);
    }
    const canonical = await join.drainAndLoad();
    const failures = [...join.failures].sort((left, right) =>
      left.workerId.localeCompare(right.workerId),
    );
    if (failures.length > 0 && !this.suspended) throw new ParallelBatchError(canonical, failures);
    return canonical;
  }

  private async pump(queue: Assignment[], join: CanonicalTaskJoin): Promise<void> {
    while (queue.length > 0 && !join.hasFailure && !this.suspended) {
      const assign = queue.shift();
      if (assign === undefined) return;
      let lease: SlotLease | undefined;
      try {
        lease = await this.acquireLease(join.projectId, join.taskId, assign.workerId);
        if (lease === undefined) return;
        this.beginLeaseRelease(assign.workerId);
        if (join.hasFailure) {
          join.recordNotStarted(assign.workerId);
          return;
        }
        await this.runAssignment(join, assign, true);
      } catch (error) {
        join.recordFailure(assign.workerId, error);
        await this.markFailed(join, assign.workerId).catch(() => undefined);
      } finally {
        if (lease !== undefined) {
          try {
            await this.releaseLease(assign.workerId, lease);
          } catch (error) {
            join.recordFailure(assign.workerId, error);
          }
        }
      }
    }
  }

  private async prepareAssignments(
    state: AppState,
    batch: readonly Assignment[],
  ): Promise<AppState> {
    if (batch.length === 0) throw new Error('worker batch must be non-empty');
    const ids = new Set<string>();
    const subtaskIds = new Set<string>();
    const roleWithoutSubtask = new Set<string>();
    const roster = await this.currentRoster();
    const registration: Mutation[] = [];
    for (const assignment of batch) {
      assertWorkerId(assignment.workerId);
      if (ids.has(assignment.workerId)) {
        throw new Error(`duplicate workerId "${assignment.workerId}" in batch`);
      }
      ids.add(assignment.workerId);
      const spec = this.specOf(assignment.role, roster);
      if (spec.executor !== 'harness') {
        throw new Error(`external executor is not enabled for Phase 9 role "${assignment.role}"`);
      }
      if (assignment.subtaskId === undefined) {
        if (roleWithoutSubtask.has(assignment.role)) {
          throw new Error(`parallel role "${assignment.role}" requires distinct subtaskId values`);
        }
        roleWithoutSubtask.add(assignment.role);
      } else {
        if (subtaskIds.has(assignment.subtaskId)) {
          throw new Error(`subtask "${assignment.subtaskId}" has multiple workers in one batch`);
        }
        subtaskIds.add(assignment.subtaskId);
        this.assertReadySubtask(state, assignment.subtaskId);
      }
      const existing = state.workers.find((worker) => worker.workerId === assignment.workerId);
      if (existing === undefined) {
        registration.push(
          mergeByIdMutation('workers', assignment.workerId, {
            workerId: assignment.workerId,
            role: assignment.role,
            executor: 'harness',
            status: 'pending',
            ...(assignment.subtaskId === undefined ? {} : { subtaskId: assignment.subtaskId }),
            sessionId: `session:${assignment.workerId}`,
            startedTs: (this.deps.now ?? Date.now)(),
          }),
        );
      } else {
        this.assertAssignmentMatches(existing, assignment);
        if (!this.canStartWorker(existing)) {
          throw new Error(
            `worker "${assignment.workerId}" cannot start from status "${existing.status}"`,
          );
        }
      }
    }
    if (registration.length === 0) return state;
    return this.transition(state, registration);
  }

  private async loadStartState(state: AppState): Promise<AppState> {
    if (this.deps.loadState === undefined) return state;
    const loaded = await this.deps.loadState();
    if (loaded === undefined)
      throw new Error('canonical task state is unavailable before dispatch');
    if (loaded.projectId !== state.projectId || loaded.taskId !== state.taskId) {
      throw new Error('canonical task state identity changed before dispatch');
    }
    return loaded;
  }

  private assertReadySubtask(state: AppState, subtaskId: string): void {
    const subtask = state.subtasks.find((entry) => entry.id === subtaskId);
    if (subtask === undefined) throw new Error(`subtask "${subtaskId}" does not exist`);
    if (subtask.status === 'blocked' || subtask.status === 'done') {
      throw new Error(`subtask "${subtaskId}" is not executable from status "${subtask.status}"`);
    }
    const done = new Set(
      state.subtasks.filter((entry) => entry.status === 'done').map((entry) => entry.id),
    );
    const missing = subtask.dependsOn.filter((dependency) => !done.has(dependency));
    if (missing.length > 0) {
      throw new Error(`subtask "${subtaskId}" has unmet dependencies: ${missing.join(', ')}`);
    }
  }

  private assertAssignmentMatches(worker: WorkerState, assignment: Assignment): void {
    if (worker.role !== assignment.role || worker.subtaskId !== assignment.subtaskId) {
      throw new Error(`worker "${assignment.workerId}" assignment conflicts with persisted state`);
    }
    if (worker.executor !== 'harness') {
      throw new Error(
        `worker "${assignment.workerId}" executor conflicts with Phase 9 thin runtime`,
      );
    }
  }

  private canStartWorker(worker: WorkerState): boolean {
    return (
      worker.status === 'pending' ||
      (worker.status === 'paused' &&
        worker.safePoint !== undefined &&
        this.resumingWorkerSessions.has(worker.workerId))
    );
  }

  private async runAssignment(
    join: CanonicalTaskJoin,
    assign: Assignment,
    parallel: boolean,
  ): Promise<void> {
    const spec = this.specOf(assign.role, await this.currentRoster());
    const beforeWorkspace = await join.latest();
    const resolvedWorktree = await this.deps.resolveWorktree?.(beforeWorkspace, assign);
    const running = await join.commit(async (current) => {
      const worker = current.workers.find((entry) => entry.workerId === assign.workerId);
      if (worker === undefined) throw new Error(`worker "${assign.workerId}" was not registered`);
      this.assertAssignmentMatches(worker, assign);
      if (!this.canStartWorker(worker)) {
        throw new Error(
          `worker "${assign.workerId}" cannot start from canonical status "${worker.status}"`,
        );
      }
      if (assign.subtaskId !== undefined) {
        this.assertReadySubtask(current, assign.subtaskId);
      }
      const resumeSessionId =
        this.resumingWorkerSessions.get(assign.workerId) ??
        this.deps.sessionIdForAssignment?.(assign);
      if (resumeSessionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(resumeSessionId)) {
        throw new Error('assigned sessionId must match [A-Za-z0-9][A-Za-z0-9._:-]*');
      }
      if (resolvedWorktree !== undefined) {
        assertAssignmentWorktree(current, assign, resolvedWorktree);
      }
      return this.transitionStep(current, assign.role, [
        mergeByIdMutation('workers', assign.workerId, {
          status: 'running',
          ...(resolvedWorktree === undefined ? {} : { worktree: resolvedWorktree }),
          ...(resumeSessionId === undefined ? {} : { sessionId: resumeSessionId }),
        }),
        ...(resolvedWorktree === undefined || assign.subtaskId === undefined
          ? []
          : [mergeByIdMutation('subtasks', assign.subtaskId, { worktree: resolvedWorktree })]),
      ]);
    });
    const worker = running.workers.find((entry) => entry.workerId === assign.workerId);
    if (worker === undefined)
      throw new Error(`worker "${assign.workerId}" disappeared after start`);
    const executor = this.deps.buildExecutor(spec, assign, resolvedWorktree);
    const handle: WorkerHandle = {
      id: assign.workerId,
      role: assign.role,
      ...(assign.subtaskId === undefined ? {} : { subtaskId: assign.subtaskId }),
      sessionId: worker.sessionId ?? `session:${assign.workerId}`,
      executor,
      join,
      done: false,
      drainRequested: false,
      ...(resolvedWorktree === undefined ? {} : { worktree: resolvedWorktree }),
    };
    this.active.set(handle.id, handle);
    try {
      await this.loop(join, handle, parallel);
    } catch (error) {
      handle.rejectDrain?.(error);
      throw error;
    } finally {
      this.active.delete(handle.id);
    }
  }

  private specOf(role: string, roster: readonly RoleSpec[]): RoleSpec {
    const spec = roster.find((entry) => entry.role === role);
    if (spec === undefined) throw new UnknownRoleError(role);
    return spec;
  }

  private async loop(
    join: CanonicalTaskJoin,
    handle: WorkerHandle,
    parallel: boolean,
  ): Promise<void> {
    while (!handle.done) {
      if (handle.pause !== undefined) {
        if (await this.pauseAtEpoch(join, handle)) continue;
        return;
      }
      if (handle.drainRequested) {
        await this.pauseForDrain(join, handle);
        return;
      }
      let current = await join.latest();
      this.assertCanonicalHandle(current, handle);
      const roster = await this.currentRoster();
      if (!roster.some((entry) => entry.role === handle.role)) {
        await this.pauseForDrain(join, handle);
        return;
      }
      const channelContext =
        this.deps.buildChannelContext === undefined
          ? []
          : await this.deps.buildChannelContext(current, handle.role);
      if (
        handle.pause !== undefined ||
        handle.drainRequested ||
        !(await this.currentRoster()).some((entry) => entry.role === handle.role)
      ) {
        if (handle.pause !== undefined) {
          if (await this.pauseAtEpoch(join, handle)) continue;
          return;
        }
        await this.pauseForDrain(join, handle);
        return;
      }
      current = await join.latest();
      this.assertCanonicalHandle(current, handle);
      const result = await handle.executor.step({
        sessionId: handle.sessionId,
        view: project(current, handle.role, roster, channelContext),
      });
      const completedWorktree =
        result.kind === 'done' &&
        handle.worktree !== undefined &&
        this.deps.refreshWorktree !== undefined
          ? await this.deps.refreshWorktree(handle.worktree)
          : undefined;
      await join.commit(async (canonical) => {
        this.assertCanonicalHandle(canonical, handle);
        const roleStillEnabled = (await this.currentRoster()).some(
          (entry) => entry.role === handle.role,
        );
        if (parallel) validateParallelOutput(handle, result);
        if (this.deps.handleOutput !== undefined && !handle.drainRequested && roleStillEnabled) {
          await this.deps.handleOutput(canonical, handle.role, result.output);
        }
        const planned = await (this.deps.planOutput ?? planObjectionMutations)(
          canonical,
          handle.role,
          result,
        );
        const mutations = [...result.mutations, ...planned];
        if (parallel) validateParallelMutations(canonical, handle, mutations);
        return this.transitionStep(canonical, handle.role, [
          ...mutations,
          ...(result.kind === 'done'
            ? [
                mergeByIdMutation('workers', handle.id, {
                  status: 'done',
                  ...(completedWorktree === undefined ? {} : { worktree: completedWorktree }),
                }),
                ...(completedWorktree === undefined || handle.subtaskId === undefined
                  ? []
                  : [
                      mergeByIdMutation('subtasks', handle.subtaskId, {
                        worktree: completedWorktree,
                      }),
                    ]),
              ]
            : []),
        ]);
      });
      if (completedWorktree !== undefined) handle.worktree = completedWorktree;
      if (handle.drainRequested) {
        if (result.kind === 'done') {
          const safePointRef = await handle.executor.saveSafePoint();
          handle.resolveDrain?.(safePointRef);
          handle.done = true;
          return;
        }
        await this.pauseForDrain(join, handle);
        return;
      }
      if (handle.pause !== undefined) {
        if (result.kind === 'done') handle.done = true;
        if (await this.pauseAtEpoch(join, handle)) continue;
        return;
      }
      if (result.kind === 'done') handle.done = true;
    }
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

  private async pauseForDrain(join: CanonicalTaskJoin, handle: WorkerHandle): Promise<string> {
    const safePointRef = await handle.executor.saveSafePoint();
    await join.commit((current) =>
      this.transitionStep(current, handle.role, [
        mergeByIdMutation('workers', handle.id, {
          status: 'paused',
          safePoint: safePointRef,
        }),
      ]),
    );
    handle.resolveDrain?.(safePointRef);
    return safePointRef;
  }

  private async pauseAtEpoch(join: CanonicalTaskJoin, handle: WorkerHandle): Promise<boolean> {
    const control = handle.pause;
    if (control === undefined) return true;
    try {
      const safePointRef = await handle.executor.saveSafePoint();
      let status: WorkerPauseReceipt['status'] = 'paused';
      await join.commit(async (current) => {
        const worker = current.workers.find((entry) => entry.workerId === handle.id);
        if (worker === undefined) throw new Error(`worker "${handle.id}" disappeared at pause`);
        status = worker.status === 'done' || worker.status === 'failed' ? worker.status : 'paused';
        return this.transitionStep(current, handle.role, [
          mergeByIdMutation('workers', handle.id, { status, safePoint: safePointRef }),
        ]);
      });
      control.resolveReceipt({ workerId: handle.id, status, safePointRef });
      if (status !== 'paused') return false;
      const outcome = await control.outcome;
      delete handle.pause;
      return outcome !== 'suspend';
    } catch (error) {
      control.rejectReceipt(error);
      throw error;
    }
  }

  private async cancelQueued(
    scope: { projectId: string; taskId: string },
    actionId: string,
    mode: PauseMode,
  ): Promise<void> {
    const existing = this.taskPause;
    if (existing !== undefined) {
      if (existing.actionId === actionId && existing.mode === mode) return;
      throw new Error(`worker runtime already has pause epoch "${existing.actionId}"`);
    }
    for (const handle of this.active.values()) {
      if (handle.join.projectId !== scope.projectId || handle.join.taskId !== scope.taskId) {
        throw new Error('pause scope does not match the active WorkerRuntime task');
      }
    }
    let resolvePause = (_outcome: 'reproject' | 'suspend' | 'abort'): void => {};
    const closed = new Promise<'reproject' | 'suspend' | 'abort'>((resolve) => {
      resolvePause = resolve;
    });
    this.taskPause = { actionId, mode, closed, resolve: resolvePause };
    for (const controller of this.queuedAcquires.values()) {
      controller.abort(new Error(`task pause epoch "${actionId}" cancelled queued acquire`));
    }
  }

  private requestWorkerPause(
    scope: { projectId: string; taskId: string },
    workerId: string,
    actionId: string,
    mode: PauseMode,
  ): Promise<WorkerPauseReceipt> {
    const handle = this.active.get(workerId);
    if (
      handle === undefined ||
      handle.join.projectId !== scope.projectId ||
      handle.join.taskId !== scope.taskId
    ) {
      return Promise.reject(new Error(`pause cohort worker "${workerId}" is no longer active`));
    }
    if (handle.pause !== undefined) {
      return handle.pause.actionId === actionId && handle.pause.mode === mode
        ? handle.pause.receipt
        : Promise.reject(new Error(`worker "${workerId}" has a conflicting pause request`));
    }
    let resolveReceipt = (_receipt: WorkerPauseReceipt): void => {};
    let rejectReceipt = (_error: unknown): void => {};
    const receipt = new Promise<WorkerPauseReceipt>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    let resolveOutcome = (_outcome: 'reproject' | 'suspend' | 'abort'): void => {};
    const outcome = new Promise<'reproject' | 'suspend' | 'abort'>((resolve) => {
      resolveOutcome = resolve;
    });
    handle.pause = {
      actionId,
      mode,
      receipt,
      resolveReceipt,
      rejectReceipt,
      outcome,
      resolveOutcome,
    };
    return receipt;
  }

  private async resumeReprojected(
    scope: { projectId: string; taskId: string },
    workerIds: readonly string[],
    actionId: string,
  ): Promise<void> {
    const taskPause = this.requiredTaskPause(scope, actionId, 'reproject');
    const handles = workerIds.map((workerId) => this.requiredPausedHandle(workerId, actionId));
    for (const handle of handles) {
      const state = await handle.join.latest();
      const roster = await this.currentRoster();
      const channelContext =
        this.deps.buildChannelContext === undefined
          ? []
          : await this.deps.buildChannelContext(state, handle.role);
      handle.executor.injectInbox(project(state, handle.role, roster, channelContext));
    }
    if (handles.length > 0) {
      const join = handles[0]?.join;
      if (join === undefined) throw new Error('paused worker join is unavailable');
      await join.commit((state) =>
        this.transitionStep(
          state,
          'COORDINATOR',
          handles.map((handle) => mergeByIdMutation('workers', handle.id, { status: 'running' })),
        ),
      );
    }
    for (const handle of handles) handle.pause?.resolveOutcome('reproject');
    taskPause.resolve('reproject');
    if (this.taskPause === taskPause) this.taskPause = undefined;
  }

  private async suspendPaused(
    scope: { projectId: string; taskId: string },
    workerIds: readonly string[],
    actionId: string,
  ): Promise<void> {
    const taskPause = this.requiredTaskPause(scope, actionId, 'human_gate');
    const handles = workerIds.map((workerId) => this.requiredPausedHandle(workerId, actionId));
    const releases = handles.map((handle) => {
      const release = this.leaseReleases.get(handle.id);
      if (release === undefined) throw new Error(`worker "${handle.id}" has no active lease`);
      return release.promise;
    });
    this.suspended = true;
    for (const handle of handles) handle.pause?.resolveOutcome('suspend');
    taskPause.resolve('suspend');
    if (this.taskPause === taskPause) this.taskPause = undefined;
    await Promise.all(releases);
  }

  private async abortPaused(
    scope: { projectId: string; taskId: string },
    workerIds: readonly string[],
    actionId: string,
  ): Promise<void> {
    const taskPause = this.requiredTaskPause(scope, actionId);
    const handles: WorkerHandle[] = [];
    for (const workerId of workerIds) {
      const handle = this.active.get(workerId);
      if (handle === undefined) continue;
      if (handle.pause?.actionId !== actionId) {
        throw new Error(`worker "${workerId}" is not paused by action "${actionId}"`);
      }
      handles.push(handle);
    }
    if (handles.length > 0) {
      const join = handles[0]?.join;
      if (join === undefined) throw new Error('paused worker join is unavailable');
      await join.commit((state) =>
        this.transitionStep(
          state,
          'COORDINATOR',
          handles.map((handle) => mergeByIdMutation('workers', handle.id, { status: 'running' })),
        ),
      );
    }
    for (const handle of handles) handle.pause?.resolveOutcome('abort');
    taskPause.resolve('abort');
    if (this.taskPause === taskPause) this.taskPause = undefined;
  }

  private requiredTaskPause(
    scope: { projectId: string; taskId: string },
    actionId: string,
    mode?: PauseMode,
  ): TaskPauseControl {
    const pause = this.taskPause;
    if (
      pause === undefined ||
      pause.actionId !== actionId ||
      (mode !== undefined && pause.mode !== mode)
    ) {
      throw new Error(`pause action "${actionId}" is not active for this WorkerRuntime`);
    }
    for (const handle of this.active.values()) {
      if (handle.join.projectId !== scope.projectId || handle.join.taskId !== scope.taskId) {
        throw new Error('pause scope does not match the active WorkerRuntime task');
      }
    }
    return pause;
  }

  private requiredPausedHandle(workerId: string, actionId: string): WorkerHandle {
    const handle = this.active.get(workerId);
    if (handle?.pause?.actionId !== actionId) {
      throw new Error(`worker "${workerId}" is not paused by action "${actionId}"`);
    }
    return handle;
  }

  private async acquireLease(
    projectId: string,
    taskId: string,
    workerId: string,
  ): Promise<SlotLease | undefined> {
    while (true) {
      const pause = this.taskPause;
      if (pause !== undefined) {
        const outcome = await pause.closed;
        if (outcome === 'suspend') return undefined;
        continue;
      }
      const controller = new AbortController();
      this.queuedAcquires.set(workerId, controller);
      try {
        return await this.scheduler.acquire(projectId, taskId, workerId, controller.signal);
      } catch (error) {
        const interrupted = this.taskPause;
        if (!isAbortError(error) || interrupted === undefined) throw error;
        const outcome = await interrupted.closed;
        if (outcome === 'suspend') return undefined;
      } finally {
        if (this.queuedAcquires.get(workerId) === controller) {
          this.queuedAcquires.delete(workerId);
        }
      }
    }
  }

  private beginLeaseRelease(workerId: string): void {
    let resolveRelease = (): void => {};
    let rejectRelease = (_error: unknown): void => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolveRelease = resolve;
      rejectRelease = reject;
    });
    this.leaseReleases.set(workerId, {
      promise,
      resolve: resolveRelease,
      reject: rejectRelease,
    });
  }

  private async releaseLease(workerId: string, lease: SlotLease): Promise<void> {
    const release = this.leaseReleases.get(workerId);
    try {
      await this.scheduler.release(lease);
      release?.resolve();
    } catch (error) {
      release?.reject(error);
      throw error;
    } finally {
      if (this.leaseReleases.get(workerId) === release) this.leaseReleases.delete(workerId);
    }
  }

  private async markFailed(join: CanonicalTaskJoin, workerId: string): Promise<void> {
    await join.commit(async (state) => {
      const worker = state.workers.find((entry) => entry.workerId === workerId);
      if (worker === undefined || worker.status === 'done' || worker.status === 'failed')
        return state;
      return this.transition(state, [mergeByIdMutation('workers', workerId, { status: 'failed' })]);
    });
  }

  private assertCanonicalHandle(state: AppState, handle: WorkerHandle): void {
    const worker = state.workers.find((entry) => entry.workerId === handle.id);
    if (
      worker === undefined ||
      worker.status !== 'running' ||
      worker.role !== handle.role ||
      worker.subtaskId !== handle.subtaskId
    ) {
      throw new Error(`worker "${handle.id}" is no longer a valid running assignment`);
    }
    if (handle.subtaskId !== undefined) {
      this.assertReadySubtask(state, handle.subtaskId);
    }
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

function assertAssignmentWorktree(
  state: AppState,
  assignment: Assignment,
  worktree: WorktreeRef,
): void {
  const worker = state.workers.find((entry) => entry.workerId === assignment.workerId);
  if (worker === undefined) throw new Error(`worker "${assignment.workerId}" is missing`);
  for (const persisted of [
    worker.worktree,
    assignment.subtaskId === undefined
      ? undefined
      : state.subtasks.find((entry) => entry.id === assignment.subtaskId)?.worktree,
  ]) {
    if (persisted === undefined || typeof persisted === 'string') continue;
    if (JSON.stringify(persisted) !== JSON.stringify(worktree)) {
      throw new Error(`worker "${assignment.workerId}" worktree conflicts with persisted state`);
    }
  }
}

function validateParallelOutput(handle: WorkerHandle, result: StepResult): void {
  if (Object.hasOwn(result.output, 'channelAction')) {
    throw new Error(`parallel worker "${handle.id}" cannot mutate project collaboration state`);
  }
}

function validateParallelMutations(
  state: AppState,
  handle: WorkerHandle,
  mutations: readonly Mutation[],
): void {
  const appended = new Map<string, unknown>();
  for (const mutation of mutations) {
    if (mutation.op === 'set') {
      throw new Error(`parallel worker "${handle.id}" cannot submit set(${mutation.field})`);
    }
    if (mutation.op === 'mergeById') {
      throw new Error(
        `parallel worker "${handle.id}" cannot merge ${mutation.field}/${mutation.value.id}`,
      );
    }
    const value = mutation.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`parallel append(${mutation.field}) requires a stable identity object`);
    }
    const record = value as Record<string, unknown>;
    const identity = record.msgId ?? record.id;
    if (typeof identity !== 'string' || identity.length === 0) {
      throw new Error(`parallel append(${mutation.field}) requires msgId or id`);
    }
    const appendKey = `${mutation.field}\u0000${identity}`;
    const previous =
      appended.get(appendKey) ??
      appendValues(state, mutation.field).find((entry) => appendIdentity(entry) === identity);
    if (previous !== undefined && !deepEqual(previous, value)) {
      throw new Error(
        `parallel append(${mutation.field}) identity "${identity}" conflicts with canonical state`,
      );
    }
    appended.set(appendKey, value);
    if (mutation.field === 'messages' || mutation.field === 'objections') {
      if (record.fromRole !== handle.role) {
        throw new Error(`parallel append(${mutation.field}) must be owned by ${handle.role}`);
      }
      continue;
    }
    if (mutation.field === 'reviewComments' && handle.role === 'REVIEWER') continue;
    throw new Error(`parallel worker "${handle.id}" cannot append ${mutation.field}`);
  }
}

function appendValues(state: AppState, field: string): readonly unknown[] {
  switch (field) {
    case 'messages':
      return state.messages;
    case 'decisionLedger':
      return state.decisionLedger;
    case 'objections':
      return state.objections;
    case 'handoffPackets':
      return state.handoffPackets;
    case 'reviewComments':
      return state.reviewComments;
    default:
      return [];
  }
}

function appendIdentity(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity = record.msgId ?? record.id;
  return typeof identity === 'string' ? identity : undefined;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== 'object' ||
    left === null ||
    Array.isArray(left) ||
    typeof right !== 'object' ||
    right === null ||
    Array.isArray(right)
  ) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function assertWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(workerId)) {
    throw new Error('workerId must match [A-Za-z0-9][A-Za-z0-9._:-]*');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
