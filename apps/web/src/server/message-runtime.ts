import { basename, dirname, resolve } from 'node:path';
import type { MessageBus, MessageCommitted } from '@agora/comm-bus';
import { toDisplayMessageEvent } from '@agora/comm-bus';
import {
  DerivedChannelContextBuilder,
  JsonProjectChannelStore,
  JsonProjectCollaborationStore,
} from '@agora/comm-channels';
import {
  type AppState,
  createMainChannel,
  type Message,
  type Mutation,
  type RoleSpec,
  type RosterEntry,
} from '@agora/core-domain';
import {
  ChannelLifecycleRejectedError,
  ChannelLifecycleService,
  ChannelSummaryReconciler,
  type MessageCommitResult,
  MessageService,
  type MutationCommitResult,
  ProjectRosterService,
  RoleDepartureRejectedError,
  RoleDepartureService,
  type RoleDrainPort,
} from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import {
  type ChannelSummaryGenerator,
  HarnessChannelSummaryGenerator,
} from '@agora/runtime-executor';
import { JsonTaskStateStore, type TaskScope } from '@agora/runtime-state';

import { type LeaderActionStatus, parseLeaderIntent, planLeaderIntent } from '../lib/intent';
import { type ChannelAddress, ChannelStream, channelStream } from './channel-stream';

class SseMessageBus implements MessageBus {
  readonly #stream: ChannelStream;

  constructor(stream: ChannelStream) {
    this.#stream = stream;
  }

  async publish(event: MessageCommitted): Promise<void> {
    const address: ChannelAddress = {
      projectId: event.projectId,
      taskId: event.taskId,
      channelId: event.message.channelId,
    };
    this.#stream.publish(address, {
      type: 'message',
      data: toDisplayMessageEvent(event),
    });
  }
}

export class MessageRuntime {
  readonly root: string;
  readonly store: JsonTaskStateStore;
  readonly collaboration: JsonProjectCollaborationStore;
  readonly channels: JsonProjectChannelStore;
  readonly roster: ProjectRosterService;
  readonly stream: ChannelStream;
  readonly #service: MessageService;
  readonly #lifecycle: ChannelLifecycleService;
  readonly #summaryReconciler: ChannelSummaryReconciler;
  readonly #departure: RoleDepartureService;
  #roleDrain: RoleDrainPort = {
    awaitSafePoint: async (_scope, role) => ({ role, activeWorkers: 0, safePointRefs: [] }),
  };
  readonly #initialRoster: readonly RosterEntry[];
  readonly #channelContext = new DerivedChannelContextBuilder();
  readonly #leaderQueues = new Map<string, Promise<void>>();

  constructor(
    root: string,
    stream: ChannelStream,
    roster: readonly RoleSpec[],
    summaryGenerator: ChannelSummaryGenerator = new HarnessChannelSummaryGenerator(),
  ) {
    this.root = root;
    this.store = new JsonTaskStateStore(root);
    this.#initialRoster = roster.map((spec) => ({ spec, status: 'enabled' }));
    this.collaboration = new JsonProjectCollaborationStore(root);
    this.channels = new JsonProjectChannelStore(this.collaboration, this.#initialRoster);
    this.roster = new ProjectRosterService(this.collaboration);
    this.stream = stream;
    this.#service = new MessageService(
      this.store,
      new SseMessageBus(stream),
      this.channels,
      this.collaboration,
    );
    this.#lifecycle = new ChannelLifecycleService(this.channels, this.#service, this.collaboration);
    this.#departure = new RoleDepartureService({
      collaboration: this.collaboration,
      state: this.store,
      messages: this.#service,
      drain: {
        awaitSafePoint: (scope, role) => this.#roleDrain.awaitSafePoint(scope, role),
      },
    });
    this.#summaryReconciler = new ChannelSummaryReconciler({
      channels: this.channels,
      messages: this.#service,
      state: this.store,
      generator: summaryGenerator,
      legacySummaries: (projectId) => this.channels.legacyBubbledSummaries(projectId),
      acknowledgeLegacySummary: (projectId, channelId) =>
        this.channels.acknowledgeLegacyBubbledSummary(projectId, channelId),
    });
  }

  async initialize(scope: TaskScope, goal: string): Promise<AppState> {
    await this.ensureProjectChannels(scope.projectId);
    const state = await this.#service.initialize(scope, goal);
    return (await this.#summaryReconciler.reconcile(scope)) ?? state;
  }

  async initializeState(scope: TaskScope, state: AppState): Promise<AppState> {
    await this.ensureProjectChannels(scope.projectId);
    const initialized = await this.store.initialize(scope, state);
    return (await this.#summaryReconciler.reconcile(scope)) ?? initialized;
  }

  commitMutations(scope: TaskScope, mutations: readonly Mutation[]): Promise<MutationCommitResult> {
    return this.#service.commitMutations(scope, mutations);
  }

  commitWorkerStepMutations(
    scope: TaskScope,
    role: string,
    mutations: readonly Mutation[],
  ): Promise<MutationCommitResult> {
    return this.#service.commitWorkerStepMutations(scope, role, mutations);
  }

  commitMessage(scope: TaskScope, message: Message): Promise<MessageCommitResult> {
    return this.#service.commitMessage(scope, message);
  }

  bindRoleDrainPort(port: RoleDrainPort): void {
    this.#roleDrain = port;
  }

  ensureProjectChannels(projectId: string) {
    return this.channels.initialize(projectId, [
      createMainChannel(this.#initialRoster.map((entry) => entry.spec.role)),
    ]);
  }

  async channelContextFor(state: AppState, role: string) {
    const snapshot = await this.collaboration.load(state.projectId);
    if (snapshot === undefined) {
      throw new Error(
        `project channel store is not initialized for projectId "${state.projectId}"`,
      );
    }
    const entry = snapshot.roster.find((candidate) => candidate.spec.role === role);
    if (entry?.status !== 'enabled') throw new Error(`role "${role}" is not enabled`);
    return this.#channelContext.build(snapshot, state, role);
  }

  async workerStepChannelContextFor(state: AppState, role: string) {
    const snapshot = await this.collaboration.load(state.projectId);
    if (snapshot === undefined) {
      throw new Error(
        `project channel store is not initialized for projectId "${state.projectId}"`,
      );
    }
    const entry = snapshot.roster.find((candidate) => candidate.spec.role === role);
    if (entry?.status !== 'enabled' && entry?.status !== 'departing') {
      throw new Error(`role "${role}" is not available for an in-flight worker step`);
    }
    return this.#channelContext.build(snapshot, state, role);
  }

  async enabledRoleSpecs(projectId: string): Promise<RoleSpec[]> {
    const snapshot = await this.collaboration.load(projectId);
    if (snapshot === undefined) {
      throw new Error(
        `project collaboration store is not initialized for projectId "${projectId}"`,
      );
    }
    return snapshot.roster
      .filter((entry) => entry.status === 'enabled')
      .map((entry) => structuredClone(entry.spec));
  }

  reconcileChannels(scope: TaskScope): Promise<AppState | undefined> {
    return this.#summaryReconciler.reconcile(scope);
  }

  async commitLeaderMessage(
    scope: TaskScope,
    input: {
      msgId: string;
      channelId: string;
      display: string;
      ts: number;
    },
  ): Promise<MessageCommitResult & { action: LeaderActionStatus }> {
    return this.#enqueueLeader(scope, () => this.#commitLeaderMessage(scope, input));
  }

  async #commitLeaderMessage(
    scope: TaskScope,
    input: {
      msgId: string;
      channelId: string;
      display: string;
      ts: number;
    },
  ): Promise<MessageCommitResult & { action: LeaderActionStatus }> {
    const current = await this.store.load(scope);
    if (current === undefined) {
      throw new Error(
        `task state is not initialized for projectId "${scope.projectId}" and taskId "${scope.taskId}"`,
      );
    }
    const existing = current.messages.find((message) => message.msgId === input.msgId);
    if (existing !== undefined) {
      const collaboration = await this.collaboration.load(scope.projectId);
      if (collaboration === undefined) {
        throw new Error(
          `project collaboration store is not initialized for projectId "${scope.projectId}"`,
        );
      }
      const departureEntries = collaboration.roster.filter(
        (entry) => entry.departure?.actionId === input.msgId,
      );
      if (departureEntries.length > 1) {
        throw new Error(`departure action "${input.msgId}" belongs to multiple roster entries`);
      }
      const departureEntry = departureEntries[0];
      if (departureEntry?.departure !== undefined) {
        const result = await this.#departure.depart({
          scope,
          actor: 'leader',
          actionId: departureEntry.departure.actionId,
          role: departureEntry.spec.role,
          ...(departureEntry.departure.successorRole === undefined
            ? {}
            : { successorRole: departureEntry.departure.successorRole }),
          requestedTs: departureEntry.departure.requestedTs,
        });
        return {
          state: result.state,
          published: false,
          message: existing,
          action:
            result.status === 'applied'
              ? { status: 'applied' }
              : {
                  status: 'blocked',
                  reason: `role_departure_requires_replacement:${departureEntry.spec.role}`,
                },
        };
      }
      return { state: current, published: false, message: existing, action: actionFrom(existing) };
    }
    await this.#summaryReconciler.reconcile(scope);
    const collaboration = await this.collaboration.load(scope.projectId);
    if (collaboration === undefined) {
      throw new Error(
        `project collaboration store is not initialized for projectId "${scope.projectId}"`,
      );
    }
    const enabledRoster = collaboration.roster
      .filter((entry) => entry.status === 'enabled')
      .map((entry) => entry.spec);
    const knownRoles = collaboration.roster.map((entry) => entry.spec.role);

    const intent = parseLeaderIntent(input.display);
    let lifecycleRejection: LeaderActionStatus | undefined;
    let departureAction: LeaderActionStatus | undefined;
    try {
      if (intent.kind === 'open_sub_channel') {
        if (input.channelId !== 'main') {
          throw new ChannelLifecycleRejectedError('channel lifecycle commands must use main');
        }
        await this.#lifecycle.open({
          scope,
          actor: 'leader',
          actionId: input.msgId,
          requestedRoles: intent.requestedRoles,
          topic: intent.topic,
        });
      } else if (intent.kind === 'close_sub_channel') {
        if (input.channelId !== 'main') {
          throw new ChannelLifecycleRejectedError('channel lifecycle commands must use main');
        }
        await this.#lifecycle.close({
          scope,
          actor: 'leader',
          actionId: input.msgId,
          channelId: intent.channelId,
        });
        await this.#summaryReconciler.reconcile(scope);
      } else if (intent.kind === 'remove_role') {
        if (input.channelId !== 'main') {
          throw new RoleDepartureRejectedError('role departure commands must use main');
        }
        const plan = planLeaderIntent(intent, current, enabledRoster, knownRoles);
        if (plan.action.status === 'applied') {
          const result = await this.#departure.depart({
            scope,
            actor: 'leader',
            actionId: input.msgId,
            role: intent.targetRole,
            ...(intent.successorRole === undefined ? {} : { successorRole: intent.successorRole }),
            requestedTs: input.ts,
          });
          departureAction =
            result.status === 'applied'
              ? { status: 'applied' }
              : {
                  status: 'blocked',
                  reason: `role_departure_requires_replacement:${intent.targetRole}`,
                };
        }
      }
    } catch (error) {
      if (
        !(error instanceof ChannelLifecycleRejectedError) &&
        !(error instanceof RoleDepartureRejectedError)
      ) {
        throw error;
      }
      lifecycleRejection = { status: 'rejected', reason: error.message };
    }

    const result = await this.#service.commitPlannedMessage(scope, input.msgId, (state) => {
      const planned = planLeaderIntent(intent, state, enabledRoster, knownRoles);
      const action = lifecycleRejection ?? departureAction ?? planned.action;
      const message: Message = {
        msgId: input.msgId,
        channelId: input.channelId,
        fromRole: 'leader',
        type: 'chat',
        payload: {
          kind: 'leader_intent',
          intent: planned.intent,
          action,
        },
        display: input.display,
        ts: input.ts,
      };
      return { message, mutations: planned.mutations };
    });

    return { ...result, action: actionFrom(result.message) };
  }

  async handleWorkerOutput(
    state: AppState,
    role: string,
    output: Record<string, unknown>,
  ): Promise<void> {
    const action = output.channelAction;
    if (typeof action !== 'object' || action === null || Array.isArray(action)) return;
    const record = action as Record<string, unknown>;
    const scope = { projectId: state.projectId, taskId: state.taskId };
    if (record.kind === 'open_sub_channel') {
      if (
        typeof record.actionId !== 'string' ||
        (record.threadId !== undefined && typeof record.threadId !== 'string') ||
        !Array.isArray(record.requestedRoles) ||
        !record.requestedRoles.every((requested) => typeof requested === 'string') ||
        typeof record.topic !== 'string'
      ) {
        throw new Error('invalid structured open_sub_channel output');
      }
      await this.#lifecycle.open({
        scope,
        actor: role,
        actionId: record.actionId,
        ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
        requestedRoles: record.requestedRoles,
        topic: record.topic,
      });
      return;
    }
    if (record.kind === 'close_sub_channel') {
      if (typeof record.channelId !== 'string') {
        throw new Error('invalid structured close_sub_channel output');
      }
      if (typeof record.actionId !== 'string') {
        throw new Error('invalid structured close_sub_channel output');
      }
      await this.#lifecycle.close({
        scope,
        actor: role,
        actionId: record.actionId,
        channelId: record.channelId,
      });
      await this.#summaryReconciler.reconcile(scope);
      return;
    }
    throw new Error('unknown structured channel action output');
  }

  async #enqueueLeader<T>(scope: TaskScope, operation: () => Promise<T>): Promise<T> {
    const key = `${scope.projectId}\u0000${scope.taskId}`;
    const previous = this.#leaderQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#leaderQueues.set(key, tail);

    try {
      return await result;
    } finally {
      if (this.#leaderQueues.get(key) === tail) this.#leaderQueues.delete(key);
    }
  }
}

export function createMessageRuntime(
  root: string,
  stream = new ChannelStream(),
  roster: readonly RoleSpec[] = DEFAULT_ROSTER,
  summaryGenerator?: ChannelSummaryGenerator,
): MessageRuntime {
  return new MessageRuntime(root, stream, roster, summaryGenerator);
}

export function getOrCreateMessageRuntime(
  registry: { messageRuntime: MessageRuntime | undefined },
  create: () => MessageRuntime,
): MessageRuntime {
  if (registry.messageRuntime !== undefined) return registry.messageRuntime;
  const runtime = create();
  registry.messageRuntime = runtime;
  return runtime;
}

function actionFrom(message: Message): LeaderActionStatus {
  const action = message.payload.action;
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return { status: 'none' };
  }
  const status = (action as Record<string, unknown>).status;
  if (status === 'applied' || status === 'none') return { status };
  const reason = (action as Record<string, unknown>).reason;
  if (status === 'blocked' && typeof reason === 'string') return { status, reason };
  if (status === 'rejected' && typeof reason === 'string') return { status, reason };
  const targetPhase = (action as Record<string, unknown>).targetPhase;
  if (
    status === 'deferred' &&
    (targetPhase === 6 || targetPhase === 8 || targetPhase === 9) &&
    typeof reason === 'string'
  ) {
    return { status, targetPhase, reason };
  }
  return { status: 'none' };
}

const workingDirectory = process.cwd();
const workspaceRoot =
  basename(workingDirectory) === 'web' && basename(dirname(workingDirectory)) === 'apps'
    ? resolve(workingDirectory, '../..')
    : workingDirectory;
const defaultDataRoot = process.env.AGORA_DATA_ROOT ?? resolve(workspaceRoot, '.data');
const processRegistry = globalThis as typeof globalThis & {
  __agoraMessageRuntime?: MessageRuntime;
};
export const messageRuntime = getOrCreateMessageRuntime(
  {
    get messageRuntime() {
      return processRegistry.__agoraMessageRuntime;
    },
    set messageRuntime(runtime: MessageRuntime | undefined) {
      if (runtime === undefined) {
        delete processRegistry.__agoraMessageRuntime;
      } else {
        processRegistry.__agoraMessageRuntime = runtime;
      }
    },
  },
  () => createMessageRuntime(defaultDataRoot, channelStream),
);
