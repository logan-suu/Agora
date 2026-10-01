// Real native candidate, official Harness REVIEWER, D17 Coordinator and D16.
// The acceptance host drives the existing composition/orchestrator directly;
// ordinary start remains read-only for an already persisted task.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { currentCompletionEvidence, setMutation } from '@agora/core-domain';
import {
  type GlobalScheduler,
  materializeHumanGate,
  runOrchestration,
} from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { expect } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createLocalTaskCompositionFactory } from '../../../apps/web/src/server/local-task-composition';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import {
  type TaskCompositionFactory,
  TaskOrchestrationRuntime,
} from '../../../apps/web/src/server/task-orchestration-runtime';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { resolveLiveTestModel } from '../../helpers/live-model';
import type { registrationContext } from './local-linked-workspace-fixture';

export async function exerciseInitialGitReview(
  ctx: Awaited<ReturnType<typeof registrationContext>>,
  sessionOptions: Parameters<typeof LocalWorkspaceSessions.create>[0],
  scheduler: GlobalScheduler,
) {
  const scope = ctx.scope;
  const runtime = new MessageRuntime(
    join(ctx.owner.root, 'tasks'),
    new ChannelStream(),
    DEFAULT_ROSTER,
  );
  const before = await ctx.control.assertClosed(scope);
  await runtime.initializeState(scope, before);
  const live = await resolveLiveTestModel();
  const factory = createLocalTaskCompositionFactory({
    loadState: (s) => runtime.store.load(s),
    bindCompletionVerifier: (verify) => runtime.bindLocalCompletionVerifier(verify),
    scheduler,
    model: live.model,
    executorOptions: { ...live.options, maxToolCallsPerTurn: 20 },
    prepare: async (
      _scope,
      versionForAssignment,
      verifyReviewCandidate,
      verifyAcceptedVersion,
    ) => ({
      local: await LocalWorkspaceSessions.create({
        ...sessionOptions,
        versionForAssignment,
        verifyReviewCandidate,
      }),
      gitWorkspaces: new LocalGitWorkspaces({
        ...ctx,
        verifyReviewCandidate,
        verifyAcceptedVersion,
      }),
      cwd: ctx.root.path,
      sessionRoot: join(
        ctx.owner.root,
        'projects',
        scope.projectId,
        'tasks',
        scope.taskId,
        'harness-sessions',
      ),
      artifactsRoot: join(
        ctx.owner.root,
        'projects',
        scope.projectId,
        'tasks',
        scope.taskId,
        'artifacts',
      ),
    }),
  });
  let compositions = 0;
  const counted: TaskCompositionFactory = async (input) => {
    compositions++;
    return factory(input);
  };
  const transition: Parameters<TaskCompositionFactory>[0]['transition'] = async (
    _state,
    mutations,
  ) => (await runtime.commitMutations(scope, mutations)).state;
  const composition = await counted({
    scope,
    goal: before.goal,
    loadState: () => runtime.store.load(scope),
    transition,
    transitionStep: (_state, role, mutations) =>
      runtime.commitWorkerStepMutations(scope, role, mutations).then((c) => c.state),
    handleOutput: (state, role, output) => runtime.handleWorkerOutput(state, role, output),
    buildChannelContext: (state, role) => runtime.workerStepChannelContextFor(state, role),
    loadRoster: () => runtime.enabledRoleSpecs(scope.projectId),
  });
  let tasks: TaskOrchestrationRuntime | undefined;
  try {
    if (!composition.parallelContext) throw Error('missing_native_parallel_context');
    const candidate = currentCompletionEvidence(before);
    const gated = await runOrchestration(before, {
      workerRuntime: composition.workerRuntime,
      roster: composition.roster,
      transition,
      parallelContext: composition.parallelContext,
      suspendAtHumanGate: async (_state, request) => {
        const paused = await composition.workerRuntime.requestPause({
          scope,
          actionId: request.triggerMsgId,
          reason: request.reason,
          mode: 'human_gate',
        });
        const refs = paused.workers.flatMap((w) =>
          w.status === 'paused' && w.safePointRef ? [w.safePointRef] : [],
        );
        let state: typeof before;
        try {
          state = (
            await runtime.commitMutations(scope, [
              setMutation('humanGate', materializeHumanGate(request, refs)),
            ])
          ).state;
        } catch (error) {
          await composition.workerRuntime.abortPause(paused);
          throw error;
        }
        await composition.workerRuntime.completePause(paused);
        await composition.suspend();
        return state;
      },
    });
    expect(gated.humanGate?.reason).toMatch(/^completion_confirmation:/);
    expect(gated.phase).toBe('review');
    expect(scheduler.activeCount).toBe(0);
    expect(currentCompletionEvidence(gated)).toEqual(candidate);
    expect(gated.workers.filter((w) => w.role !== 'REVIEWER')).toEqual(
      before.workers.filter((w) => w.role !== 'REVIEWER'),
    );
    tasks = new TaskOrchestrationRuntime(runtime, counted);
    const post = () =>
      createPostMessage(runtime)(
        new Request('http://localhost/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...scope,
            channelId: 'main',
            msgId: 'approve-initial-git',
            display: `/resolve-gate ${gated.humanGate?.gateId} approve_completion`,
          }),
        }),
      );
    const response = await post();
    expect(response.status, JSON.stringify(await response.json())).toBe(202);
    await tasks.waitForIdle(scope);
    const completed = await tasks.summary(scope);
    expect(completed, JSON.stringify(completed)).toMatchObject({
      phase: 'done',
      runStatus: 'completed',
    });
    if (!completed?.artifactPath) throw Error('missing_initial_git_artifact');
    expect(readFileSync(join(completed.artifactPath, 'file.txt'), 'utf8')).toBe('working\n');
    expect(readFileSync(join(completed.artifactPath, 'review.test.cjs'), 'utf8')).toContain(
      'strictEqual(2 + 2, 4)',
    );
    const builds = compositions;
    const replay = await post();
    expect(replay.status, JSON.stringify(await replay.json())).toBe(202);
    expect(compositions).toBe(builds);
    const trace = await new HarnessTraceReader(ctx.owner.root).read(scope);
    expect(trace.sessions.filter((s) => s.role === 'REVIEWER')).toHaveLength(1);
    const current = await ctx.control.assertClosed(scope);
    expect(current.localExecution?.delivery?.rounds).toEqual([]);
    return {
      provider: 'opencode-go',
      model: live.model,
      candidate,
      trace,
      approved: true,
      archived: true,
      noExtraRound: true,
      replayCreatedNoComposition: true,
    };
  } catch (error) {
    const state = await runtime.store.load(scope);
    const trace = await new HarnessTraceReader(ctx.owner.root)
      .read(scope)
      .catch((failure: unknown) => ({ error: String(failure) }));
    const directory = resolve('test-outputs/task124/initial-git-review-failures');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${basename(dirname(ctx.owner.root))}.json`),
      JSON.stringify({
        provider: 'opencode-go',
        model: live.model,
        failure: error instanceof Error ? error.message : String(error),
        phase: state?.phase,
        gate: state?.humanGate,
        workers: state?.workers,
        reviewComments: state?.reviewComments,
        testResults: state?.testResults,
        trace,
      }),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await composition.suspend();
    await tasks?.drain();
    await tasks?.disposeAll();
  }
}
