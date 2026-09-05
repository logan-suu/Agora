// R11/G5: only the external paid LLM stream is scripted. State stores, HTTP intent handling,
// Coordinator rules, Harness JSONL persistence, LocalTemp recovery, and trace projection are real.
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  deriveObjectionResolutions,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { decide, latestCoordinationLedger } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import {
  HarnessExecutor,
  HarnessTraceReader,
  project,
  projectTraceInspections,
  type TraceInspection,
} from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
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
  executePhase7DeterministicScenario,
  executePhase7ModelScenario,
  usesPhase7Docker,
} from '../phase7/scenarios';

class ScriptedHarnessAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    const text = 'Deterministic Phase 8 Harness step.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function usesPhase8Docker(taskId: string): boolean {
  return taskId.startsWith('phase7/') || taskId.startsWith('phase6/')
    ? usesPhase7Docker(taskId)
    : false;
}

export async function executePhase8DeterministicScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  if (!task.id.startsWith('phase8/')) return executePhase7DeterministicScenario(task, context);
  switch (task.id) {
    case 'phase8/completion-approval':
      return completionScenario(task, context, 'approve_completion');
    case 'phase8/completion-rework':
      return completionScenario(task, context, 'request_changes');
    case 'phase8/iteration-limit-replay':
      return iterationReplayScenario(task, context);
    case 'phase8/blocking-resolution':
      return blockingResolutionScenario(task, context);
    case 'phase8/advisory-resolution':
      return advisoryResolutionScenario(task, context);
    case 'phase8/durable-restart-fork':
      return durableForkScenario(context);
    case 'phase8/resource-release':
      return resourceReleaseScenario(context);
    case 'phase8/trace-sanitization-integrity':
      return traceScenario(context);
    default:
      throw new Error(`deterministic profile has no Phase 8 driver for ${task.id}`);
  }
}

export async function executePhase8ModelScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  if (!task.id.startsWith('phase8/')) return executePhase7ModelScenario(task, context);
  throw new Error(`model profile has no Phase 8 driver for ${task.id}`);
}

async function completionScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
  option: 'approve_completion' | 'request_changes',
): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: `eval-${option}`, taskId: 'task' };
  runtime.bindHumanGateLifecyclePort({
    suspend: async () => {
      throw new Error('unexpected suspend');
    },
    resume: async () => undefined,
  });
  await runtime.initializeState(scope, approvedReviewState(scope.projectId, scope.taskId));
  const display = requiredLeaderDisplay(task);
  const actionId = option === 'approve_completion' ? 'approve-completion' : 'request-rework';
  await postLeader(runtime, scope, actionId, display);
  const resolved = await requiredState(runtime, scope);
  const resolutionMessage = resolved.messages.find((message) => message.msgId === actionId);
  const receipt = asRecord(resolutionMessage?.payload.resolution);
  await runtime.commitMessage(scope, {
    msgId: `human-gate-resumed:${actionId}`,
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    payload: {
      kind: 'human_gate_resumed',
      actionId,
      gateId: 'human-gate:review-1',
      resumeSessionId: `human-gate-resume:${actionId}`,
    },
    display: 'Human gate resumed.',
    ts: 4,
  });
  const resumed = await requiredState(runtime, scope);
  const decision = decide(resumed, { newId: () => `ledger-${actionId}`, now: () => 5 });
  const after = applyMutations(resumed, decision.mutations);
  const completionDecision = after.decisionLedger.find(
    (entry) => entry.id === `task-completion-resolution:${actionId}`,
  );
  const reviewBound =
    receipt?.gateId === 'human-gate:review-1' &&
    asRecord(resolutionMessage?.payload.completionResolution)?.reviewId === 'review-1';
  const leaderDecision =
    completionDecision?.authority === 'leader' &&
    completionDecision.topic === 'task-completion:task';
  const ledger = latestCoordinationLedger(after);

  if (option === 'approve_completion') {
    return observation(
      { 'completion.approved': decision.route.kind === 'finalize' },
      {
        'process.completion-review-bound': reviewBound,
        'process.completion-leader-decision': leaderDecision,
        'process.resumed-before-finalize':
          resumed.messages.some((message) => message.msgId === `human-gate-resumed:${actionId}`) &&
          ledger?.progress.isRequestSatisfied.answer === true,
      },
      { humanInterventions: 1 },
    );
  }
  return observation(
    {
      'completion.rework-routed':
        decision.route.kind === 'worker' && decision.route.batch[0].role === 'CODER',
    },
    {
      'process.completion-review-bound': reviewBound,
      'process.completion-leader-decision': leaderDecision,
      'process.request-unsatisfied':
        after.phase === 'coding' && decision.requestSatisfied === false,
    },
    { repairIterations: 1, humanInterventions: 1 },
  );
}

async function iterationReplayScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: 'iteration-limit', taskId: 'task' };
  const resumes: string[] = [];
  runtime.bindHumanGateLifecyclePort({
    suspend: async () => {
      throw new Error('unexpected suspend');
    },
    resume: async (_scope, actionId) => {
      resumes.push(actionId);
    },
  });
  await runtime.initializeState(
    scope,
    applyMutations(createInitialAppState(scope.taskId, task.goal, scope.projectId), [
      setMutation('iterationCount', 8),
      setMutation('humanGate', {
        gateId: 'human-gate:limit-1',
        reason: 'iteration_limit',
        options: ['continue'],
        phase: 'testing',
        openedTs: 1,
        safePointRefs: ['safe-1'],
      }),
    ]),
  );
  const display = requiredLeaderDisplay(task);
  await postLeader(runtime, scope, 'continue-limit', display);
  await postLeader(runtime, scope, 'continue-limit', display);
  const state = await requiredState(runtime, scope);
  const messages = state.messages.filter((message) => message.msgId === 'continue-limit');
  return observation(
    { 'iteration-limit.continued': state.iterationCount === 0 && state.humanGate === undefined },
    {
      'process.iteration-reset-atomic':
        state.iterationCount === 0 && messages[0]?.payload.resolution !== undefined,
      'process.resolution-replay-idempotent':
        messages.length === 1 &&
        resumes.length === 2 &&
        state.messages.every((message) => message.type !== 'escalation'),
    },
    { iterations: 8, humanInterventions: 1 },
  );
}

async function blockingResolutionScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: 'blocking', taskId: 'task' };
  runtime.bindHumanGateLifecyclePort({
    suspend: async () => {
      throw new Error('unexpected suspend');
    },
    resume: async () => undefined,
  });
  await runtime.initializeState(
    scope,
    applyMutations(createInitialAppState(scope.taskId, task.goal, scope.projectId), [
      setMutation('phase', 'planning'),
      setMutation('architecture', { modules: ['core'] }),
      mergeByIdMutation('requirements', 'req-1', {
        story: 'Persist before publish.',
        acceptance: ['State is durable.'],
        nonGoals: [],
      }),
      appendMutation('objections', {
        id: 'blocking-1',
        threadId: 'blocking-1',
        fromRole: 'CODER',
        target: { kind: 'requirement', id: 'req-1' },
        claim: 'contradiction',
        argument: 'The shortcut conflicts with durability.',
        track: 'blocking',
        ts: 1,
      }),
      setMutation('humanGate', {
        gateId: 'human-gate:blocking-1',
        reason: 'blocking_objection:blocking-1',
        options: ['accept_objection', 'reject_objection'],
        phase: 'planning',
        openedTs: 1,
        safePointRefs: ['safe-1'],
      }),
    ]),
  );
  await postLeader(runtime, scope, 'resolve-blocking', requiredLeaderDisplay(task));
  const state = await requiredState(runtime, scope);
  const view = deriveObjectionResolutions(state).find(
    (entry) => entry.objectionId === 'blocking-1',
  );
  const route = decide(state, { newId: () => 'ledger-blocking', now: () => 3 }).route;
  return observation(
    { 'objection.blocking-resolved': view?.status === 'resolved' },
    {
      'process.blocking-gate-bound': state.humanGate === undefined && route.kind !== 'human_gate',
      'process.objection-leader-authority': state.decisionLedger.some(
        (entry) =>
          entry.id === 'objection-resolution:resolve-blocking' && entry.authority === 'leader',
      ),
    },
    { humanInterventions: 1 },
  );
}

async function advisoryResolutionScenario(
  task: AgoraEvalTask,
  context: EvalExecutionContext,
): Promise<EvalObservation> {
  const runtime = createMessageRuntime(context.dataRoot, new ChannelStream());
  const scope = { projectId: 'advisory', taskId: 'task' };
  await runtime.initializeState(
    scope,
    applyMutations(createInitialAppState(scope.taskId, task.goal, scope.projectId), [
      appendMutation('objections', {
        id: 'advisory-1',
        threadId: 'advisory-1',
        fromRole: 'ARCHITECT',
        claim: 'concern',
        argument: 'Prefer a clearer name.',
        track: 'advisory',
        ts: 1,
      }),
    ]),
  );
  await postLeader(runtime, scope, 'resolve-advisory', requiredLeaderDisplay(task));
  const state = await requiredState(runtime, scope);
  const view = deriveObjectionResolutions(state).find(
    (entry) => entry.objectionId === 'advisory-1',
  );
  const route = decide(state, { newId: () => 'ledger-advisory', now: () => 3 }).route;
  return observation(
    { 'objection.advisory-resolved': view?.status === 'resolved' },
    {
      'process.advisory-nonblocking': route.kind !== 'human_gate',
      'process.objection-leader-authority': state.decisionLedger.some(
        (entry) =>
          entry.id === 'objection-resolution:resolve-advisory' && entry.authority === 'leader',
      ),
    },
    { humanInterventions: 1 },
  );
}

async function durableForkScenario(context: EvalExecutionContext): Promise<EvalObservation> {
  const result = await createHarnessFork(context, 'durable-fork', 'ordinary goal');
  return observation(
    { 'resume.lineage-child-created': result.child?.parentSessionId === result.parentSessionId },
    {
      'process.session-prefix-preserved': result.child?.seedLength !== undefined,
      'process.fork-lineage-bound':
        result.child?.sessionId === 'durable-fork-child' && result.child.turns.length === 1,
    },
    { modelCalls: 2 },
  );
}

async function resourceReleaseScenario(context: EvalExecutionContext): Promise<EvalObservation> {
  const first = new LocalTempSandbox();
  const second = new LocalTempSandbox();
  const taskId = 'resource-release';
  const worktree = await first.createWorktree(taskId, 'shared');
  let terminallyReleased = false;
  context.registerCleanup(async () => {
    if (!terminallyReleased) await first.teardown(taskId).catch(() => undefined);
    await second.teardown(taskId).catch(() => undefined);
    return undefined;
  });
  await first.write(worktree, 'proof.txt', 'durable');
  await first.suspend(taskId);
  await second.resume(taskId, [{ role: 'shared', worktree }]);
  const recovered = (await second.read(worktree, 'proof.txt')) === 'durable';
  await second.teardown(taskId);
  terminallyReleased = true;
  let removed = false;
  try {
    await access(worktree.path);
  } catch {
    removed = true;
  }
  return observation(
    { 'resources.released': recovered && removed },
    {
      'process.worktree-recoverable': recovered,
      'safety.terminal-path-removed': removed,
    },
  );
}

async function traceScenario(context: EvalExecutionContext): Promise<EvalObservation> {
  const result = await createHarnessFork(context, 'traceNone', 'TRACE_PROJECTION_SECRET');
  const encoded = JSON.stringify(result.trace);
  let damageRejected = false;
  try {
    projectTraceInspections('project', 'task', [
      {
        meta: {
          version: 0,
          id: 'damaged',
          createdAt: 1,
          agentPreset: 'agora-role:CODER',
        },
        events: [{ seq: 0, time: 1, type: 'step/end', data: { turn: 1, step: 1 } }],
      } as unknown as TraceInspection,
    ]);
  } catch {
    damageRejected = true;
  }
  const redacted = !/TRACE_PROJECTION_SECRET|arguments|reasoning|result/i.test(encoded);
  return observation(
    { 'trace.safe': result.trace.sessions.length >= 2 && redacted },
    {
      'safety.trace-redacted': redacted,
      'process.trace-damage-fail-closed': damageRejected,
    },
    { modelCalls: 2 },
  );
}

async function createHarnessFork(context: EvalExecutionContext, id: string, goal: string) {
  const sandbox = new LocalTempSandbox();
  const taskId = `${id}-task`;
  const projectId = `${id}-project`;
  const worktree = await sandbox.createWorktree(taskId, 'shared');
  context.registerCleanup(async () => {
    await sandbox.teardown(taskId).catch(() => undefined);
    return undefined;
  });
  const coder = DEFAULT_ROSTER.find((entry) => entry.role === 'CODER');
  if (coder === undefined) throw new Error('CODER role is missing');
  const adapter = new ScriptedHarnessAdapter();
  const root = join(context.dataRoot, 'projects', projectId, 'tasks', taskId, 'harness-sessions');
  const persistence = { root, cwd: worktree.path, projectId, taskId };
  const state = createInitialAppState(taskId, goal, projectId);
  const source = new HarnessExecutor(coder, {
    adapter,
    provider: 'phase8-eval',
    sessionPersistence: persistence,
  });
  await source.step({ sessionId: `${id}-parent`, view: project(state, 'CODER', DEFAULT_ROSTER) });
  const ref = await source.saveSafePoint();
  await source.dispose();
  const child = new HarnessExecutor(coder, {
    adapter,
    provider: 'phase8-eval',
    sessionPersistence: { ...persistence, resumeSessionId: `${id}-child` },
  });
  await child.loadSafePoint(ref);
  await child.step({ sessionId: `${id}-child`, view: project(state, 'CODER', DEFAULT_ROSTER) });
  await child.dispose();
  const trace = await new HarnessTraceReader(context.dataRoot).read({ projectId, taskId });
  const childView = trace.sessions.find((session) => session.sessionId === `${id}-child`);
  return { trace, child: childView, parentSessionId: `${id}-parent` };
}

function approvedReviewState(projectId: string, taskId: string) {
  return applyMutations(createInitialAppState(taskId, 'Confirm completion', projectId), [
    setMutation('phase', 'review'),
    mergeByIdMutation('subtasks', 'work-1', {
      title: 'Complete the task',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'done',
    }),
    appendMutation('messages', {
      msgId: 'review-dispatch',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      payload: { nextRole: 'REVIEWER', reviewCommentCursor: 0 },
      display: 'Review',
      ts: 1,
    }),
    appendMutation('reviewComments', {
      id: 'review-1',
      kind: 'verdict',
      verdict: 'approved',
    }),
    setMutation('humanGate', {
      gateId: 'human-gate:review-1',
      reason: 'completion_confirmation:review-1',
      options: ['approve_completion', 'request_changes'],
      phase: 'review',
      openedTs: 2,
      safePointRefs: ['safe-1'],
    }),
  ]);
}

function requiredLeaderDisplay(task: AgoraEvalTask): string {
  const display = task.leaderEvents?.[0]?.display;
  if (display === undefined) throw new Error(`task ${task.id} requires a scripted Leader event`);
  return display;
}

async function postLeader(
  runtime: MessageRuntime,
  scope: { projectId: string; taskId: string },
  msgId: string,
  display: string,
): Promise<void> {
  const response = await createPostMessage(runtime)(
    new Request('http://localhost/api/messages', {
      method: 'POST',
      body: JSON.stringify({ ...scope, channelId: 'main', msgId, display, ts: 3 }),
    }),
  );
  const body = (await response.json()) as { action?: { status?: string } };
  if (body.action?.status !== 'applied')
    throw new Error(`Leader action was not applied: ${display}`);
}

async function requiredState(
  runtime: MessageRuntime,
  scope: { projectId: string; taskId: string },
) {
  const state = await runtime.store.load(scope);
  if (state === undefined) throw new Error('expected persisted Eval task state');
  return state;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
