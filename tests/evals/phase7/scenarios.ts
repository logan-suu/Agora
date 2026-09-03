// R11/G5: only the external paid LLM stream is scripted. HTTP intent handling,
// JSON stores, collaboration CAS, roster transitions, WorkerRuntime, HarnessExecutor,
// safe-point persistence, handoff construction, onboarding projection, and replay are real.
import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  type RoleSpec,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor, project } from '@agora/runtime-executor';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import {
  createMessageRuntime,
  type MessageRuntime,
} from '../../../apps/web/src/server/message-runtime';
import type { AgoraEvalTask } from '../core/contracts';
import type { EvalExecutionContext, EvalObservation } from '../core/runner';
import {
  executeDeterministicScenario as executePhase6DeterministicScenario,
  executeModelScenario as executePhase6ModelScenario,
  usesPhase6Docker,
} from '../phase6/scenarios';

const RELEASE_MANAGER: RoleSpec = {
  role: 'RELEASE_MANAGER',
  executor: 'harness',
  systemPrompt: 'Coordinate release readiness from structured task facts.',
  tools: [],
  projection: ['goal'],
  routeWhen: 'leaderAssigned',
};

class GatedAdapter extends LlmAdapter {
  readonly started: Promise<void>;
  private markStarted = () => {};
  private releaseStream = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseStream = resolve;
  });

  constructor() {
    super();
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  release(): void {
    this.releaseStream();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.markStarted();
    await this.gate;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Phase 7 Eval step committed.' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Phase 7 Eval step committed.' },
    };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

class AuditedHarnessExecutor extends HarnessExecutor {
  constructor(
    spec: RoleSpec,
    adapter: LlmAdapter,
    private readonly events: string[],
  ) {
    super(spec, { adapter, provider: 'agora' });
  }

  override async saveSafePoint(): Promise<string> {
    const ref = await super.saveSafePoint();
    this.events.push('safe-point');
    return ref;
  }
}

export function usesPhase7Docker(taskId: string): boolean {
  return taskId.startsWith('phase6/') && usesPhase6Docker(taskId);
}

export async function executePhase7DeterministicScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  if (task.id.startsWith('phase6/')) return executePhase6DeterministicScenario(task, context);
  switch (task.id) {
    case 'phase7/role-registration':
      return roleRegistrationScenario(context);
    case 'phase7/forced-handoff':
      return forcedHandoffScenario(context);
    case 'phase7/onboarding-recovery':
      return onboardingRecoveryScenario(context);
    case 'phase7/orphan-escalation':
      return orphanEscalationScenario(context);
    case 'phase7/coordinator-protection':
      return coordinatorProtectionScenario(context);
    default:
      throw new Error(`deterministic profile has no Phase 7 driver for ${task.id}`);
  }
}

export async function executePhase7ModelScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  if (task.id.startsWith('phase6/')) return executePhase6ModelScenario(task, context);
  throw new Error(`model profile has no Phase 7 driver for ${task.id}`);
}

async function roleRegistrationScenario(context: EvalExecutionContext): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: 'role-registration', taskId: 'task' };
  await runtime.initialize(scope, 'Register a release manager');
  const before = await requiredCollaboration(runtime, scope.projectId);
  await runtime.roster.addRole(scope.projectId, RELEASE_MANAGER);
  const after = await requiredCollaboration(runtime, scope.projectId);
  await runtime.roster.addRole(scope.projectId, RELEASE_MANAGER);
  const replay = await requiredCollaboration(runtime, scope.projectId);
  const member = after.roster.find((entry) => entry.spec.role === RELEASE_MANAGER.role);
  const main = after.channels.find((channel) => channel.kind === 'main');
  const atomic =
    after.revision === before.revision + 1 &&
    member?.status === 'enabled' &&
    main?.participants.includes(RELEASE_MANAGER.role) === true &&
    replay.revision === after.revision;
  return observation(
    { 'roster.role-added': member?.status === 'enabled' },
    { 'process.roster-channel-atomic': atomic },
  );
}

async function forcedHandoffScenario(context: EvalExecutionContext): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: 'forced-handoff', taskId: 'task' };
  const initial = applyMutations(
    createInitialAppState(scope.taskId, 'Transfer an in-flight coding task', scope.projectId),
    [
      mergeByIdMutation('subtasks', 'coding-work', {
        title: 'Commit then transfer',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
      }),
    ],
  );
  await runtime.initializeState(scope, initial);
  const adapter = new GatedAdapter();
  const events: string[] = [];
  const executors: AuditedHarnessExecutor[] = [];
  const worker = new WorkerRuntime({
    roster: DEFAULT_ROSTER,
    loadRoster: () => runtime.enabledRoleSpecs(scope.projectId),
    buildChannelContext: (state, role) => runtime.workerStepChannelContextFor(state, role),
    transitionStep: async (_state, role, mutations) => {
      const committed = await runtime.commitWorkerStepMutations(scope, role, mutations);
      events.push('step-commit');
      return committed.state;
    },
    buildExecutor: (spec) => {
      const executor = new AuditedHarnessExecutor(spec, adapter, events);
      executors.push(executor);
      return executor;
    },
  });
  runtime.bindRoleDrainPort({
    awaitSafePoint: async (_scope, role) => worker.awaitRoleSafePoint(role),
  });

  try {
    const running = worker.runOne(initial, { role: 'CODER', subtaskId: 'coding-work' });
    await adapter.started;
    const post = createPostMessage(runtime);
    const removal = postMessage(post, scope, 'remove-coder-eval', '/role remove CODER to TESTER');
    await waitForRoleStatus(runtime, scope.projectId, 'CODER', 'departing');
    const wasDepartingBeforeRelease =
      (await requiredCollaboration(runtime, scope.projectId)).roster.find(
        (entry) => entry.spec.role === 'CODER',
      )?.status === 'departing';
    adapter.release();
    const [, response] = await Promise.all([running, removal]);
    const responseBody = (await response.json()) as { action?: { status?: string } };
    events.push('handoff-observed');
    const firstState = await requiredState(runtime, scope);
    const firstCollaboration = await requiredCollaboration(runtime, scope.projectId);
    const replayResponse = await postMessage(
      post,
      scope,
      'remove-coder-eval',
      '/role remove CODER to TESTER',
    );
    const replayBody = (await replayResponse.json()) as {
      published?: boolean;
      action?: { status?: string };
    };
    const replayState = await requiredState(runtime, scope);
    const replayCollaboration = await requiredCollaboration(runtime, scope.projectId);
    const handoffIndex = firstState.messages.findIndex(
      (message) => message.msgId === 'role-departure:remove-coder-eval',
    );
    const stepIndex = firstState.messages.findIndex(
      (message) => message.display === 'Phase 7 Eval step committed.',
    );
    const coder = firstCollaboration.roster.find((entry) => entry.spec.role === 'CODER');
    const transferred = firstState.subtasks.find((entry) => entry.id === 'coding-work');
    return observation(
      {
        'handoff.completed':
          responseBody.action?.status === 'applied' &&
          coder?.status === 'departed' &&
          transferred?.ownerRole === 'TESTER',
      },
      {
        'process.departing-before-drain': wasDepartingBeforeRelease,
        'process.safe-point-before-handoff':
          events.indexOf('safe-point') > events.indexOf('step-commit') &&
          events.indexOf('handoff-observed') > events.indexOf('safe-point') &&
          handoffIndex > stepIndex,
        'process.responsibility-before-departed':
          transferred?.ownerRole === 'TESTER' && coder?.departure?.stage === 'completed',
        'process.action-replay-idempotent':
          replayBody.published === false &&
          replayBody.action?.status === 'applied' &&
          JSON.stringify(replayState) === JSON.stringify(firstState) &&
          JSON.stringify(replayCollaboration) === JSON.stringify(firstCollaboration),
      },
      { modelCalls: 1, toolCalls: 0 },
    );
  } finally {
    adapter.release();
    await Promise.all(executors.map((executor) => executor.dispose()));
  }
}

async function onboardingRecoveryScenario(context: EvalExecutionContext): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: 'onboarding-recovery', taskId: 'task' };
  await runtime.initialize(scope, 'Recover a tester handoff');
  const post = createPostMessage(runtime);
  await postMessage(post, scope, 'remove-coder-onboarding', '/role remove CODER to TESTER');
  const onboarding = await postMessage(post, scope, 'onboard-tester-eval', '/role onboard TESTER');
  const onboardingBody = (await onboarding.json()) as { action?: { status?: string } };

  const restarted = createMessageRuntime(context.dataRoot, new ChannelStream());
  const persisted = await requiredState(restarted, scope);
  const roster = await restarted.enabledRoleSpecs(scope.projectId);
  const channelContext = await restarted.channelContextFor(persisted, 'TESTER');
  const view = project(persisted, 'TESTER', roster, channelContext);
  const encoded = JSON.stringify(view);
  const onboardingContext = view.slices.onboardingContext as {
    actionId?: string | null;
    handoffs?: Array<{ ref?: { msgId?: string } }>;
  };
  const recovered =
    onboardingBody.action?.status === 'applied' &&
    onboardingContext.actionId === 'onboard-tester-eval' &&
    onboardingContext.handoffs?.[0]?.ref?.msgId === 'role-departure:remove-coder-onboarding';
  return observation(
    { 'onboarding.recovered': recovered },
    {
      'process.onboarding-from-persisted-state': recovered && persisted.nextRole === 'TESTER',
      'process.no-raw-log':
        !encoded.includes('/role onboard TESTER') &&
        !encoded.includes('Role CODER handoff is ready'),
    },
  );
}

async function orphanEscalationScenario(context: EvalExecutionContext): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: 'orphan-escalation', taskId: 'task' };
  await runtime.initializeState(
    scope,
    applyMutations(createInitialAppState(scope.taskId, 'Escalate orphaned work', scope.projectId), [
      mergeByIdMutation('subtasks', 'orphan', {
        title: 'Needs a replacement',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'in_progress',
      }),
    ]),
  );
  const response = await postMessage(
    createPostMessage(runtime),
    scope,
    'remove-coder-orphan',
    '/role remove CODER',
  );
  const body = (await response.json()) as { action?: { status?: string } };
  const state = await requiredState(runtime, scope);
  const collaboration = await requiredCollaboration(runtime, scope.projectId);
  const coder = collaboration.roster.find((entry) => entry.spec.role === 'CODER');
  const orphan = state.subtasks.find((entry) => entry.id === 'orphan');
  const blocked = body.action?.status === 'blocked' && orphan?.status === 'blocked';
  return observation(
    { 'orphan.escalated': blocked },
    {
      'process.awaiting-replacement':
        blocked &&
        coder?.status === 'departing' &&
        coder.departure?.stage === 'awaiting_replacement',
      'process.leader-human-gate':
        state.humanGate?.reason === 'role_departure_requires_replacement:CODER' &&
        orphan?.ownerRole === 'CODER',
    },
    { humanInterventions: 1 },
  );
}

async function coordinatorProtectionScenario(
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: 'coordinator-protection', taskId: 'task' };
  await runtime.initialize(scope, 'Keep the Coordinator enabled');
  const before = await requiredCollaboration(runtime, scope.projectId);
  const response = await postMessage(
    createPostMessage(runtime),
    scope,
    'remove-coordinator-eval',
    '/role remove COORDINATOR',
  );
  const body = (await response.json()) as { action?: { status?: string } };
  const after = await requiredCollaboration(runtime, scope.projectId);
  const state = await requiredState(runtime, scope);
  const protectedRole = after.roster.find((entry) => entry.spec.role === 'COORDINATOR');
  const protectedState =
    body.action?.status === 'rejected' &&
    protectedRole?.status === 'enabled' &&
    JSON.stringify(after) === JSON.stringify(before);
  return observation(
    { 'coordinator.protected': protectedState },
    {
      'process.coordinator-always-enabled':
        protectedState &&
        state.messages.length === 1 &&
        state.messages[0]?.payload.action !== undefined,
    },
  );
}

function observation(
  assertions: Record<string, boolean>,
  invariants: Record<string, boolean>,
  efficiency: Partial<NonNullable<EvalObservation['efficiency']>> = {},
): EvalObservation {
  return {
    assertions,
    invariants,
    efficiency: {
      iterations: 1,
      modelCalls: 0,
      toolCalls: 0,
      repairIterations: 0,
      humanInterventions: 0,
      ...efficiency,
    },
  };
}

function postMessage(
  post: ReturnType<typeof createPostMessage>,
  scope: { projectId: string; taskId: string },
  msgId: string,
  display: string,
): Promise<Response> {
  return post(
    new Request('http://localhost/api/messages', {
      method: 'POST',
      body: JSON.stringify({ ...scope, channelId: 'main', msgId, display }),
    }),
  );
}

async function requiredState(
  runtime: MessageRuntime,
  scope: { projectId: string; taskId: string },
) {
  const state = await runtime.store.load(scope);
  if (state === undefined) throw new Error('expected persisted Eval task state');
  return state;
}

async function requiredCollaboration(runtime: MessageRuntime, projectId: string) {
  const collaboration = await runtime.collaboration.load(projectId);
  if (collaboration === undefined) throw new Error('expected persisted Eval collaboration');
  return collaboration;
}

async function waitForRoleStatus(
  runtime: MessageRuntime,
  projectId: string,
  role: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const collaboration = await requiredCollaboration(runtime, projectId);
    if (collaboration.roster.find((entry) => entry.spec.role === role)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`role ${role} did not reach ${status}`);
}
