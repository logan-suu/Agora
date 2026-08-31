import type { AppState, Mutation } from '@agora/core-domain';

export interface TaskScope {
  projectId: string;
  taskId: string;
}

export interface TaskStateCommit {
  state: AppState;
  changed: boolean;
}

export interface TaskStateStore {
  initialize(scope: TaskScope, initial: AppState): Promise<AppState>;
  load(scope: TaskScope): Promise<AppState | undefined>;
  commit(scope: TaskScope, mutations: readonly Mutation[]): Promise<TaskStateCommit>;
}
