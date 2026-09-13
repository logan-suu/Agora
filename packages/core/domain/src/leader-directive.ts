import type { Decision } from './ledger';
import { appendMutation, type Mutation, mergeByIdMutation } from './reducer';
import type { AppState, Message } from './state';

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface RequirementChange {
  requirementId: string;
  requirement: { story: string; acceptance: string[]; nonGoals: string[] };
}

export type Phase9LeaderIntent =
  | { kind: 'requirements_change'; changes: RequirementChange[] }
  | {
      kind: 'requirement_change';
      requirementId: string;
      requirement: { story: string; acceptance: string[]; nonGoals: string[] };
    }
  | {
      kind: 'decision_change';
      topic: string;
      decision: string;
      rationale: string;
      supersedes?: string;
    }
  | { kind: 'priority_change'; subtaskId: string; priority: number };

export interface Phase9LeaderActionInput {
  actionId: string;
  intent: Phase9LeaderIntent;
  ts: number;
}

export interface Phase9LeaderActionPlan {
  intent: Phase9LeaderIntent;
  mutations: readonly Mutation[];
}

export interface LeaderDirective {
  actionId: string;
  kind: Phase9LeaderIntent['kind'];
  data: Record<string, unknown>;
  messageRef: { projectId: string; taskId: string; msgId: string };
}

export function planPhase9LeaderAction(
  state: AppState,
  input: Phase9LeaderActionInput,
): Phase9LeaderActionPlan {
  assertSafeToken(input.actionId, 'Phase 9 actionId');
  if (!Number.isInteger(input.ts) || input.ts < 0) {
    throw new Error('Phase 9 Leader action ts must be a non-negative integer');
  }
  if (state.phase === 'done') throw new Error('cannot change a completed task');
  if (state.humanGate !== undefined) {
    throw new Error('cannot change a task while humanGate awaits leader resolution');
  }
  const intent = normalizePhase9LeaderIntent(input.intent);
  switch (intent.kind) {
    case 'requirements_change':
      return {
        intent,
        mutations: intent.changes.flatMap(
          (change) =>
            planPhase9LeaderAction(state, {
              ...input,
              intent: { kind: 'requirement_change', ...change },
            }).mutations,
        ),
      };
    case 'requirement_change': {
      const current = state.requirements.find((entry) => entry.id === intent.requirementId);
      if (current?.withdrawnByDecisionId !== undefined) {
        throw new Error(`requirement "${intent.requirementId}" is withdrawn and cannot be revived`);
      }
      return {
        intent,
        mutations: [
          mergeByIdMutation('requirements', intent.requirementId, {
            story: intent.requirement.story,
            acceptance: [...intent.requirement.acceptance],
            nonGoals: [...intent.requirement.nonGoals],
          }),
        ],
      };
    }
    case 'decision_change': {
      const current = currentDecisions(state, intent.topic);
      if (current.length > 1) {
        throw new Error(`decision topic "${intent.topic}" has multiple current decisions`);
      }
      if (current.length === 0 && intent.supersedes !== undefined) {
        throw new Error(`new decision topic "${intent.topic}" cannot specify supersedes`);
      }
      if (current.length === 1 && intent.supersedes !== current[0]?.id) {
        throw new Error(
          `decision topic "${intent.topic}" must explicitly supersede current decision "${String(current[0]?.id)}"`,
        );
      }
      const decision: Decision = {
        id: `leader-decision:${input.actionId}`,
        topic: intent.topic,
        decision: intent.decision,
        rationale: intent.rationale,
        authority: 'leader',
        by: 'leader',
        ...(intent.supersedes === undefined ? {} : { supersedes: intent.supersedes }),
        ts: input.ts,
      };
      return { intent, mutations: [appendMutation('decisionLedger', decision)] };
    }
    case 'priority_change': {
      const subtask = state.subtasks.find((entry) => entry.id === intent.subtaskId);
      if (subtask === undefined) throw new Error(`subtask "${intent.subtaskId}" does not exist`);
      if (subtask.status === 'done') {
        throw new Error(`subtask "${intent.subtaskId}" is already done`);
      }
      return {
        intent,
        mutations: [mergeByIdMutation('subtasks', intent.subtaskId, { priority: intent.priority })],
      };
    }
  }
}

export function assertPhase9LeaderActionReplay(
  state: AppState,
  message: Message,
  incoming: Phase9LeaderIntent,
): LeaderDirective {
  const intent = normalizePhase9LeaderIntent(incoming);
  const persisted = phase9IntentOf(message);
  const canonical = hasCanonicalPhase9Envelope(message) && sameIntent(persisted, intent);
  if (!canonical) {
    throw new Error(`Phase 9 Leader action "${message.msgId}" conflicts with its first write`);
  }
  assertEffect(state, message, intent);
  return directiveOf(state, message, intent);
}

export function deriveLeaderDirective(state: AppState): LeaderDirective | null {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message === undefined) continue;
    const intent = phase9IntentOf(message);
    if (intent === undefined || !actionIsApplied(message)) continue;
    if (!hasCanonicalPhase9Envelope(message)) {
      throw new Error(`Phase 9 Leader action "${message.msgId}" lacks a canonical envelope`);
    }
    assertEffect(state, message, intent);
    return directiveOf(state, message, intent);
  }
  return null;
}

export function normalizePhase9LeaderIntent(intent: Phase9LeaderIntent): Phase9LeaderIntent {
  if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) {
    throw new Error('Phase 9 Leader intent must be an object');
  }
  switch (intent.kind) {
    case 'requirements_change': {
      assertExactKeys(intent, ['kind', 'changes']);
      if (!Array.isArray(intent.changes) || intent.changes.length < 1 || intent.changes.length > 20)
        throw new Error('requirements_change requires 1 through 20 changes');
      const changes = intent.changes.map((change) => {
        assertExactKeys(change, ['requirementId', 'requirement']);
        const normalized = normalizePhase9LeaderIntent({ kind: 'requirement_change', ...change });
        if (normalized.kind !== 'requirement_change') throw new Error('invalid requirement change');
        return { requirementId: normalized.requirementId, requirement: normalized.requirement };
      });
      if (new Set(changes.map((change) => change.requirementId)).size !== changes.length)
        throw new Error('duplicate requirement changes');
      return { kind: intent.kind, changes };
    }
    case 'requirement_change': {
      assertExactKeys(intent, ['kind', 'requirementId', 'requirement']);
      assertSafeToken(intent.requirementId, 'requirementId');
      const requirement = intent.requirement;
      if (typeof requirement !== 'object' || requirement === null || Array.isArray(requirement)) {
        throw new Error('requirement payload must be an object');
      }
      assertExactKeys(requirement, ['acceptance', 'nonGoals', 'story']);
      return {
        kind: intent.kind,
        requirementId: intent.requirementId,
        requirement: {
          story: normalizedNonEmptyString(requirement.story, 'requirement story'),
          acceptance: normalizedStringArray(requirement.acceptance, 'requirement acceptance', true),
          nonGoals: normalizedStringArray(requirement.nonGoals, 'requirement nonGoals', false),
        },
      };
    }
    case 'decision_change': {
      assertExactKeys(intent, [
        'decision',
        'kind',
        'rationale',
        ...(intent.supersedes === undefined ? [] : ['supersedes']),
        'topic',
      ]);
      assertSafeToken(intent.topic, 'decision topic');
      if (intent.supersedes !== undefined) assertSafeToken(intent.supersedes, 'supersedes');
      return {
        kind: intent.kind,
        topic: intent.topic,
        decision: normalizedNonEmptyString(intent.decision, 'decision'),
        rationale: normalizedNonEmptyString(intent.rationale, 'decision rationale'),
        ...(intent.supersedes === undefined ? {} : { supersedes: intent.supersedes }),
      };
    }
    case 'priority_change':
      assertExactKeys(intent, ['kind', 'priority', 'subtaskId']);
      assertSafeToken(intent.subtaskId, 'subtaskId');
      assertSubtaskPriority(intent.priority);
      return { ...intent };
    default:
      throw new Error('unknown Phase 9 Leader intent');
  }
}

function phase9IntentOf(message: Message): Phase9LeaderIntent | undefined {
  const candidate = message.payload.intent;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const kind = (candidate as Record<string, unknown>).kind;
  if (
    kind !== 'requirements_change' &&
    kind !== 'requirement_change' &&
    kind !== 'decision_change' &&
    kind !== 'priority_change'
  ) {
    return undefined;
  }
  return normalizePhase9LeaderIntent(candidate as Phase9LeaderIntent);
}

function actionIsApplied(message: Message): boolean {
  const action = message.payload.action;
  return (
    typeof action === 'object' &&
    action !== null &&
    !Array.isArray(action) &&
    (action as Record<string, unknown>).status === 'applied'
  );
}

function hasCanonicalPhase9Envelope(message: Message): boolean {
  return (
    message.channelId === 'main' &&
    message.fromRole === 'leader' &&
    message.type === 'chat' &&
    message.payload.kind === 'leader_intent' &&
    actionIsApplied(message)
  );
}

function assertEffect(state: AppState, message: Message, intent: Phase9LeaderIntent): void {
  switch (intent.kind) {
    case 'requirements_change':
      for (const change of intent.changes)
        assertEffect(state, message, { kind: 'requirement_change', ...change });
      return;
    case 'requirement_change': {
      const requirement = state.requirements.find((entry) => entry.id === intent.requirementId);
      if (
        requirement === undefined ||
        requirement.withdrawnByDecisionId !== undefined ||
        requirement.story !== intent.requirement.story ||
        !sameStrings(requirement.acceptance, intent.requirement.acceptance) ||
        !sameStrings(requirement.nonGoals, intent.requirement.nonGoals)
      ) {
        throw new Error(`Phase 9 Leader action "${message.msgId}" requirement effect drifted`);
      }
      return;
    }
    case 'decision_change': {
      const decision = state.decisionLedger.find(
        (entry) => entry.id === `leader-decision:${message.msgId}`,
      );
      if (
        decision === undefined ||
        decision.topic !== intent.topic ||
        decision.decision !== intent.decision ||
        decision.rationale !== intent.rationale ||
        decision.supersedes !== intent.supersedes ||
        decision.authority !== 'leader' ||
        decision.by !== 'leader' ||
        decision.ts !== message.ts
      ) {
        throw new Error(`Phase 9 Leader action "${message.msgId}" decision effect drifted`);
      }
      return;
    }
    case 'priority_change': {
      const subtask = state.subtasks.find((entry) => entry.id === intent.subtaskId);
      if (subtask?.priority !== intent.priority) {
        throw new Error(`Phase 9 Leader action "${message.msgId}" priority effect drifted`);
      }
    }
  }
}

function directiveOf(
  state: AppState,
  message: Message,
  intent: Phase9LeaderIntent,
): LeaderDirective {
  const data =
    intent.kind === 'requirements_change'
      ? { changes: structuredClone(intent.changes) }
      : intent.kind === 'requirement_change'
        ? { requirementId: intent.requirementId, requirement: structuredClone(intent.requirement) }
        : intent.kind === 'decision_change'
          ? {
              topic: intent.topic,
              decision: intent.decision,
              rationale: intent.rationale,
              ...(intent.supersedes === undefined ? {} : { supersedes: intent.supersedes }),
            }
          : { subtaskId: intent.subtaskId, priority: intent.priority };
  return {
    actionId: message.msgId,
    kind: intent.kind,
    data,
    messageRef: { projectId: state.projectId, taskId: state.taskId, msgId: message.msgId },
  };
}

function currentDecisions(state: AppState, topic: string): Decision[] {
  const superseded = new Set(
    state.decisionLedger
      .map((entry) => entry.supersedes)
      .filter((id): id is string => id !== undefined),
  );
  return state.decisionLedger.filter((entry) => entry.topic === topic && !superseded.has(entry.id));
}

function assertSafeToken(value: string, field: string): void {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) {
    throw new Error(`${field} must be a safe token`);
  }
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    !actual.every((key, index) => key === canonical[index])
  ) {
    throw new Error(`Phase 9 Leader intent has invalid keys: ${actual.join(', ')}`);
  }
}

function normalizedNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizedStringArray(value: unknown, field: string, nonEmpty: boolean): string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`${field} must be ${nonEmpty ? 'a non-empty ' : 'an '}array`);
  }
  return value.map((entry) => normalizedNonEmptyString(entry, `${field} entry`));
}

function assertSubtaskPriority(priority: unknown): asserts priority is number {
  if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 100) {
    throw new Error('subtask priority must be an integer from 0 through 100');
  }
}

function sameIntent(left: Phase9LeaderIntent | undefined, right: Phase9LeaderIntent): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
