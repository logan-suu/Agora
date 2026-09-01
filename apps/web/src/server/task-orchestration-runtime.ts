import type { AppState, RoleSpec } from '@agora/core-domain';
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
  composition: TaskComposition;
  promise: Promise<void>;
  error?: string;
}

export class TaskGoalConflictError extends Error {
  constructor(scope: TaskScope, existingGoal: string) {
    super(
      `task ${scope.projectId}/${scope.taskId} already exists with a different goal: ${existingGoal}`,
    );
    this.name = 'TaskGoalConflictError';
  }
}

/** Single-instance Phase 5 lifecycle registry required by decision D10. */
export class TaskOrchestrationRuntime {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    readonly messages: MessageRuntime,
    readonly createComposition: TaskCompositionFactory,
  ) {}

  async start(input: TaskStartInput): Promise<TaskStartResult> {
    return this.#enqueue(input, async () => {
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
        const startOutcome: 'completed' | 'interrupted' =
          persisted.phase === 'done' ? 'completed' : 'interrupted';
        const summary = summaryFrom(persisted, startOutcome);
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
        transition,
      });
      const initialState = await this.messages.initializeState(input, composition.initialState);
      const run: ActiveRun = {
        goal: input.goal,
        status: 'running',
        composition,
        promise: Promise.resolve(),
      };
      this.#runs.set(scopeKey(input), run);
      run.promise = runOrchestration(initialState, {
        workerRuntime: composition.workerRuntime,
        roster: composition.roster,
        transition,
      }).then(
        (finalState) => {
          run.status = finalState.phase === 'done' ? 'completed' : 'needs_attention';
        },
        (error: unknown) => {
          run.status = 'failed';
          run.error = error instanceof Error ? error.message : String(error);
        },
      );

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
    await Promise.all(runs.map((run) => run.composition.dispose()));
    this.#runs.clear();
  }

  async #requiredSummary(scope: TaskScope): Promise<TaskSummary> {
    const summary = await this.summary(scope);
    if (summary === undefined) throw new Error('task state disappeared after initialization');
    return summary;
  }

  async #enqueue<T>(scope: TaskScope, operation: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }
}

function scopeKey(scope: TaskScope): string {
  return `${scope.projectId}\u0000${scope.taskId}`;
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
