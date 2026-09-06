import type { HandoffPacket } from './handoff';
import type { Decision } from './ledger';
import type { Objection } from './objection';

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

export type WorkerStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';

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
  withdrawnByDecisionId?: string;
}

export interface Subtask {
  id: string;
  title: string;
  ownerRole: RoleId;
  dependsOn: string[];
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  worktree?: string;
}

export interface WorkerState {
  workerId: string;
  role: RoleId;
  executor: ExecutorType;
  status: WorkerStatus;
  subtaskId?: string;
  worktree?: string;
  sessionId?: string;
  safePoint?: string;
  startedTs: number;
}

export function isWorkerState(value: unknown): value is WorkerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const statuses: readonly WorkerStatus[] = ['pending', 'running', 'paused', 'done', 'failed'];
  return (
    typeof record.workerId === 'string' &&
    record.workerId.length > 0 &&
    typeof record.role === 'string' &&
    record.role.length > 0 &&
    (record.executor === 'harness' || record.executor === 'external') &&
    typeof record.status === 'string' &&
    statuses.includes(record.status as WorkerStatus) &&
    typeof record.startedTs === 'number' &&
    Number.isInteger(record.startedTs) &&
    record.startedTs >= 0 &&
    (record.subtaskId === undefined || typeof record.subtaskId === 'string') &&
    (record.worktree === undefined || typeof record.worktree === 'string') &&
    (record.sessionId === undefined || typeof record.sessionId === 'string') &&
    (record.safePoint === undefined || typeof record.safePoint === 'string')
  );
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
  executor: ExecutorType;
  systemPrompt: string;
  tools: string[];
  projection: string[];
  routeWhen: string;
  externalCmd?: string;
  model?: string;
}

export type RosterStatus = 'enabled' | 'disabled' | 'departing' | 'departed';

export type DepartureStage =
  | 'draining'
  | 'handoff_committed'
  | 'awaiting_replacement'
  | 'completed';

export interface RoleDeparture {
  actionId: string;
  taskId: string;
  requestedTs: number;
  successorRole?: RoleId;
  stage: DepartureStage;
  handoffRef?: { taskId: string; msgId: string };
}

export interface RosterEntry {
  spec: RoleSpec;
  status: RosterStatus;
  departure?: RoleDeparture;
}

export interface HumanGate {
  gateId: string;
  reason: string;
  options: string[];
  phase: Phase;
  openedTs: number;
  safePointRefs: string[];
}

/** Transient L2 request. It must never be persisted as an incomplete HumanGate. */
export interface HumanGateRequest {
  triggerMsgId: string;
  triggerTs: number;
  reason: string;
  options: string[];
  phase: Phase;
}

export interface Complexity {
  tier: 0 | 1 | 2;
  signals: Record<string, unknown>;
}

export interface AppState {
  projectId: string;
  taskId: string;
  goal: string;
  phase: Phase;
  iterationCount: number;
  workers: WorkerState[];
  subtasks: Subtask[];
  messages: Message[];
  requirements: Requirement[];
  reviewComments: Record<string, unknown>[];
  handoffPackets: HandoffPacket[];
  decisionLedger: Decision[];
  objections: Objection[];
  architecture?: Record<string, unknown>;
  conventions?: Record<string, unknown>;
  pendingPatch?: Record<string, unknown>;
  testResults?: TestResults;
  nextRole?: string;
  humanGate?: HumanGate;
  complexity?: Complexity;
}

export function createInitialAppState(
  taskId: string,
  goal: string,
  projectId = 'default',
): AppState {
  return {
    projectId,
    taskId,
    goal,
    phase: 'clarifying',
    iterationCount: 0,
    workers: [],
    subtasks: [],
    messages: [],
    requirements: [],
    reviewComments: [],
    handoffPackets: [],
    decisionLedger: [],
    objections: [],
  };
}
