import type { AppState, Mutation, RoleSpec, WorkerState } from '@agora/core-domain';
import { applyMutations, mergeByIdMutation } from '@agora/core-domain';
import { type Executor, project, type StepResult } from '@agora/runtime-executor';
import type { Assignment } from './coordinator';
import { GlobalScheduler, type SlotLease } from './global-scheduler';
import { planObjectionMutations } from './objection';

export interface WorkerRuntimeDeps {
  roster: readonly RoleSpec[];
  loadRoster?: () => Promise<readonly RoleSpec[]>;
  loadState?: () => Promise<AppState | undefined>;
  buildExecutor(spec: RoleSpec, assign: Assignment): Executor;
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
  paused = false;

  private readonly active = new Map<string, WorkerHandle>();
  private readonly maxParallel: number;

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
  }

  get roster(): readonly RoleSpec[] {
    return this.deps.roster;
  }

  async runOne(state: AppState, assign: Assignment): Promise<AppState> {
    const prepared = await this.prepareAssignments(await this.loadStartState(state), [assign]);
    const join = new CanonicalTaskJoin(prepared, this.deps.loadState);
    const lease = await this.scheduler.acquire(prepared.projectId, assign.workerId);
    try {
      await this.runAssignment(join, assign, false);
    } catch (error) {
      await this.markFailed(join, assign.workerId).catch(() => undefined);
      throw error;
    } finally {
      await this.scheduler.release(lease);
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
    for (const assignment of queue) join.recordNotStarted(assignment.workerId);
    const canonical = await join.drainAndLoad();
    const failures = [...join.failures].sort((left, right) =>
      left.workerId.localeCompare(right.workerId),
    );
    if (failures.length > 0) throw new ParallelBatchError(canonical, failures);
    return canonical;
  }

  private async pump(queue: Assignment[], join: CanonicalTaskJoin): Promise<void> {
    while (queue.length > 0 && !join.hasFailure) {
      const assign = queue.shift();
      if (assign === undefined) return;
      let lease: SlotLease | undefined;
      try {
        lease = await this.scheduler.acquire(join.projectId, assign.workerId);
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
            await this.scheduler.release(lease);
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
        if (existing.status !== 'pending') {
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
  }

  private async runAssignment(
    join: CanonicalTaskJoin,
    assign: Assignment,
    parallel: boolean,
  ): Promise<void> {
    const spec = this.specOf(assign.role, await this.currentRoster());
    const executor = this.deps.buildExecutor(spec, assign);
    const state = await join.latest();
    const worker = state.workers.find((entry) => entry.workerId === assign.workerId);
    if (worker === undefined) throw new Error(`worker "${assign.workerId}" was not registered`);
    const handle: WorkerHandle = {
      id: assign.workerId,
      role: assign.role,
      ...(assign.subtaskId === undefined ? {} : { subtaskId: assign.subtaskId }),
      sessionId: worker.sessionId ?? `session:${assign.workerId}`,
      executor,
      done: false,
      drainRequested: false,
    };
    this.active.set(handle.id, handle);
    try {
      await join.commit((current) =>
        this.transitionStep(current, handle.role, [
          mergeByIdMutation('workers', handle.id, { status: 'running' }),
        ]),
      );
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
      if (this.paused || handle.drainRequested) {
        await this.pauseAtSafePoint(join, handle);
        return;
      }
      const current = await join.latest();
      const roster = await this.currentRoster();
      if (!roster.some((entry) => entry.role === handle.role)) {
        await this.pauseAtSafePoint(join, handle);
        return;
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
        await this.pauseAtSafePoint(join, handle);
        return;
      }
      const result = await handle.executor.step({
        sessionId: handle.sessionId,
        view: project(current, handle.role, roster, channelContext),
      });
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
            ? [mergeByIdMutation('workers', handle.id, { status: 'done' })]
            : []),
        ]);
      });
      if (handle.drainRequested) {
        await this.pauseAtSafePoint(join, handle);
        handle.done = result.kind === 'done';
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

  private async pauseAtSafePoint(join: CanonicalTaskJoin, handle: WorkerHandle): Promise<string> {
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
    if (handle.subtaskId !== undefined) this.assertReadySubtask(state, handle.subtaskId);
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
      if (mutation.field === 'workers' && mutation.value.id === handle.id) continue;
      if (mutation.field === 'subtasks' && mutation.value.id === handle.subtaskId) {
        const keys = Object.keys(mutation.value).filter((key) => key !== 'id');
        if (keys.length === 0) continue;
      }
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
