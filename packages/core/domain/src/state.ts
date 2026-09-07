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
  priority?: number;
  worktree?: PersistedWorktreeRef;
}

export interface WorktreeRef {
  path: string;
  branch: string;
  baseCommit: string;
  headCommit?: string;
}

/** Pre-Phase 9 snapshots may still contain a path string until Git-backed migration. */
export type PersistedWorktreeRef = WorktreeRef | string;

export interface IntegrationBranch {
  workerId: string;
  subtaskId: string;
  worktree: WorktreeRef;
  topologicalRank: number;
}

export interface MergedIntegrationBranch {
  workerId: string;
  subtaskId: string;
  branch: string;
  headCommit: string;
  mergeCommit: string;
}

export interface IntegrationConflict {
  workerId: string;
  subtaskId: string;
  branch: string;
  headCommit: string;
  files: string[];
}

export interface Integration {
  integrationId: string;
  waveId: string;
  base: { branch: string; commit: string };
  integrationWorktree: WorktreeRef;
  pendingBranches: IntegrationBranch[];
  mergedBranches: MergedIntegrationBranch[];
  conflicts: IntegrationConflict[];
  resultCommit?: string;
  status: 'idle' | 'merging' | 'conflict' | 'done';
}

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_SAFE_BRANCH = /^(?![.-])(?!.*(?:\.\.|@\{|[~^:?*[\\\s/]))(?!.*\.$).+$/;

export function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID.test(value);
}

export function isWorktreeRef(value: unknown): value is WorktreeRef {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['path', 'branch', 'baseCommit', 'headCommit'])) return false;
  return (
    typeof value.path === 'string' &&
    value.path.startsWith('/') &&
    typeof value.branch === 'string' &&
    GIT_SAFE_BRANCH.test(value.branch) &&
    isGitObjectId(value.baseCommit) &&
    (value.headCommit === undefined || isGitObjectId(value.headCommit))
  );
}

export function isPersistedWorktreeRef(value: unknown): value is PersistedWorktreeRef {
  return typeof value === 'string' ? value.length > 0 : isWorktreeRef(value);
}

export function isIntegration(value: unknown): value is Integration {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'integrationId',
      'waveId',
      'base',
      'integrationWorktree',
      'pendingBranches',
      'mergedBranches',
      'conflicts',
      'resultCommit',
      'status',
    ]) ||
    typeof value.integrationId !== 'string' ||
    value.integrationId.length === 0 ||
    typeof value.waveId !== 'string' ||
    value.waveId.length === 0 ||
    !isRecord(value.base) ||
    !hasOnlyKeys(value.base, ['branch', 'commit']) ||
    typeof value.base.branch !== 'string' ||
    !GIT_SAFE_BRANCH.test(value.base.branch) ||
    !isGitObjectId(value.base.commit) ||
    !isWorktreeRef(value.integrationWorktree) ||
    !Array.isArray(value.pendingBranches) ||
    !Array.isArray(value.mergedBranches) ||
    !Array.isArray(value.conflicts) ||
    !['idle', 'merging', 'conflict', 'done'].includes(String(value.status)) ||
    (value.resultCommit !== undefined && !isGitObjectId(value.resultCommit))
  ) {
    return false;
  }
  const pending = value.pendingBranches;
  const merged = value.mergedBranches;
  const conflicts = value.conflicts;
  if (
    !pending.every(isIntegrationBranch) ||
    !merged.every(isMergedBranch) ||
    !conflicts.every(isIntegrationConflict)
  )
    return false;
  const pendingWorkerIds = pending.map((entry) => entry.workerId);
  const pendingSubtaskIds = pending.map((entry) => entry.subtaskId);
  if (
    new Set(pendingWorkerIds).size !== pending.length ||
    new Set(pendingSubtaskIds).size !== pending.length
  )
    return false;
  if (
    pending.some(
      (entry, index) =>
        index > 0 && compareIntegrationBranch(pending[index - 1] as IntegrationBranch, entry) >= 0,
    )
  )
    return false;
  if (
    merged.some(
      (entry) =>
        !pendingWorkerIds.includes(entry.workerId) || !pendingSubtaskIds.includes(entry.subtaskId),
    )
  )
    return false;
  if (value.status === 'conflict' ? conflicts.length === 0 : conflicts.length !== 0) return false;
  if (value.status === 'done' ? value.resultCommit === undefined : value.resultCommit !== undefined)
    return false;
  return true;
}

function isIntegrationBranch(value: unknown): value is IntegrationBranch {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['workerId', 'subtaskId', 'worktree', 'topologicalRank']) &&
    typeof value.workerId === 'string' &&
    value.workerId.length > 0 &&
    typeof value.subtaskId === 'string' &&
    value.subtaskId.length > 0 &&
    isWorktreeRef(value.worktree) &&
    value.worktree.headCommit !== undefined &&
    typeof value.topologicalRank === 'number' &&
    Number.isInteger(value.topologicalRank) &&
    value.topologicalRank >= 0
  );
}

function isMergedBranch(value: unknown): value is MergedIntegrationBranch {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['workerId', 'subtaskId', 'branch', 'headCommit', 'mergeCommit']) &&
    typeof value.workerId === 'string' &&
    value.workerId.length > 0 &&
    typeof value.subtaskId === 'string' &&
    value.subtaskId.length > 0 &&
    typeof value.branch === 'string' &&
    GIT_SAFE_BRANCH.test(value.branch) &&
    isGitObjectId(value.headCommit) &&
    isGitObjectId(value.mergeCommit)
  );
}

function isIntegrationConflict(value: unknown): value is IntegrationConflict {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['workerId', 'subtaskId', 'branch', 'headCommit', 'files']) &&
    typeof value.workerId === 'string' &&
    value.workerId.length > 0 &&
    typeof value.subtaskId === 'string' &&
    value.subtaskId.length > 0 &&
    typeof value.branch === 'string' &&
    GIT_SAFE_BRANCH.test(value.branch) &&
    isGitObjectId(value.headCommit) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every((file) => typeof file === 'string' && file.length > 0)
  );
}

function compareIntegrationBranch(left: IntegrationBranch, right: IntegrationBranch): number {
  return (
    left.topologicalRank - right.topologicalRank || left.workerId.localeCompare(right.workerId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isSubtaskPriority(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100)
  );
}

export interface WorkerState {
  workerId: string;
  role: RoleId;
  executor: ExecutorType;
  status: WorkerStatus;
  subtaskId?: string;
  worktree?: PersistedWorktreeRef;
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
    (record.worktree === undefined || isPersistedWorktreeRef(record.worktree)) &&
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
  integration?: Integration;
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
