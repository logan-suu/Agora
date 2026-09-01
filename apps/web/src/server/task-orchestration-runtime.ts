import { type AppState, mergeByIdMutation, type RoleSpec } from '@agora/core-domain';
import {
  runOrchestration,
  type StateTransition,
  type WorkerRuntime,
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
  artifactPath: string;
  archiveArtifact(): Promise<string>;
  dispose(): Promise<void>;
}

export type TaskCompositionFactory = (input: {
  scope: TaskScope;
  goal: string;
  transition: StateTransition;
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

export class TaskCapacityConflictError extends Error {
  constructor(activeScope: TaskScope) {
    super(
      `Phase 5 backend already has an active run for ${activeScope.projectId}/${activeScope.taskId}`,
    );
    this.name = 'TaskCapacityConflictError';
  }
}

/** Single-instance Phase 5 lifecycle registry required by decision D10. */
export class TaskOrchestrationRuntime {
  readonly #runs = new Map<string, ActiveRun>();
  #lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly messages: MessageRuntime,
    readonly createComposition: TaskCompositionFactory,
  ) {}

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
        const startOutcome: 'completed' | 'interrupted' =
          persisted.phase === 'done' ? 'completed' : 'interrupted';
        const summary = summaryFrom(persisted, startOutcome);
        return {
          ...summary,
          requestId: input.requestId,
          startOutcome,
        };
      }

      const activeEntry = [...this.#runs.entries()].find(([, run]) => run.status === 'running');
      if (activeEntry !== undefined) {
        throw new TaskCapacityConflictError(scopeFromKey(activeEntry[0]));
      }

      const transition: StateTransition = async (_state, mutations) =>
        (await this.messages.commitMutations(input, mutations)).state;
      const composition = await this.createComposition({
        scope: input,
        goal: input.goal,
        transition,
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
      return summaryFrom(state, state.phase === 'done' ? 'completed' : 'interrupted');
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
        transition,
      });
      terminalStatus = finalState.phase === 'done' ? 'completed' : 'needs_attention';
    } catch (error) {
      terminalError = errorMessage(error);
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

function scopeFromKey(key: string): TaskScope {
  const [projectId, taskId] = key.split('\u0000');
  if (projectId === undefined || taskId === undefined) throw new Error('invalid task scope key');
  return { projectId, taskId };
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
