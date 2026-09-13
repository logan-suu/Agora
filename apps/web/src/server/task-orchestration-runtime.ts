import {
  type AppState,
  type HumanGateRequest,
  type Mutation,
  mergeByIdMutation,
  type RequirementProposalView,
  type RoleSpec,
  requirementProposalView,
  setMutation,
  validationReceipt,
} from '@agora/core-domain';
import {
  type HumanGateResolutionReceipt,
  type IntegrateWaveResult,
  materializeHumanGate,
  runOrchestration,
  type StateTransition,
  type StepOutputHandler,
  type WorkerRuntime,
  type WorkerStepTransition,
} from '@agora/core-orchestration';
import type { PauseReceipt, PauseRequest } from '@agora/core-preemption';
import type { TaskScope } from '@agora/runtime-state';
import { localBootstrap } from './local-startup';
import type { MessageRuntime } from './message-runtime';
import { safeRunError } from './run-error';

export type TaskRunStatus = 'running' | 'completed' | 'needs_attention' | 'failed' | 'interrupted';

export type TaskStartOutcome =
  | 'started'
  | 'already_running'
  | 'completed'
  | 'needs_attention'
  | 'failed'
  | 'interrupted';

export interface TaskStartInput extends TaskScope {
  requestId: string;
  goal: string;
}

export interface TaskSummary extends TaskScope {
  goal: string;
  runStatus: TaskRunStatus;
  phase: AppState['phase'];
  currentRole: string | null;
  testResults: AppState['testResults'] | null;
  artifactPath: string | null;
  messageCount: number;
  requirementProposal?: RequirementProposalView;
  error?: string;
}

export interface TaskStartResult extends TaskSummary {
  requestId: string;
  startOutcome: TaskStartOutcome;
}

export interface TaskComposition {
  initialState: AppState;
  workerRuntime: WorkerRuntime;
  roster: readonly RoleSpec[];
  loadRoster?: () => Promise<readonly RoleSpec[]>;
  artifactPath: string;
  integrate?: (state: AppState) => Promise<IntegrateWaveResult>;
  parallelContext?: (
    state: AppState,
  ) => Promise<{ initialBase: { branch: string; commit: string }; controlFingerprint: string }>;
  saveSafePoints(): Promise<readonly string[]>;
  suspend(): Promise<void>;
  archiveArtifact(): Promise<ArchivedArtifact>;
  dispose(): Promise<void>;
}

export interface ArchivedArtifact {
  path: string;
  worktrees: readonly { sourcePath: string; archivedPath: string }[];
}

export type TaskCompositionFactory = (input: {
  scope: TaskScope;
  goal: string;
  loadState: () => Promise<AppState | undefined>;
  transition: StateTransition;
  transitionStep?: WorkerStepTransition;
  handleOutput: StepOutputHandler;
  buildChannelContext: (state: AppState, role: string) => Promise<readonly unknown[]>;
  loadRoster?: () => Promise<readonly RoleSpec[]>;
  resume?: {
    state: AppState;
    actionId: string;
    receipt: HumanGateResolutionReceipt;
  };
}) => Promise<TaskComposition>;

export interface TaskOrchestrationRuntimeOptions {
  maxActiveCompositions?: number;
}

interface ActiveRun {
  goal: string;
  status: Exclude<TaskRunStatus, 'interrupted'>;
  composition: TaskComposition | undefined;
  promise: Promise<void>;
  artifactPath: string | undefined;
  pendingFinalization:
    | { status: 'completed' | 'failed'; error: string | undefined; artifactArchived: boolean }
    | undefined;
  pendingSuspension?: { error: string | undefined };
  error: string | undefined;
  /** Bounded in-process diagnostics, excluded from public summaries and persistence. */
  diagnostics?: Partial<Record<'execution' | 'suspension' | 'archive' | 'disposal', unknown>>;
}

export class TaskGoalConflictError extends Error {
  constructor(scope: TaskScope, existingGoal: string) {
    super(
      `task ${scope.projectId}/${scope.taskId} already exists with a different goal: ${existingGoal}`,
    );
    this.name = 'TaskGoalConflictError';
  }
}

export class TaskCompositionCapacityError extends Error {
  constructor(readonly maxActiveCompositions: number) {
    super(`task composition capacity ${maxActiveCompositions} is exhausted; retry later`);
    this.name = 'TaskCompositionCapacityError';
  }
}

export class LocalStoppingError extends Error {
  constructor() {
    super('Agora is stopping. Wait for shutdown, then restart to begin new work.');
  }
}

/** Single-instance task lifecycle registry; D17 concurrency is owned by the shared scheduler. */
export class TaskOrchestrationRuntime {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #maxActiveCompositions: number;
  #lifecycleQueue: Promise<void> = Promise.resolve();
  #draining = false;

  constructor(
    readonly messages: MessageRuntime,
    readonly createComposition: TaskCompositionFactory,
    options: TaskOrchestrationRuntimeOptions = {},
  ) {
    const maxActiveCompositions = options.maxActiveCompositions ?? 3;
    if (!Number.isInteger(maxActiveCompositions) || maxActiveCompositions <= 0) {
      throw new Error('maxActiveCompositions must be a positive integer');
    }
    this.#maxActiveCompositions = maxActiveCompositions;
    localBootstrap()?.drains.add(() => this.drain());
    messages.bindRoleDrainPort({
      awaitSafePoint: (scope, role) => this.#awaitRoleSafePoint(scope, role),
    });
    messages.bindHumanGateLifecyclePort({
      suspend: (scope, request) => this.#suspendAtHumanGate(scope, request),
      resume: (scope, actionId, receipt) => this.#resumeHumanGate(scope, actionId, receipt),
    });
    messages.bindLeaderPreemptionPort({
      pause: (request) => this.#pauseLeaderDirective(request),
      complete: (receipt) => this.#completeLeaderDirective(receipt),
      abort: (receipt) => this.#abortLeaderDirective(receipt),
    });
  }

  async start(input: TaskStartInput): Promise<TaskStartResult> {
    return this.#enqueueLifecycle(async () => {
      this.#assertAcceptingWork();
      const existingRun = this.#runs.get(scopeKey(input));
      if (existingRun !== undefined) {
        if (existingRun.goal !== input.goal) {
          throw new TaskGoalConflictError(input, existingRun.goal);
        }
        if (existingRun.pendingSuspension !== undefined) {
          if (existingRun.status === 'running') {
            const summary = await this.#requiredSummary(input);
            return { ...summary, requestId: input.requestId, startOutcome: 'already_running' };
          }
          existingRun.status = 'running';
          existingRun.promise = this.#suspendFailedParallelRun(
            existingRun,
            existingRun.pendingSuspension.error,
          );
          const summary = await this.#requiredSummary(input);
          return { ...summary, requestId: input.requestId, startOutcome: 'started' };
        }
        if (existingRun.pendingFinalization !== undefined) {
          if (existingRun.composition === undefined) {
            existingRun.status = 'needs_attention';
            const summary = await this.#requiredSummary(input);
            return { ...summary, requestId: input.requestId, startOutcome: 'needs_attention' };
          }
          const pending = existingRun.pendingFinalization;
          existingRun.status = 'running';
          existingRun.error = undefined;
          existingRun.promise = this.#finalizeRun(
            input,
            existingRun,
            pending.status,
            pending.error,
            pending.artifactArchived,
          );
          const summary = await this.#requiredSummary(input);
          return { ...summary, requestId: input.requestId, startOutcome: 'started' };
        }
        const summary = await this.#requiredSummary(input);
        return {
          ...summary,
          requestId: input.requestId,
          startOutcome: existingRun.status === 'running' ? 'already_running' : existingRun.status,
        };
      }

      const persisted = await this.messages.store.load(input);
      if (persisted !== undefined) {
        if (persisted.goal !== input.goal) {
          throw new TaskGoalConflictError(input, persisted.goal);
        }
        await this.messages.ensureProjectChannels(input.projectId);
        const reconciled = await this.messages.reconcileChannels(input);
        if (reconciled === undefined) {
          throw new Error('task state disappeared after channel reconciliation');
        }
        const startOutcome: 'completed' | 'needs_attention' | 'interrupted' =
          reconciled.phase === 'done'
            ? 'completed'
            : !requiresHumanGateAttention(reconciled)
              ? 'interrupted'
              : 'needs_attention';
        const summary = summaryFrom(reconciled, startOutcome);
        return {
          ...summary,
          requestId: input.requestId,
          startOutcome,
        };
      }

      this.#assertCompositionCapacity();
      const transition: StateTransition = async (_state, mutations) =>
        (await this.messages.commitMutations(input, mutations)).state;
      const composition = await this.createComposition({
        scope: input,
        goal: input.goal,
        loadState: () => this.messages.store.load(input),
        transition,
        transitionStep: (_state, role, mutations) =>
          this.messages
            .commitWorkerStepMutations(input, role, mutations)
            .then((commit) => commit.state),
        handleOutput: (state, role, output) =>
          this.messages.handleWorkerOutput(state, role, output),
        buildChannelContext: (state, role) =>
          this.messages.workerStepChannelContextFor(state, role),
        loadRoster: () => this.messages.enabledRoleSpecs(input.projectId),
      });
      let initialState: AppState;
      try {
        initialState = await this.messages.initializeState(input, composition.initialState);
      } catch (error) {
        await composition.dispose().catch(() => undefined);
        throw error;
      }
      const run: ActiveRun = {
        goal: input.goal,
        status: 'running',
        composition,
        promise: Promise.resolve(),
        artifactPath: undefined,
        pendingFinalization: undefined,
        error: undefined,
      };
      this.#runs.set(scopeKey(input), run);
      run.promise = this.#executeRun(input, run, initialState, transition);

      const summary = await this.#requiredSummary(input);
      return {
        ...summary,
        requestId: input.requestId,
        startOutcome: 'started',
      };
    });
  }

  async summary(scope: TaskScope): Promise<TaskSummary | undefined> {
    const state = await this.messages.store.load(scope);
    if (state === undefined) return undefined;
    const run = this.#runs.get(scopeKey(scope));
    if (run === undefined) {
      return summaryFrom(
        state,
        state.phase === 'done'
          ? 'completed'
          : !requiresHumanGateAttention(state)
            ? 'interrupted'
            : 'needs_attention',
      );
    }
    return summaryFrom(state, run.status, run.error, run.artifactPath);
  }

  async waitForIdle(scope: TaskScope): Promise<void> {
    await this.#runs.get(scopeKey(scope))?.promise;
  }

  async drain(): Promise<void> {
    this.#draining = true;
    await this.#lifecycleQueue;
    await this.messages.waitForLeaderInputs();
    const results = await Promise.allSettled([...this.#runs.values()].map((run) => run.promise));
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    for (const [key, run] of this.#runs) {
      if (run.pendingFinalization) {
        try {
          const separator = key.indexOf('\u0000');
          const pending = run.pendingFinalization;
          await this.#finalizeRun(
            { projectId: key.slice(0, separator), taskId: key.slice(separator + 1) },
            run,
            pending.status,
            pending.error,
            pending.artifactArchived,
          );
          if (run.pendingFinalization) throw new Error('Task finalization still needs attention');
        } catch (error) {
          errors.push(error);
        }
        continue;
      }
      if (run.composition) {
        try {
          await run.composition.suspend();
          run.composition = undefined;
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Agora could not safely stop all resources. Retry stop.');
  }

  #assertAcceptingWork() {
    if (this.#draining || localBootstrap()?.draining) throw new LocalStoppingError();
  }

  async disposeAll(): Promise<void> {
    const runs = [...this.#runs.values()];
    await Promise.all(runs.map((run) => run.promise));
    this.#runs.clear();
  }

  async #awaitRoleSafePoint(scope: TaskScope, role: string) {
    const composition = this.#runs.get(scopeKey(scope))?.composition;
    if (composition === undefined) {
      return { role, activeWorkers: 0, safePointRefs: [] };
    }
    return composition.workerRuntime.awaitRoleSafePoint(role);
  }

  async #suspendAtHumanGate(scope: TaskScope, request: HumanGateRequest): Promise<AppState> {
    const run = this.#runs.get(scopeKey(scope));
    const composition = run?.composition;
    const receipt =
      composition === undefined
        ? emptyPauseReceipt(scope, request.triggerMsgId, request.reason, 'human_gate')
        : await composition.workerRuntime.requestPause({
            scope,
            actionId: request.triggerMsgId,
            reason: request.reason,
            mode: 'human_gate',
          });
    const refs = receipt.workers.flatMap((worker) =>
      worker.status === 'paused' && worker.safePointRef !== undefined ? [worker.safePointRef] : [],
    );
    let committed: Awaited<ReturnType<MessageRuntime['commitMutations']>>;
    try {
      committed = await this.messages.commitMutations(scope, [
        setMutation('humanGate', materializeHumanGate(request, refs)),
      ]);
    } catch (error) {
      if (composition !== undefined) {
        await composition.workerRuntime.abortPause(receipt).catch(() => undefined);
      }
      throw error;
    }
    if (composition !== undefined) {
      await composition.workerRuntime.completePause(receipt);
      await composition.suspend();
      if (run?.composition === composition) run.composition = undefined;
    }
    return committed.state;
  }

  async #pauseLeaderDirective(request: PauseRequest): Promise<PauseReceipt> {
    const composition = this.#runs.get(scopeKey(request.scope))?.composition;
    return composition === undefined
      ? emptyPauseReceipt(request.scope, request.actionId, request.reason, request.mode)
      : composition.workerRuntime.requestPause(request);
  }

  async #completeLeaderDirective(receipt: PauseReceipt): Promise<void> {
    const composition = this.#runs.get(scopeKey(receipt.scope))?.composition;
    if (composition === undefined) {
      if (!receipt.workers.some((worker) => worker.status === 'paused')) return;
      throw new Error(`pause action "${receipt.actionId}" lost its active task composition`);
    }
    await composition.workerRuntime.completePause(receipt);
  }

  async #abortLeaderDirective(receipt: PauseReceipt): Promise<void> {
    const composition = this.#runs.get(scopeKey(receipt.scope))?.composition;
    if (composition === undefined) {
      if (!receipt.workers.some((worker) => worker.status === 'paused')) return;
      throw new Error(`pause action "${receipt.actionId}" lost its active task composition`);
    }
    await composition.workerRuntime.abortPause(receipt);
  }

  async #resumeHumanGate(
    scope: TaskScope,
    actionId: string,
    receipt: HumanGateResolutionReceipt,
  ): Promise<void> {
    await this.#enqueueLifecycle(async () => {
      this.#assertAcceptingWork();
      let state = await this.messages.store.load(scope);
      if (state === undefined) throw new Error('cannot resume a missing task state');
      let existing = this.#runs.get(scopeKey(scope));
      const markerId = `human-gate-resumed:${actionId}`;
      if (
        existing?.status === 'running' &&
        !state.messages.some((message) => message.msgId === markerId)
      ) {
        await existing.promise;
        state = await this.messages.store.load(scope);
        if (state === undefined) throw new Error('cannot resume a missing task state');
        existing = this.#runs.get(scopeKey(scope));
      }
      if (state.phase === 'done' || existing?.status === 'completed') return;
      if (state.humanGate !== undefined) {
        throw new Error('cannot resume while humanGate remains active');
      }
      if (existing?.status === 'running') return;
      if (existing?.composition !== undefined) {
        const staleComposition = existing.composition;
        await staleComposition.suspend();
        if (existing.composition === staleComposition) existing.composition = undefined;
      }
      this.#assertCompositionCapacity();
      const transition: StateTransition = async (_state, mutations) =>
        (await this.messages.commitMutations(scope, mutations)).state;
      const composition = await this.createComposition({
        scope,
        goal: state.goal,
        loadState: () => this.messages.store.load(scope),
        transition,
        transitionStep: (_state, role, mutations) =>
          this.messages
            .commitWorkerStepMutations(scope, role, mutations)
            .then((commit) => commit.state),
        handleOutput: (current, role, output) =>
          this.messages.handleWorkerOutput(current, role, output),
        buildChannelContext: (current, role) =>
          this.messages.workerStepChannelContextFor(current, role),
        loadRoster: () => this.messages.enabledRoleSpecs(scope.projectId),
        resume: { state, actionId, receipt },
      });
      let resumedState: AppState;
      try {
        const marker = await this.messages.commitMessage(scope, {
          msgId: markerId,
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          payload: {
            kind: 'human_gate_resumed',
            actionId,
            gateId: receipt.gateId,
            resumeSessionId: receipt.resumeSessionId,
            ...(receipt.workerResumes === undefined
              ? {}
              : { workerResumes: receipt.workerResumes }),
          },
          display: `Human gate ${receipt.gateId} resumed.`,
          ts: Date.now(),
        });
        assertResumedMarker(marker.message, actionId, receipt);
        resumedState = marker.state;
      } catch (error) {
        await composition.suspend().catch(() => undefined);
        throw error;
      }
      const run: ActiveRun = {
        goal: state.goal,
        status: 'running',
        composition,
        promise: Promise.resolve(),
        artifactPath: undefined,
        pendingFinalization: undefined,
        error: undefined,
      };
      this.#runs.set(scopeKey(scope), run);
      run.promise = this.#executeRun(scope, run, resumedState, transition);
    });
  }

  async #executeRun(
    scope: TaskScope,
    run: ActiveRun,
    initialState: AppState,
    transition: StateTransition,
  ): Promise<void> {
    const composition = run.composition;
    if (composition === undefined) throw new Error('active task composition is unavailable');
    let terminalStatus: ActiveRun['status'] = 'failed';
    let terminalError: string | undefined;
    let suspendFailedParallel = false;
    try {
      const finalState = await runOrchestration(initialState, {
        workerRuntime: composition.workerRuntime,
        roster: composition.roster,
        ...(composition.loadRoster === undefined ? {} : { loadRoster: composition.loadRoster }),
        transition,
        ...(composition.integrate === undefined ? {} : { integrate: composition.integrate }),
        ...(composition.parallelContext === undefined
          ? {}
          : { parallelContext: composition.parallelContext }),
        suspendAtHumanGate: (_state, request) => this.#suspendAtHumanGate(scope, request),
      });
      terminalStatus = finalState.phase === 'done' ? 'completed' : 'needs_attention';
    } catch (error) {
      run.diagnostics ??= {};
      run.diagnostics.execution = error;
      terminalError = errorMessage(error);
      const persisted = await this.messages.store.load(scope).catch(() => undefined);
      if (
        persisted !== undefined &&
        (requiresHumanGateAttention(persisted) || persisted.parallelExecution !== undefined)
      ) {
        terminalStatus = 'needs_attention';
        suspendFailedParallel = !requiresHumanGateAttention(persisted);
      }
    }

    if (terminalStatus === 'needs_attention') {
      if (suspendFailedParallel) {
        await this.#suspendFailedParallelRun(run, terminalError);
        return;
      }
      run.status = terminalStatus;
      run.error = terminalError;
      return;
    }

    await this.#finalizeRun(scope, run, terminalStatus, terminalError, false);
  }

  /** Release executable resources after a settled failure, preserving unverified source evidence. */
  async #suspendFailedParallelRun(run: ActiveRun, error: string | undefined): Promise<void> {
    run.pendingSuspension = { error };
    const composition = run.composition;
    try {
      await composition?.suspend();
      if (run.composition === composition) run.composition = undefined;
      delete run.pendingSuspension;
      run.error = error;
    } catch (failure) {
      run.diagnostics ??= {};
      run.diagnostics.suspension = failure;
      run.error = joinErrors(error, `resource suspension failed: ${errorMessage(failure)}`);
    }
    run.status = 'needs_attention';
  }

  async #finalizeRun(
    scope: TaskScope,
    run: ActiveRun,
    terminalStatus: 'completed' | 'failed',
    terminalError: string | undefined,
    artifactArchived: boolean,
  ): Promise<void> {
    const composition = run.composition;
    if (composition === undefined) throw new Error('active task composition is unavailable');

    try {
      if (!artifactArchived) {
        const archived = await composition.archiveArtifact();
        const state = await this.messages.store.load(scope);
        if (state === undefined) throw new Error('task state disappeared before artifact archival');
        const archivedBySource = new Map(
          archived.worktrees.map((entry) => [entry.sourcePath, entry.archivedPath]),
        );
        const mutations: Mutation[] = [];
        if (state.integration !== undefined) {
          const integrationPath = archivedBySource.get(state.integration.integrationWorktree.path);
          const pendingBranches = state.integration.pendingBranches.map((entry) => {
            const path = archivedBySource.get(entry.worktree.path);
            return path === undefined ? entry : { ...entry, worktree: { ...entry.worktree, path } };
          });
          if (
            integrationPath !== undefined ||
            pendingBranches.some(
              (entry, index) => entry !== state.integration?.pendingBranches[index],
            )
          ) {
            mutations.push(
              setMutation('integration', {
                ...state.integration,
                integrationWorktree: {
                  ...state.integration.integrationWorktree,
                  path: integrationPath ?? state.integration.integrationWorktree.path,
                },
                pendingBranches,
              }),
            );
          }
        }
        for (const subtask of state.subtasks) {
          const worktree = subtask.worktree;
          const sourcePath = typeof worktree === 'string' ? worktree : worktree?.path;
          const path = sourcePath === undefined ? undefined : archivedBySource.get(sourcePath);
          if (path === undefined || worktree === undefined) continue;
          mutations.push(
            mergeByIdMutation('subtasks', subtask.id, {
              worktree: typeof worktree === 'string' ? path : { ...worktree, path },
            }),
          );
        }
        for (const worker of state.workers) {
          const worktree = worker.worktree;
          const sourcePath = typeof worktree === 'string' ? worktree : worktree?.path;
          const path = sourcePath === undefined ? undefined : archivedBySource.get(sourcePath);
          if (path === undefined || worktree === undefined) continue;
          mutations.push(
            mergeByIdMutation('workers', worker.workerId, {
              worktree: typeof worktree === 'string' ? path : { ...worktree, path },
            }),
          );
        }
        if (mutations.length > 0) await this.messages.commitMutations(scope, mutations);
        run.artifactPath = archived.path;
        artifactArchived = true;
      }
    } catch (error) {
      run.pendingFinalization = { status: terminalStatus, error: terminalError, artifactArchived };
      run.status = 'needs_attention';
      run.diagnostics ??= {};
      run.diagnostics.archive = error;
      run.error = joinErrors(terminalError, `artifact archive failed: ${errorMessage(error)}`);
      return;
    }

    try {
      await composition.dispose();
    } catch (error) {
      run.pendingFinalization = { status: terminalStatus, error: terminalError, artifactArchived };
      run.status = 'needs_attention';
      run.diagnostics ??= {};
      run.diagnostics.disposal = error;
      run.error = joinErrors(terminalError, `resource disposal failed: ${errorMessage(error)}`);
      return;
    }
    run.composition = undefined;
    run.pendingFinalization = undefined;
    run.status = terminalStatus;
    run.error = terminalError;
  }

  async #requiredSummary(scope: TaskScope): Promise<TaskSummary> {
    const summary = await this.summary(scope);
    if (summary === undefined) throw new Error('task state disappeared after initialization');
    return summary;
  }

  #assertCompositionCapacity(): void {
    let active = 0;
    for (const run of this.#runs.values()) {
      if (run.composition !== undefined) active += 1;
    }
    if (active >= this.#maxActiveCompositions) {
      throw new TaskCompositionCapacityError(this.#maxActiveCompositions);
    }
  }

  async #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleQueue;
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#lifecycleQueue = tail;
    return result;
  }
}

function scopeKey(scope: TaskScope): string {
  return `${scope.projectId}\u0000${scope.taskId}`;
}

function emptyPauseReceipt(
  scope: TaskScope,
  actionId: string,
  reason: string,
  mode: PauseRequest['mode'],
): PauseReceipt {
  return { scope: { ...scope }, actionId, reason, mode, cohort: [], workers: [] };
}

function errorMessage(error: unknown): string {
  return safeRunError(error);
}

function joinErrors(current: string | undefined, next: string): string {
  return current === undefined ? next : `${current}; ${next}`;
}

function summaryFrom(
  state: AppState,
  runStatus: TaskRunStatus,
  error?: string,
  archivedArtifactPath?: string,
): TaskSummary {
  const accepted = state.parallelExecution?.acceptedReceiptId;
  const validationWorkerId =
    accepted === undefined ? undefined : validationReceipt(state, accepted).workerId;
  const worktree =
    state.workers.find((worker) => worker.workerId === validationWorkerId)?.worktree ??
    state.integration?.integrationWorktree ??
    state.subtasks.find((subtask) => subtask.worktree !== undefined)?.worktree;
  const artifactPath = typeof worktree === 'string' ? worktree : worktree?.path;
  const requirementProposal = requirementProposalView(state);
  return {
    projectId: state.projectId,
    taskId: state.taskId,
    goal: state.goal,
    runStatus,
    phase: state.phase,
    currentRole: state.nextRole ?? null,
    testResults: state.testResults ?? null,
    artifactPath: archivedArtifactPath ?? artifactPath ?? null,
    messageCount: state.messages.length,
    ...(requirementProposal ? { requirementProposal } : {}),
    ...(error === undefined ? {} : { error }),
  };
}

function requiresHumanGateAttention(state: AppState): boolean {
  if (state.humanGate !== undefined) return true;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message?.fromRole !== 'leader' || message.payload.resolution === undefined) continue;
    return !state.messages.some(
      (candidate) => candidate.msgId === `human-gate-resumed:${message.msgId}`,
    );
  }
  return false;
}

function assertResumedMarker(
  message: AppState['messages'][number],
  actionId: string,
  receipt: HumanGateResolutionReceipt,
): void {
  if (
    message.msgId !== `human-gate-resumed:${actionId}` ||
    message.channelId !== 'main' ||
    message.fromRole !== 'COORDINATOR' ||
    message.type !== 'announce' ||
    message.payload.kind !== 'human_gate_resumed' ||
    message.payload.actionId !== actionId ||
    message.payload.gateId !== receipt.gateId ||
    message.payload.resumeSessionId !== receipt.resumeSessionId ||
    !sameWorkerResumePlans(message.payload.workerResumes, receipt.workerResumes)
  ) {
    throw new Error(`humanGate resumed marker for "${actionId}" conflicts with its first write`);
  }
}

function sameWorkerResumePlans(
  actual: unknown,
  expected: HumanGateResolutionReceipt['workerResumes'],
): boolean {
  if (expected === undefined) return actual === undefined;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((plan, index) => {
    const entry = actual[index];
    return (
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).workerId === plan.workerId &&
      (entry as Record<string, unknown>).sourceSafePointRef === plan.sourceSafePointRef &&
      (entry as Record<string, unknown>).resumeSessionId === plan.resumeSessionId
    );
  });
}
