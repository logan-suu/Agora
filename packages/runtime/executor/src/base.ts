import type { ChannelSummary, Mutation, SubChannel } from '@agora/core-domain';

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

export interface ChannelSummarySourceEntry {
  ref: { taskId: string; msgId: string };
  fromRole: string;
  type: string;
  content?: Record<string, unknown>;
}

/** L3 port implemented by the thin Harness adapter in Phase 0–9. */
export interface ChannelSummaryGenerator {
  generate(input: {
    channel: SubChannel;
    entries: readonly ChannelSummarySourceEntry[];
  }): Promise<ChannelSummary>;
}
