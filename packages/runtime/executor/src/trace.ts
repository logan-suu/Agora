import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Context, type Fiber } from '@deepseek-ai/cordis';
import SessionStore, {
  type SessionEvent,
  type SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';

const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_ROLE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ROLE_PRESET_PREFIX = 'agora-role:';
const DEFAULT_MAX_EVENTS = 500;
const MAX_EVENTS = 2000;
const TRACE_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
]);

export type TraceTurnStatus =
  | 'running'
  | 'completed'
  | 'blocked'
  | 'aborted'
  | 'error'
  | 'max_tokens'
  | 'interrupted';

export type TraceStepStatus = 'running' | 'completed' | 'aborted' | 'error' | 'interrupted';
export type TraceToolStatus = 'running' | 'succeeded' | 'failed';

export interface TraceToolCallView {
  callId: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  status: TraceToolStatus;
  errorCode?: string;
}

export interface TraceStepView {
  step: number;
  startedAt: number;
  endedAt?: number;
  status: TraceStepStatus;
  tools: TraceToolCallView[];
}

export interface TraceTurnView {
  turn: number;
  startedAt: number;
  endedAt?: number;
  status: TraceTurnStatus;
  steps: TraceStepView[];
}

export interface TraceSessionView {
  sessionId: string;
  role: string;
  createdAt: number;
  parentSessionId?: string;
  seedLength?: number;
  turns: TraceTurnView[];
}

export interface TraceSnapshot {
  projectId: string;
  taskId: string;
  sessions: TraceSessionView[];
  omittedEventCount: number;
}

export interface TraceReader {
  read(
    scope: { projectId: string; taskId: string },
    options?: { maxEvents?: number },
  ): Promise<TraceSnapshot>;
}

export interface TraceInspection {
  readonly meta: SessionHeader;
  readonly events: readonly SessionEvent[];
}

interface ProjectedTurn {
  view: TraceTurnView;
  eventCount: number;
}

interface ProjectedSession {
  header: SessionHeader;
  role: string;
  turns: ProjectedTurn[];
}

/** Read-only D15 adapter over the official Harness JSONL persistence API. */
export class HarnessTraceReader implements TraceReader {
  constructor(readonly dataRoot: string) {}

  async read(
    scope: { projectId: string; taskId: string },
    options: { maxEvents?: number } = {},
  ): Promise<TraceSnapshot> {
    assertScope(scope);
    const maxEvents = resolvedMaxEvents(options.maxEvents);
    const ctx = new Context();
    const fibers: Fiber[] = [ctx.plugin(SessionStore)];
    fibers.push(
      ctx.plugin(JsonlSessionPersistence, {
        root: join(
          this.dataRoot,
          'projects',
          scope.projectId,
          'tasks',
          scope.taskId,
          'harness-sessions',
        ),
      }),
    );
    try {
      await Promise.all(fibers);
      const headers = await ctx.sessionPersistence.list();
      const inspections = await Promise.all(
        headers.map((header) => ctx.sessionPersistence.inspect(SessionId(header.id))),
      );
      return projectTraceInspections(scope.projectId, scope.taskId, inspections, { maxEvents });
    } finally {
      for (let index = fibers.length - 1; index >= 0; index -= 1) {
        await fibers[index]?.dispose();
      }
    }
  }
}

export function projectTraceInspections(
  projectId: string,
  taskId: string,
  inspections: readonly TraceInspection[],
  options: { maxEvents?: number } = {},
): TraceSnapshot {
  assertScope({ projectId, taskId });
  const maxEvents = resolvedMaxEvents(options.maxEvents);
  const byId = new Map<string, TraceInspection>();
  for (const inspection of inspections) {
    const id = String(inspection.meta.id);
    if (byId.has(id)) throw new Error(`duplicate Harness session "${id}"`);
    validateEventSequence(inspection);
    byId.set(id, inspection);
  }
  for (const inspection of inspections) validateLineage(inspection, byId);

  const projected = inspections
    .map(projectSession)
    .sort(
      (left, right) =>
        left.header.createdAt - right.header.createdAt ||
        String(left.header.id).localeCompare(String(right.header.id)),
    );
  const allTurns = projected
    .flatMap((session) =>
      session.turns.map((turn) => ({ sessionId: String(session.header.id), turn })),
    )
    .sort(
      (left, right) =>
        left.turn.view.startedAt - right.turn.view.startedAt ||
        left.sessionId.localeCompare(right.sessionId) ||
        left.turn.view.turn - right.turn.view.turn,
    );
  const retained = new Set<ProjectedTurn>();
  let retainedEvents = 0;
  let omittedEventCount = 0;
  for (let index = allTurns.length - 1; index >= 0; index -= 1) {
    const turn = allTurns[index]?.turn;
    if (turn === undefined) continue;
    if (retainedEvents + turn.eventCount <= maxEvents) {
      retained.add(turn);
      retainedEvents += turn.eventCount;
    } else {
      omittedEventCount += turn.eventCount;
    }
  }

  return {
    projectId,
    taskId,
    omittedEventCount,
    sessions: projected
      .map((session) => ({
        sessionId: String(session.header.id),
        role: session.role,
        createdAt: session.header.createdAt,
        ...(session.header.parentSession === undefined
          ? {}
          : { parentSessionId: String(session.header.parentSession) }),
        ...(session.header.seedLength === undefined
          ? {}
          : { seedLength: session.header.seedLength }),
        turns: session.turns.filter((turn) => retained.has(turn)).map((turn) => turn.view),
      }))
      .filter((session) => session.turns.length > 0),
  };
}

function projectSession(inspection: TraceInspection): ProjectedSession {
  const role = roleFrom(inspection.meta);
  const start = inspection.meta.seedLength ?? 0;
  const nativeEvents = inspection.events
    .slice(start)
    .filter((event) => TRACE_EVENT_TYPES.has(event.type));
  const turns = new Map<number, ProjectedTurn>();

  for (const event of nativeEvents) {
    const data = event.data as Record<string, unknown>;
    const turnNumber = integerField(data, 'turn', event.type);
    if (event.type === 'turn/start') {
      if (turns.has(turnNumber)) throw new Error(`duplicate turn/start for turn ${turnNumber}`);
      turns.set(turnNumber, {
        eventCount: 1,
        view: { turn: turnNumber, startedAt: event.time, status: 'running', steps: [] },
      });
      continue;
    }
    const turn = turns.get(turnNumber);
    if (turn === undefined) throw new Error(`${event.type} has no native turn/start`);
    turn.eventCount += 1;

    if (event.type === 'turn/end') {
      turn.view.endedAt = event.time;
      turn.view.status = turnStatus(data.reason);
      const finalStep = turn.view.steps.at(-1);
      if (finalStep !== undefined)
        finalStep.status = stepStatus(turn.view.status, finalStep.status);
      continue;
    }

    const stepNumber = integerField(data, 'step', event.type);
    if (event.type === 'step/start') {
      if (turn.view.steps.some((step) => step.step === stepNumber)) {
        throw new Error(`duplicate step/start for turn ${turnNumber} step ${stepNumber}`);
      }
      turn.view.steps.push({
        step: stepNumber,
        startedAt: event.time,
        status: 'running',
        tools: [],
      });
      continue;
    }
    const step = turn.view.steps.find((candidate) => candidate.step === stepNumber);
    if (step === undefined) throw new Error(`${event.type} has no native step/start`);

    if (event.type === 'step/end') {
      step.endedAt = event.time;
      step.status = 'completed';
      continue;
    }
    if (event.type === 'tool/call') {
      const callId = stringField(data, 'callId', event.type);
      if (step.tools.some((tool) => tool.callId === callId)) {
        throw new Error(`duplicate tool/call "${callId}"`);
      }
      step.tools.push({
        callId,
        name: stringField(data, 'name', event.type),
        startedAt: event.time,
        status: 'running',
      });
      continue;
    }
    const result = toolResult(data, event.type);
    const tool = step.tools.find((candidate) => candidate.callId === result.callId);
    if (tool === undefined) throw new Error(`tool/result "${result.callId}" has no tool/call`);
    tool.endedAt = event.time;
    tool.status = result.failed ? 'failed' : 'succeeded';
    if (result.errorCode !== undefined) tool.errorCode = result.errorCode;
  }

  return { header: inspection.meta, role, turns: [...turns.values()] };
}

function validateLineage(
  inspection: TraceInspection,
  byId: ReadonlyMap<string, TraceInspection>,
): void {
  const parentId = inspection.meta.parentSession;
  const seedLength = inspection.meta.seedLength;
  if ((parentId === undefined) !== (seedLength === undefined)) {
    throw new Error(`Harness session "${inspection.meta.id}" has incomplete lineage`);
  }
  if (parentId === undefined || seedLength === undefined) return;
  const parent = byId.get(String(parentId));
  if (parent === undefined)
    throw new Error(`Harness session "${inspection.meta.id}" has no parent`);
  if (
    seedLength <= 0 ||
    seedLength > parent.events.length ||
    seedLength > inspection.events.length
  ) {
    throw new Error(`Harness session "${inspection.meta.id}" has invalid seedLength`);
  }
  for (let index = 0; index < seedLength; index += 1) {
    if (!isDeepStrictEqual(inspection.events[index], parent.events[index])) {
      throw new Error(`Harness session "${inspection.meta.id}" seed prefix differs from parent`);
    }
  }
}

function validateEventSequence(inspection: TraceInspection): void {
  for (let index = 0; index < inspection.events.length; index += 1) {
    const event = inspection.events[index];
    if (event?.seq !== index || !Number.isSafeInteger(event.time) || event.time < 0) {
      throw new Error(`Harness session "${inspection.meta.id}" has invalid event sequence`);
    }
  }
}

function roleFrom(header: SessionHeader): string {
  if (!header.agentPreset?.startsWith(ROLE_PRESET_PREFIX)) {
    throw new Error(`Harness session "${header.id}" has invalid agentPreset`);
  }
  const role = header.agentPreset.slice(ROLE_PRESET_PREFIX.length);
  if (!SAFE_ROLE.test(role))
    throw new Error(`Harness session "${header.id}" has invalid agentPreset`);
  return role;
}

function toolResult(
  data: Record<string, unknown>,
  eventType: string,
): { callId: string; failed: boolean; errorCode?: string } {
  const message = data.message;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    throw new Error(`${eventType}.message must be an object`);
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error(`${eventType}.message.content must contain one tool result`);
  }
  const block = content[0];
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    throw new Error(`${eventType}.message.content must contain one tool result`);
  }
  const record = block as Record<string, unknown>;
  const callId = stringField(record, 'toolCallId', eventType);
  const error = data.error;
  let errorCode: string | undefined;
  if (error !== undefined) {
    if (typeof error !== 'object' || error === null || Array.isArray(error)) {
      throw new Error(`${eventType}.error must be an object`);
    }
    errorCode = stringField(error as Record<string, unknown>, 'code', eventType);
  }
  return {
    callId,
    failed: record.isError === true || errorCode !== undefined,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function turnStatus(reason: unknown): TraceTurnStatus {
  if (typeof reason !== 'object' || reason === null || Array.isArray(reason)) {
    throw new Error('turn/end.reason must be an object');
  }
  const kind = (reason as Record<string, unknown>).kind;
  if (
    kind === 'completed' ||
    kind === 'blocked' ||
    kind === 'aborted' ||
    kind === 'error' ||
    kind === 'interrupted'
  ) {
    return kind;
  }
  if (kind === 'max-tokens') return 'max_tokens';
  throw new Error('turn/end.reason.kind is invalid');
}

function stepStatus(turn: TraceTurnStatus, current: TraceStepStatus): TraceStepStatus {
  if (turn === 'error') return 'error';
  if (turn === 'aborted') return 'aborted';
  if (turn === 'interrupted') return 'interrupted';
  return current;
}

function integerField(data: Record<string, unknown>, field: string, eventType: string): number {
  const value = data[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${eventType}.${field} must be a non-negative integer`);
  }
  return value as number;
}

function stringField(data: Record<string, unknown>, field: string, eventType: string): string {
  const value = data[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${eventType}.${field} must be a non-empty string`);
  }
  return value;
}

function assertScope(scope: { projectId: string; taskId: string }): void {
  if (!SAFE_SCOPE_SEGMENT.test(scope.projectId)) {
    throw new Error('projectId must be a safe non-empty path segment');
  }
  if (!SAFE_SCOPE_SEGMENT.test(scope.taskId)) {
    throw new Error('taskId must be a safe non-empty path segment');
  }
}

function resolvedMaxEvents(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_EVENTS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_EVENTS) {
    throw new Error(`maxEvents must be an integer between 1 and ${MAX_EVENTS}`);
  }
  return resolved;
}
