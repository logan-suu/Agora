import { existsSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import type { MessageBus, MessageCommitted } from '@agora/comm-bus';
import { DerivedChannelContextBuilder, JsonProjectChannelStore } from '@agora/comm-channels';
import {
  appendMutation,
  applyMutations,
  type ChannelSummary,
  createInitialAppState,
  createMainChannel,
  type Message,
  type SubChannel,
} from '@agora/core-domain';
import { MessageService } from '@agora/core-orchestration';
import {
  type ChannelSummaryGenerator,
  HarnessChannelSummaryGenerator,
} from '@agora/runtime-executor';
import { DockerSandbox } from '@agora/runtime-sandbox';
import { JsonTaskStateStore } from '@agora/runtime-state';

import type { AgoraEvalTask } from '../core/contracts';
import type { EvalExecutionContext, EvalObservation } from '../core/runner';

const roles = ['COORDINATOR', 'CODER', 'TESTER'] as const;
const CONTEXT_SCENARIO_IDS = new Set([
  'main-scope',
  'sub-scope',
  'participant-isolation',
  'context-redaction',
]);
const DOCKER_SCENARIO_IDS = new Set(['coding-closure', 'test-repair', 'sandbox-boundary']);

export const PHASE6_MODEL_CONFIG = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  parameters: {},
});

export const PHASE6_DOCKER_CONFIG = Object.freeze({
  sandbox: 'docker',
  imageOrRuntime: 'node:20-slim',
  networkMode: 'none',
});

export function usesPhase6Docker(taskId: string): boolean {
  return DOCKER_SCENARIO_IDS.has(taskId.slice(taskId.indexOf('/') + 1));
}

export async function executeDeterministicScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  const shortId = task.id.slice(task.id.indexOf('/') + 1);
  if (usesPhase6Docker(task.id)) {
    return sandboxScenario(task, shortId, context);
  }
  if (shortId === 'commit-before-publish' || shortId === 'message-retry') {
    return messageScenario(shortId, context);
  }
  if (shortId === 'bubble-recovery')
    return bubbleScenario(context, deterministicSummaryGenerator());
  if (CONTEXT_SCENARIO_IDS.has(shortId)) return contextScenario();
  throw new Error(`deterministic profile has no Phase 6 driver for ${task.id}`);
}

export async function executeModelScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  if (task.id !== 'phase6/bubble-recovery') {
    throw new Error(`model profile has no Phase 6 driver for ${task.id}`);
  }
  const observation = await bubbleScenario(
    context,
    new HarnessChannelSummaryGenerator({
      deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      provider: PHASE6_MODEL_CONFIG.provider,
      model: PHASE6_MODEL_CONFIG.model,
    }),
  );
  return {
    ...observation,
    efficiency: {
      ...observation.efficiency,
      inputTokens: 'unknown',
      outputTokens: 'unknown',
      costUsd: 'unknown',
      modelCalls: 'unknown',
    },
  };
}

async function sandboxScenario(
  task: AgoraEvalTask,
  id: string,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  const sandbox = new DockerSandbox({
    baseDir: context.workspaceRoot,
    image: PHASE6_DOCKER_CONFIG.imageOrRuntime,
    networkMode: PHASE6_DOCKER_CONFIG.networkMode,
  });
  const taskId = `eval-${id}`;
  let worktreePath: string | undefined;
  context.registerCleanup(async () => {
    await sandbox.teardown(taskId);
    return {
      invariants: {
        'safety.resources-released':
          worktreePath === undefined ? 'unknown' : !existsSync(worktreePath),
      },
    };
  });
  const worktree = await sandbox.createWorktree(taskId, 'CODER');
  worktreePath = worktree.path;
  if (id === 'sandbox-boundary') {
    let rejected = false;
    try {
      await sandbox.write(worktree, '../escape.txt', 'forbidden');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('path escapes sandbox root')) {
        rejected = true;
      } else {
        throw error;
      }
    }
    return {
      assertions: { 'escape.rejected': rejected },
      invariants: { 'safety.path-boundary': rejected },
      efficiency: {
        iterations: 1,
        modelCalls: 0,
        toolCalls: 1,
        repairIterations: 0,
        humanInterventions: 0,
      },
    };
  }
  const broken = id === 'test-repair';
  await sandbox.write(
    worktree,
    'answer.js',
    broken ? 'module.exports = () => 41;\n' : 'module.exports = () => 42;\n',
  );
  await sandbox.write(
    worktree,
    'answer.test.js',
    "const assert=require('node:assert');assert.equal(require('./answer')(),42);\n",
  );
  const testCommand = task.expectedOutcome.testCommand;
  if (testCommand === undefined) throw new Error(`task ${task.id} must declare testCommand`);
  let result = await sandbox.run(worktree, testCommand);
  let repairs = 0;
  if (result.exitCode !== 0 && broken) {
    repairs = 1;
    await sandbox.write(worktree, 'answer.js', 'module.exports = () => 42;\n');
    result = await sandbox.run(worktree, testCommand);
  }
  const inventory = await sandbox.run(worktree, 'find . -type f -print');
  if (inventory.exitCode !== 0) throw new Error('sandbox file inventory failed');
  const files = inventory.stdout
    .split('\n')
    .map((entry) => entry.trim().replace(/^\.\//, ''))
    .filter((entry) => entry.length > 0);
  const state = createInitialAppState(taskId, 'eval', 'eval-project');
  const next = applyMutations(state, [appendMutation('messages', message('state-proof', 'main'))]);
  return {
    testExitCode: result.exitCode ?? 1,
    files,
    assertions: {
      'coding.completed': result.exitCode === 0,
      'repair.completed': result.exitCode === 0 && repairs === 1,
    },
    invariants: {
      'process.state-mutations-only': state.messages.length === 0 && next.messages.length === 1,
      'process.repair-routed': repairs === 1,
      'safety.sandbox-only': isInside(context.workspaceRoot, worktree.path),
    },
    efficiency: {
      iterations: repairs + 1,
      modelCalls: 0,
      toolCalls: broken ? 6 : 4,
      repairIterations: repairs,
      humanInterventions: 0,
    },
  };
}

async function messageScenario(
  id: string,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  const scope = { projectId: 'eval-project', taskId: id };
  const state = new JsonTaskStateStore(context.dataRoot);
  const channels = new JsonProjectChannelStore(context.dataRoot, roles);
  await channels.initialize(scope.projectId, [createMainChannel(roles)]);
  await state.initialize(scope, createInitialAppState(scope.taskId, 'eval', scope.projectId));
  let persistedAtPublish = false;
  let publishes = 0;
  const bus: MessageBus = {
    publish: async (event: MessageCommitted) => {
      publishes += 1;
      persistedAtPublish =
        (await state.load(scope))?.messages.some((entry) => entry.msgId === event.message.msgId) ??
        false;
    },
  };
  const service = new MessageService(state, bus, channels);
  const first = await service.commitMessage(scope, message('logical-message', 'main'));
  const second = await service.commitMessage(scope, message('logical-message', 'main'));
  const stored = await state.load(scope);
  const single = stored?.messages.filter((entry) => entry.msgId === 'logical-message').length === 1;
  return {
    assertions: {
      'message.persisted': first.published && persistedAtPublish,
      'message.single-fact': single && !second.published,
    },
    invariants: {
      'process.commit-before-publish': persistedAtPublish,
      'process.first-write-stays': single && publishes === 1,
    },
    efficiency: {
      iterations: 1,
      modelCalls: 0,
      toolCalls: 0,
      repairIterations: 0,
      humanInterventions: 0,
    },
  };
}

function contextScenario(): EvalObservation {
  const sub: SubChannel = {
    channelId: 'sub-eval',
    kind: 'sub',
    taskId: 'eval-task',
    threadId: 'thread',
    topic: 'private',
    createdBy: 'CODER',
    participants: ['leader', 'CODER'],
    closed: false,
  };
  const project = {
    projectId: 'eval-project',
    revision: 1,
    channels: [createMainChannel(roles), sub],
  };
  const display = 'RAW DISPLAY MUST NOT LEAK';
  const state = {
    ...createInitialAppState('eval-task', 'eval', 'eval-project'),
    messages: [
      message('main-fact', 'main'),
      {
        ...message('sub-fact', 'sub-eval'),
        payload: { reason: 'structured', secret: 'hidden' },
        display,
      },
    ],
  };
  const builder = new DerivedChannelContextBuilder();
  const coder = builder.build(project, state, 'CODER');
  const tester = builder.build(project, state, 'TESTER');
  const encoded = JSON.stringify(coder);
  const coderSub = coder.some((channel) => channel.channelId === 'sub-eval');
  const testerSub = tester.some((channel) => channel.channelId === 'sub-eval');
  const mainScope = tester.find((channel) => channel.channelId === 'main');
  const mainVisible = mainScope?.entries.some((entry) => entry.ref.msgId === 'main-fact') ?? false;
  return {
    assertions: {
      'main.visible': mainVisible,
      'sub.visible-to-member': coderSub,
      'sub.hidden-from-nonparticipant': !testerSub,
      'context.redacted': !encoded.includes(display) && !encoded.includes('hidden'),
    },
    invariants: {
      'process.main-scope': mainVisible,
      'process.sub-task-bound': coderSub,
      'process.participant-isolation': !testerSub,
      'process.no-raw-log': !encoded.includes(display),
      'safety.no-display-leak': !encoded.includes(display) && !encoded.includes('hidden'),
    },
    efficiency: {
      iterations: 1,
      modelCalls: 0,
      toolCalls: 0,
      repairIterations: 0,
      humanInterventions: 0,
    },
  };
}

async function bubbleScenario(
  context: EvalExecutionContext,
  generator: ChannelSummaryGenerator,
): Promise<EvalObservation> {
  const scope = { projectId: 'eval-project', taskId: 'bubble-recovery' };
  const state = new JsonTaskStateStore(context.dataRoot);
  const channels = new JsonProjectChannelStore(context.dataRoot, roles);
  const sub: SubChannel = {
    channelId: 'sub-bubble',
    kind: 'sub',
    taskId: scope.taskId,
    threadId: 'thread',
    topic: 'summary',
    createdBy: 'CODER',
    participants: ['leader', 'CODER'],
    closed: true,
  };
  await channels.initialize(scope.projectId, [createMainChannel(roles), sub]);
  await state.initialize(scope, {
    ...createInitialAppState(scope.taskId, 'eval', scope.projectId),
    messages: [message('source', 'sub-bubble')],
  });
  const published: string[] = [];
  const bus: MessageBus = {
    publish: async ({ message: entry }) => {
      published.push(entry.msgId);
    },
  };
  const service = new MessageService(state, bus, channels);
  const { ChannelSummaryReconciler } = await import('@agora/core-orchestration');
  const reconciler = new ChannelSummaryReconciler({
    channels,
    messages: service,
    state,
    generator,
  });
  await reconciler.reconcile(scope);
  await reconciler.reconcile(scope);
  const snapshot = await channels.load(scope.projectId);
  const stored = await state.load(scope);
  const summaryCount =
    stored?.messages.filter((entry) => entry.msgId === 'channel-bubble:sub-bubble').length ?? 0;
  const bubbled = snapshot?.channels.find(
    (channel): channel is SubChannel =>
      channel.kind === 'sub' && channel.channelId === 'sub-bubble',
  );
  const referenced = bubbled?.bubbledSummaryRef?.msgId === 'channel-bubble:sub-bubble';
  return {
    assertions: { 'summary.recovered': summaryCount === 1 && referenced },
    invariants: {
      'process.message-first-ref-second':
        summaryCount === 1 && referenced && published.length === 1,
    },
    efficiency: {
      iterations: 1,
      modelCalls: 0,
      toolCalls: 0,
      repairIterations: 0,
      humanInterventions: 0,
    },
  };
}

function deterministicSummaryGenerator(): ChannelSummaryGenerator {
  return {
    generate: async (): Promise<ChannelSummary> => ({
      conclusion: 'Recovered',
      keyDecisions: [],
      openQuestions: [],
      sourceMsgIds: ['source'],
    }),
  };
}

function message(msgId: string, channelId: string): Message {
  return {
    msgId,
    channelId,
    fromRole: 'CODER',
    type: 'feedback',
    payload: { reason: 'eval' },
    display: 'eval display',
    ts: 1,
  };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}
