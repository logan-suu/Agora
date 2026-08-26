import type { Mutation } from '@agora/core-domain';

export interface ProjectionView {
  role: string;
  slices: Record<string, unknown>;
}

export interface StepContext {
  sessionId: string;
  view: ProjectionView;
}

export interface StepResult {
  kind: 'llm' | 'tool' | 'message' | 'done';
  output: Record<string, unknown>;
  reachedSafeBoundary: boolean;
  mutations: Mutation[];
}

export interface Executor {
  step(context: StepContext): Promise<StepResult>;
  saveSafePoint(): Promise<string>;
  loadSafePoint(cursor: string): Promise<void>;
  injectInbox(view: ProjectionView): void;
}
