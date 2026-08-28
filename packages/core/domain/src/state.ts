export type Phase =
  | 'clarifying'
  | 'planning'
  | 'coding'
  | 'testing'
  | 'review'
  | 'integrating'
  | 'done';

export type RoleId =
  | 'COORDINATOR'
  | 'PM'
  | 'ARCHITECT'
  | 'CODER'
  | 'TESTER'
  | 'REVIEWER'
  | (string & {});

export type ExecutorType = 'harness' | 'external';

export type MsgType =
  | 'handoff'
  | 'feedback'
  | 'question'
  | 'escalation'
  | 'objection'
  | 'chat'
  | 'announce';

export interface Requirement {
  id: string;
  story: string;
  acceptance: string[];
  nonGoals: string[];
}

export interface Subtask {
  id: string;
  title: string;
  ownerRole: RoleId;
  dependsOn: string[];
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  worktree?: string;
}

export interface Message {
  msgId: string;
  threadId?: string;
  channelId: string;
  fromRole: string;
  to?: string[];
  type: MsgType;
  payload: Record<string, unknown>;
  display: string;
  ts: number;
}

export interface TestResults {
  passed: boolean;
  total: number;
  failed: number;
  failures: { test: string; message: string; file: string; line: number }[];
  coverage?: number;
}

export interface RoleSpec {
  role: string;
  enabled: boolean;
  executor: ExecutorType;
  systemPrompt: string;
  tools: string[];
  projection: string[];
  routeWhen: string;
  externalCmd?: string;
  model?: string;
}

export interface HumanGate {
  reason: string;
  options: string[];
  phase: Phase;
}

export interface AppState {
  taskId: string;
  goal: string;
  phase: Phase;
  iterationCount: number;
  subtasks: Subtask[];
  messages: Message[];
  requirements: Requirement[];
  reviewComments: Record<string, unknown>[];
  architecture?: Record<string, unknown>;
  pendingPatch?: Record<string, unknown>;
  testResults?: TestResults;
  nextRole?: string;
  humanGate?: HumanGate;
}

export function createInitialAppState(taskId: string, goal: string): AppState {
  return {
    taskId,
    goal,
    phase: 'clarifying',
    iterationCount: 0,
    subtasks: [],
    messages: [],
    requirements: [],
    reviewComments: [],
  };
}
