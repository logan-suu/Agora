import type {
  ProjectCollaborationCommit,
  ProjectCollaborationSnapshot,
  ProjectCollaborationStore,
} from '@agora/comm-channels';
import {
  type AppState,
  appendMutation,
  beginRoleDeparture,
  completeRoleDeparture,
  type HandoffPacket,
  type Message,
  mergeByIdMutation,
  normalizeRoleId,
  type RoleDeparture,
  type RosterTransition,
  recordRoleDepartureHandoff,
  setMutation,
} from '@agora/core-domain';
import type { TaskScope, TaskStateStore } from '@agora/runtime-state';

import type { MessageService, MutationCommitResult } from './message-service';

export interface RoleDrainPort {
  awaitSafePoint(
    scope: TaskScope,
    role: string,
  ): Promise<{ role: string; activeWorkers: number; safePointRefs: readonly string[] }>;
}

export interface RoleDepartureInput {
  scope: TaskScope;
  actor: 'leader';
  actionId: string;
  role: string;
  successorRole?: string;
  requestedTs: number;
}

export interface RoleDepartureResult {
  status: 'applied' | 'blocked';
  state: AppState;
  collaboration: ProjectCollaborationSnapshot;
}

interface RoleDepartureDeps {
  collaboration: ProjectCollaborationStore;
  state: TaskStateStore;
  messages: Pick<MessageService, 'commitMutations'>;
  drain: RoleDrainPort;
}

export class RoleDepartureRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleDepartureRejectedError';
  }
}

export class RoleDepartureService {
  readonly #collaboration: ProjectCollaborationStore;
  readonly #state: TaskStateStore;
  readonly #messages: Pick<MessageService, 'commitMutations'>;
  readonly #drain: RoleDrainPort;

  constructor(deps: RoleDepartureDeps) {
    this.#collaboration = deps.collaboration;
    this.#state = deps.state;
    this.#messages = deps.messages;
    this.#drain = deps.drain;
  }

  async depart(input: RoleDepartureInput): Promise<RoleDepartureResult> {
    if (input.actor !== 'leader')
      throw new RoleDepartureRejectedError('only leader can remove roles');
    const role = normalizeRoleId(input.role);
    const successorRole =
      input.successorRole === undefined ? undefined : normalizeRoleId(input.successorRole);
    const initialState = await this.#loadState(input.scope);
    const before = await this.#loadCollaboration(input.scope.projectId);
    const target = before.roster.find((entry) => entry.spec.role === role);
    if (target === undefined) throw new RoleDepartureRejectedError(`unknown role "${role}"`);
    const actionOwner = before.roster.find(
      (entry) => entry.departure?.actionId === input.actionId && entry.spec.role !== role,
    );
    if (actionOwner !== undefined) {
      throw new RoleDepartureRejectedError(
        `departure action "${input.actionId}" already belongs to role "${actionOwner.spec.role}"`,
      );
    }
    const existing = target.departure;
    const messageId = `role-departure:${input.actionId}`;
    const existingHandoffMessage = initialState.messages.find(
      (message) => message.msgId === messageId,
    );
    if (existing === undefined && existingHandoffMessage !== undefined) {
      throw new RoleDepartureRejectedError(
        `handoff message id "${messageId}" conflicts with an existing non-departure message`,
      );
    }
    if (
      (target.status === 'departing' || target.status === 'departed') &&
      existing?.actionId !== input.actionId
    ) {
      throw new RoleDepartureRejectedError(
        `role "${role}" departure conflicts with an existing action`,
      );
    }
    if (existing?.actionId !== input.actionId) {
      if (initialState.phase === 'done') {
        throw new RoleDepartureRejectedError('cannot remove a role from a completed task');
      }
      if (initialState.humanGate !== undefined) {
        throw new RoleDepartureRejectedError(
          'cannot remove a role while humanGate awaits leader resolution',
        );
      }
    }

    let collaboration = (
      await this.#transition(input.scope.projectId, (snapshot) =>
        beginRoleDeparture(snapshot.roster, role, {
          actionId: input.actionId,
          taskId: input.scope.taskId,
          requestedTs: existing?.requestedTs ?? input.requestedTs,
          ...(successorRole === undefined ? {} : { successorRole }),
        }),
      )
    ).snapshot;
    let departure = this.#departure(collaboration, role, input.actionId);
    if (departure.stage === 'completed') {
      const state = await this.#loadState(input.scope);
      assertCanonicalDepartureHandoff(state, role, departure, messageId);
      return { status: 'applied', state, collaboration };
    }
    if (departure.stage === 'awaiting_replacement') {
      const state = await this.#loadState(input.scope);
      assertCanonicalDepartureHandoff(state, role, departure, messageId);
      return { status: 'blocked', state, collaboration };
    }

    let state = await this.#loadState(input.scope);
    const handoffAlreadyCommitted = state.messages.some((message) => message.msgId === messageId);
    if (!handoffAlreadyCommitted) {
      await this.#drain.awaitSafePoint(input.scope, role);
      state = await this.#loadState(input.scope);
      const currentProject = await this.#loadCollaboration(input.scope.projectId);
      departure = this.#departure(currentProject, role, input.actionId);
      if (
        departure.successorRole !== undefined &&
        !currentProject.roster.some(
          (entry) => entry.spec.role === departure.successorRole && entry.status === 'enabled',
        )
      ) {
        throw new Error(`departure successor "${departure.successorRole}" is no longer enabled`);
      }
      state = (await this.#commitHandoff(input.scope, state, role, departure, messageId)).state;
    }

    assertCanonicalDepartureHandoff(state, role, departure, messageId);

    const unfinished = state.subtasks.filter(
      (subtask) => subtask.ownerRole === role && subtask.status !== 'done',
    );
    const awaitingReplacement = departure.successorRole === undefined && unfinished.length > 0;
    collaboration = (
      await this.#transition(input.scope.projectId, (snapshot) => {
        const persisted = this.#departure(snapshot, role, input.actionId);
        if (
          persisted.successorRole !== undefined &&
          !snapshot.roster.some(
            (entry) => entry.spec.role === persisted.successorRole && entry.status === 'enabled',
          )
        ) {
          throw new Error(
            `departure successor "${persisted.successorRole}" became unavailable before completion`,
          );
        }
        const recorded = recordRoleDepartureHandoff(
          snapshot.roster,
          role,
          input.actionId,
          { taskId: input.scope.taskId, msgId: messageId },
          awaitingReplacement,
        );
        return awaitingReplacement
          ? recorded
          : completeRoleDeparture(recorded.roster, role, input.actionId);
      })
    ).snapshot;
    return {
      status: awaitingReplacement ? 'blocked' : 'applied',
      state,
      collaboration,
    };
  }

  async #commitHandoff(
    scope: TaskScope,
    state: AppState,
    role: string,
    departure: RoleDeparture,
    messageId: string,
  ): Promise<MutationCommitResult> {
    const unfinished = state.subtasks
      .filter((subtask) => subtask.ownerRole === role && subtask.status !== 'done')
      .sort((left, right) => left.id.localeCompare(right.id));
    const packet = buildDepartureHandoff(
      state,
      role,
      departure.successorRole,
      departure.requestedTs,
    );
    const awaitingReplacement = departure.successorRole === undefined && unfinished.length > 0;
    const message: Message = {
      msgId: messageId,
      channelId: 'main',
      fromRole: 'COORDINATOR',
      to: [packet.toRole],
      type: 'handoff',
      payload: { kind: 'role_departure_handoff', actionId: departure.actionId, packet },
      display: `Role ${role} handoff is ready for ${packet.toRole}.`,
      ts: departure.requestedTs,
    };
    return this.#messages.commitMutations(scope, [
      appendMutation('handoffPackets', packet),
      ...unfinished.map((subtask) =>
        mergeByIdMutation(
          'subtasks',
          subtask.id,
          departure.successorRole === undefined
            ? { status: 'blocked' }
            : { ownerRole: departure.successorRole },
        ),
      ),
      ...(awaitingReplacement
        ? [
            setMutation('humanGate', {
              reason: `role_departure_requires_replacement:${role}`,
              options: ['assign_enabled_successor'],
              phase: state.phase,
            }),
          ]
        : []),
      appendMutation('messages', message),
    ]);
  }

  async #transition(
    projectId: string,
    transition: (snapshot: ProjectCollaborationSnapshot) => RosterTransition,
  ): Promise<ProjectCollaborationCommit> {
    const current = await this.#loadCollaboration(projectId);
    const result = transition(current);
    if (!result.changed) return { snapshot: current, changed: false };
    const enabledRoles = result.roster
      .filter((entry) => entry.status === 'enabled')
      .map((entry) => entry.spec.role);
    const channels = current.channels.map((channel) =>
      channel.kind === 'main'
        ? { ...channel, participants: ['leader' as const, ...enabledRoles] }
        : channel,
    );
    return this.#collaboration.commit(projectId, current.revision, {
      roster: result.roster,
      channels,
    });
  }

  async #loadState(scope: TaskScope): Promise<AppState> {
    const state = await this.#state.load(scope);
    if (state === undefined) {
      throw new Error(
        `task state is not initialized for projectId "${scope.projectId}" and taskId "${scope.taskId}"`,
      );
    }
    return state;
  }

  async #loadCollaboration(projectId: string): Promise<ProjectCollaborationSnapshot> {
    const snapshot = await this.#collaboration.load(projectId);
    if (snapshot === undefined) {
      throw new Error(
        `project collaboration store is not initialized for projectId "${projectId}"`,
      );
    }
    return snapshot;
  }

  #departure(
    snapshot: ProjectCollaborationSnapshot,
    role: string,
    actionId: string,
  ): RoleDeparture {
    const entry = snapshot.roster.find((candidate) => candidate.spec.role === role);
    if (entry?.departure?.actionId !== actionId) {
      throw new Error(`role "${role}" has no departure action "${actionId}"`);
    }
    return entry.departure;
  }
}

function assertCanonicalDepartureHandoff(
  state: AppState,
  role: string,
  departure: RoleDeparture,
  messageId: string,
): void {
  const message = state.messages.find((candidate) => candidate.msgId === messageId);
  const payload = message?.payload;
  const packet = payload?.packet;
  const expectedToRole = departure.successorRole ?? 'leader';
  const canonicalMessage =
    message !== undefined &&
    message.channelId === 'main' &&
    message.fromRole === 'COORDINATOR' &&
    message.type === 'handoff' &&
    message.to?.length === 1 &&
    message.to[0] === expectedToRole &&
    message.ts === departure.requestedTs &&
    payload !== undefined &&
    payload.kind === 'role_departure_handoff' &&
    payload.actionId === departure.actionId &&
    isHandoffPacket(packet) &&
    packet.fromRole === role &&
    packet.toRole === expectedToRole &&
    packet.ts === departure.requestedTs &&
    state.handoffPackets.some((candidate) => sameHandoffPacket(candidate, packet));
  const unfinished = state.subtasks.filter(
    (subtask) => subtask.ownerRole === role && subtask.status !== 'done',
  );
  const responsibilitiesCommitted =
    departure.successorRole === undefined
      ? unfinished.every((subtask) => subtask.status === 'blocked') &&
        (unfinished.length === 0 ||
          state.humanGate?.reason === `role_departure_requires_replacement:${role}`)
      : unfinished.length === 0;
  if (!canonicalMessage || !responsibilitiesCommitted) {
    throw new RoleDepartureRejectedError(
      `handoff message "${messageId}" conflicts with the persisted departure facts`,
    );
  }
}

function isHandoffPacket(value: unknown): value is HandoffPacket {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const packet = value as Partial<HandoffPacket>;
  return (
    typeof packet.fromRole === 'string' &&
    typeof packet.toRole === 'string' &&
    typeof packet.done === 'string' &&
    Array.isArray(packet.keyDecisions) &&
    packet.keyDecisions.every((entry) => typeof entry === 'string') &&
    Array.isArray(packet.openIssues) &&
    packet.openIssues.every((entry) => typeof entry === 'string') &&
    Array.isArray(packet.fileRefs) &&
    packet.fileRefs.every((entry) => typeof entry === 'string') &&
    typeof packet.ts === 'number' &&
    Number.isFinite(packet.ts)
  );
}

function sameHandoffPacket(left: HandoffPacket, right: HandoffPacket): boolean {
  return (
    left.fromRole === right.fromRole &&
    left.toRole === right.toRole &&
    left.done === right.done &&
    sameStrings(left.keyDecisions, right.keyDecisions) &&
    sameStrings(left.openIssues, right.openIssues) &&
    sameStrings(left.fileRefs, right.fileRefs) &&
    left.ts === right.ts
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function buildDepartureHandoff(
  state: AppState,
  role: string,
  successorRole: string | undefined,
  requestedTs: number,
): HandoffPacket {
  const completed = state.subtasks
    .filter((subtask) => subtask.ownerRole === role && subtask.status === 'done')
    .sort((left, right) => left.id.localeCompare(right.id));
  const unfinished = state.subtasks
    .filter((subtask) => subtask.ownerRole === role && subtask.status !== 'done')
    .sort((left, right) => left.id.localeCompare(right.id));
  const toRole = successorRole ?? 'leader';
  const done =
    completed.length === 0
      ? `Phase ${state.phase}; no completed subtasks.`
      : `Phase ${state.phase}; completed subtasks: ${completed
          .map((subtask) => `${subtask.id} (${subtask.title})`)
          .join(', ')}.`;
  const openIssues = unfinished.flatMap((subtask) => [
    `Subtask ${subtask.id} (${subtask.status}): ${subtask.title}`,
    `Recommendation: ${toRole} should continue subtask ${subtask.id}.`,
  ]);
  const fileRefs = [
    ...new Set(
      state.testResults?.failures.map((failure) => `${failure.file}:${String(failure.line)}`) ?? [],
    ),
  ].sort();
  return {
    fromRole: role,
    toRole,
    done,
    keyDecisions: state.decisionLedger.map((decision) => decision.id),
    openIssues,
    fileRefs,
    ts: requestedTs,
  };
}
