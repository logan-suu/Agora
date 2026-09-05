import {
  type AppState,
  type HumanGateRequest,
  mergeByIdMutation,
  type RoleSpec,
  setMutation,
} from '@agora/core-domain';
import {
  type HumanGateResolutionReceipt,
  materializeHumanGate,
  runOrchestration,
  type StateTransition,
  type StepOutputHandler,
  type WorkerRuntime,
  type WorkerStepTransition,
} from '@agora/core-orchestration';
import type { TaskScope } from '@agora/runtime-state';

import type { MessageRuntime } from './message-runtime';

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
  saveSafePoints(): Promise<readonly string[]>;
  suspend(): Promise<void>;
  archiveArtifact(): Promise<string>;
  dispose(): Promise<void>;
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

interface ActiveRun {
  goal: string;
  status: Exclude<TaskRunStatus, 'interrupted'>;
  composition: TaskComposition | undefined;
  promise: Promise<void>;
  error: string | undefined;
}

export class TaskGoalConflictError extends Error {
  constructor(scope: TaskScope, existingGoal: string) {
    super(
      `task ${scope.projectId}/${scope.taskId} already exists with a different goal: ${existingGoal}`,
    );
    this.name = 'TaskGoalConflictError';
  }
}

/** Single-instance task lifecycle registry; D17 concurrency is owned by the shared scheduler. */
export class TaskOrchestrationRuntime {
  readonly #runs = new Map<string, ActiveRun>();
  #lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly messages: MessageRuntime,
    readonly createComposition: TaskCompositionFactory,
  ) {
    messages.bindRoleDrainPort({
      awaitSafePoint: (scope, role) => this.#awaitRoleSafePoint(scope, role),
    });
    messages.bindHumanGateLifecyclePort({
      suspend: (scope, request) => this.#suspendAtHumanGate(scope, request),
      resume: (scope, actionId, receipt) => this.#resumeHumanGate(scope, actionId, receipt),
    });
  }

  async start(input: TaskStartInput): Promise<TaskStartResult> {
    return this.#enqueueLifecycle(async () => {
      const existingRun = this.#runs.get(scopeKey(input));
      if (existingRun !== undefined) {
        if (existingRun.goal !== input.goal) {
          throw new TaskGoalConflictError(input, existingRun.goal);
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
      const initialState = await this.messages.initializeState(input, composition.initialState);
      const run: ActiveRun = {
        goal: input.goal,
        status: 'running',
        composition,
        promise: Promise.resolve(),
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
    return summaryFrom(state, run.status, run.error);
  }

  async waitForIdle(scope: TaskScope): Promise<void> {
    await this.#runs.get(scopeKey(scope))?.promise;
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
    const refs = run?.composition === undefined ? [] : await run.composition.saveSafePoints();
    const committed = await this.messages.commitMutations(scope, [
      setMutation('humanGate', materializeHumanGate(request, refs)),
    ]);
    if (run?.composition !== undefined) {
      try {
        await run.composition.suspend();
      } finally {
        run.composition = undefined;
      }
    }
    return committed.state;
  }

  async #resumeHumanGate(
    scope: TaskScope,
    actionId: string,
    receipt: HumanGateResolutionReceipt,
  ): Promise<void> {
    await this.#enqueueLifecycle(async () => {
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
    try {
      const finalState = await runOrchestration(initialState, {
        workerRuntime: composition.workerRuntime,
        roster: composition.roster,
        ...(composition.loadRoster === undefined ? {} : { loadRoster: composition.loadRoster }),
        transition,
        suspendAtHumanGate: (_state, request) => this.#suspendAtHumanGate(scope, request),
      });
      terminalStatus = finalState.phase === 'done' ? 'completed' : 'needs_attention';
    } catch (error) {
      terminalError = errorMessage(error);
      const persisted = await this.messages.store.load(scope).catch(() => undefined);
      if (persisted !== undefined && requiresHumanGateAttention(persisted)) {
        terminalStatus = 'needs_attention';
      }
    }

    if (terminalStatus === 'needs_attention') {
      run.status = terminalStatus;
      run.error = terminalError;
      return;
    }

    try {
      const archivedPath = await composition.archiveArtifact();
      const state = await this.messages.store.load(scope);
      const subtask = state?.subtasks.find((entry) => entry.worktree === composition.artifactPath);
      if (subtask === undefined) {
        throw new Error('task artifact worktree is missing from persisted state');
      }
      await this.messages.commitMutations(scope, [
        mergeByIdMutation('subtasks', subtask.id, { worktree: archivedPath }),
      ]);
    } catch (error) {
      terminalStatus = 'failed';
      terminalError = joinErrors(terminalError, `artifact archive failed: ${errorMessage(error)}`);
    }

    try {
      await composition.dispose();
    } catch (error) {
      terminalStatus = 'failed';
      terminalError = joinErrors(terminalError, `resource disposal failed: ${errorMessage(error)}`);
    } finally {
      run.composition = undefined;
    }
    run.status = terminalStatus;
    run.error = terminalError;
  }

  async #requiredSummary(scope: TaskScope): Promise<TaskSummary> {
    const summary = await this.summary(scope);
    if (summary === undefined) throw new Error('task state disappeared after initialization');
    return summary;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinErrors(current: string | undefined, next: string): string {
  return current === undefined ? next : `${current}; ${next}`;
}

function summaryFrom(state: AppState, runStatus: TaskRunStatus, error?: string): TaskSummary {
  const artifactPath = state.subtasks.find((subtask) => subtask.worktree !== undefined)?.worktree;
  return {
    projectId: state.projectId,
    taskId: state.taskId,
    goal: state.goal,
    runStatus,
    phase: state.phase,
    currentRole: state.nextRole ?? null,
    testResults: state.testResults ?? null,
    artifactPath: artifactPath ?? null,
    messageCount: state.messages.length,
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
    message.payload.resumeSessionId !== receipt.resumeSessionId
  ) {
    throw new Error(`humanGate resumed marker for "${actionId}" conflicts with its first write`);
  }
}
