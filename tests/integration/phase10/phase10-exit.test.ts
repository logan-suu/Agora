// Only external model responses/timing are scripted, including the tool-free
// interpreter. HTTP, SSE, Harness, pause/Fork, Git/Docker and validation are real.
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  latestCoordinationLedger,
  mergeByIdMutation,
  requirementProposalView,
  validationReceipt,
} from '@agora/core-domain';
import {
  GlobalScheduler,
  type HumanGateLifecyclePort,
  type WorkerRuntime,
} from '@agora/core-orchestration';
import { HarnessRequirementInterpreter, HarnessTraceReader } from '@agora/runtime-executor';
import { Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import { expect, it, onTestFinished } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createGetStream, createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { createPostTask } from '../../../apps/web/src/server/task-handlers';
import {
  type TaskComposition,
  TaskOrchestrationRuntime,
} from '../../../apps/web/src/server/task-orchestration-runtime';
import { finishWithCleanup } from './cleanup';
import { EXIT_FEEDBACK, EXIT_GOAL, ExitAdapter } from './exit-fixture';
import { waitForExitStage } from './exit-wait';

async function fixture(taskId: string, adapter = new ExitAdapter()) {
  const root = await mkdtemp(join(tmpdir(), 'agora-phase10-exit-'));
  const scope = { projectId: 'phase10-exit', taskId };
  const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
  const docker = new Dockerode(existsSync(socket) ? { socketPath: socket } : {});
  const messages = createMessageRuntime(root, new ChannelStream());
  const scheduler = new GlobalScheduler({ cap: 3 });
  const compositions: TaskComposition[] = [];
  let worker: WorkerRuntime | undefined;
  let lifecycle: HumanGateLifecyclePort | undefined;
  const bind = messages.bindHumanGateLifecyclePort.bind(messages);
  messages.bindHumanGateLifecyclePort = (port) => {
    lifecycle = port;
    bind(port);
  };
  messages.bindRequirementInterpreter({
    interpret: async (input) => {
      const lease = await scheduler.acquire(
        input.projectId,
        input.taskId,
        `leader-input:${input.sourceMsgId}`,
      );
      try {
        const taskRoot = join(root, 'projects', input.projectId, 'tasks', input.taskId);
        return await new HarnessRequirementInterpreter('exit-model', {
          adapter,
          provider: 'phase10-exit',
          deepseek: false,
          sessionPersistence: { root: join(taskRoot, 'harness-sessions'), cwd: taskRoot, ...scope },
        }).interpret(input);
      } finally {
        scheduler.release(lease);
      }
    },
  });
  const factory = createWebTaskCompositionFactory({
    dataRoot: root,
    scheduler,
    sandboxConfig: { kind: 'docker', docker },
    executorOptions: { adapter, provider: 'phase10-exit', deepseek: false },
  });
  const runtime = new TaskOrchestrationRuntime(messages, async (input) => {
    const composition = await factory(input);
    compositions.push(composition);
    worker = composition.workerRuntime;
    return composition;
  });
  const post = createPostMessage(messages);
  const send = (msgId: string, display: string, extra: Record<string, unknown> = {}) =>
    post(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({ ...scope, channelId: 'main', msgId, display, ...extra }),
      }),
    );
  const state = async () => {
    const value = await messages.store.load(scope);
    if (!value) throw new Error('Missing canonical state');
    return value;
  };
  const waiting = new AbortController();
  const waitStage = (entered: Promise<void>, name: string, timeoutMs?: number) =>
    waitForExitStage(
      entered,
      name,
      async () => {
        const summary = await runtime.summary(scope);
        return summary && ['failed', 'completed', 'interrupted'].includes(summary.runStatus)
          ? `${summary.runStatus}: ${summary.error ?? summary.phase}`
          : undefined;
      },
      timeoutMs,
      waiting.signal,
    );
  const start = async () => {
    await docker.ping();
    const response = await createPostTask(runtime)(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ ...scope, goal: EXIT_GOAL, requestId: 'start' }),
      }),
    );
    expect(response.status).toBe(202);
    await waitStage(adapter.coders.entered, 'CODERs');
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      // Cancel only test-side entry waits, never a Harness model request.
      waiting.abort(new Error('Fixture cleanup started'));
      adapter.releaseAll();
      await finishWithCleanup(
        [],
        [
          () => runtime.drain(),
          // Drain can create a resumed composition; take the disposal list afterward.
          () =>
            finishWithCleanup(
              [],
              compositions.map((c) => () => c.dispose()),
            ),
          () => rm(root, { recursive: true, force: true }),
        ],
      );
    })());
  // Runner timeouts do not unwind the suspended test body. This hook releases
  // scripted barriers and joins the same cleanup used by the ordinary finally.
  onTestFinished(cleanup, 60_000);
  return {
    root,
    scope,
    docker,
    messages,
    scheduler,
    adapter,
    runtime,
    factory,
    send,
    state,
    start,
    waitStage,
    cleanup,
    get worker() {
      return worker;
    },
    get lifecycle() {
      return lifecycle;
    },
  };
}

async function applied(response: Response) {
  expect(response.status, await response.clone().text()).toBe(202);
  expect(await response.json()).toMatchObject({ action: { status: 'applied' } });
}
function confirmation(proposalId: string) {
  return { requirementProposal: { proposalId, action: 'confirm' } };
}
async function testsAt(path: string) {
  return new Map(
    await Promise.all(
      (await readdir(path))
        .filter((p) => p.endsWith('.test.mjs'))
        .map(async (p) => [p, await readFile(join(path, p), 'utf8')] as const),
    ),
  );
}

it('confirms natural input at real safe points, Forks validation, invalidates receipts and preserves cumulative evidence through Leader rework and archive', async () => {
  const f = await fixture('natural-exit');
  const errors: unknown[] = [];
  const abort = new AbortController();
  let streamRead: Promise<string> | undefined;
  const fresh = new DockerSandbox({ docker: f.docker, baseDir: f.root });
  let streamCleanup: Promise<void> | undefined;
  const cleanupStream = () =>
    (streamCleanup ??= (async () => {
      abort.abort();
      await finishWithCleanup([], [() => streamRead, () => fresh.teardown('exit-verification')]);
    })());
  onTestFinished(cleanupStream, 60_000);
  try {
    await f.start();
    expect(f.scheduler.activeCount).toBe(2);
    const response = await createGetStream(f.messages)(
      new Request(
        `http://localhost/api/stream?projectId=${f.scope.projectId}&taskId=${f.scope.taskId}&channelId=main`,
        { signal: abort.signal },
      ),
    );
    streamRead = response.text();
    const before = await f.state();
    expect((await f.send('price-input', 'Change the price to 4 and update the sum.')).status).toBe(
      202,
    );
    expect((await f.state()).requirements).toEqual(before.requirements);
    const proposal = requirementProposalView(await f.state());
    expect(proposal?.changes).toHaveLength(2);
    const otherScope = { projectId: f.scope.projectId, taskId: 'other-task' };
    await f.messages.initialize(otherScope, 'Another isolated task');
    expect(
      (
        await f.send('cross-task-confirm', 'Confirm these requirement changes.', {
          ...confirmation('requirement-proposal:price-input'),
          ...otherScope,
        })
      ).status,
    ).toBe(409);
    expect((await f.messages.store.load(otherScope))?.requirements).toEqual([]);
    const confirm = f.send(
      'confirm-price',
      'Confirm these requirement changes.',
      confirmation('requirement-proposal:price-input'),
    );
    await expect.poll(() => f.worker?.hasActivePause).toBe(true);
    expect((await f.state()).requirements).toEqual(before.requirements);
    f.adapter.coders.release();
    await applied(await confirm);
    await applied(
      await f.send(
        'confirm-price',
        'Confirm these requirement changes.',
        confirmation('requirement-proposal:price-input'),
      ),
    );
    expect(f.adapter.interpretations).toBe(1);
    expect((await f.state()).requirements.map((r) => r.acceptance)).toEqual([
      ['a equals 4.'],
      ['sum equals 7.'],
    ]);
    await f.waitStage(f.adapter.validation.entered, 'TESTER');
    const prePause = await f.state();
    const dispatch = prePause.parallelExecution?.activeWave?.validation;
    const paused = f.lifecycle?.suspend(f.scope, {
      triggerMsgId: 'exit-validation-pause',
      triggerTs: Date.now(),
      reason: 'iteration_limit',
      options: ['continue'],
      phase: 'testing',
    });
    if (!paused) throw new Error('Missing production lifecycle');
    f.adapter.validation.release();
    await paused;
    await f.runtime.waitForIdle(f.scope);
    const atGate = await f.state();
    expect(atGate.workers.find((w) => w.workerId === dispatch?.workerId)?.status).toBe('paused');
    expect(atGate.humanGate?.safePointRefs).toHaveLength(1);
    expect(f.scheduler.activeCount).toBe(0);
    expect(
      existsSync(
        join(f.root, 'projects', f.scope.projectId, 'tasks', f.scope.taskId, 'artifacts/worktree'),
      ),
    ).toBe(false);
    await applied(
      await f.send(
        'continue-validation',
        '/resolve-gate human-gate:exit-validation-pause continue',
      ),
    );
    await f.waitStage(f.adapter.review.entered, 'REVIEWER');
    const reviewed = await f.state();
    const oldId = reviewed.parallelExecution?.acceptedReceiptId as string;
    const oldReceipt = validationReceipt(reviewed, oldId);
    const oldTests = await testsAt(oldReceipt.worktree.path);
    expect(oldReceipt.results).toMatchObject({ passed: true, total: 5 });
    // A second coherent change invalidates the control fingerprint without making
    // the existing functional assertions obsolete or rewriting inherited tests.
    expect(
      (await f.send('contract-input', 'Explicitly retain both established module contracts.'))
        .status,
    ).toBe(202);
    const reconfirm = f.send(
      'confirm-contract',
      'Confirm these requirement changes.',
      confirmation('requirement-proposal:contract-input'),
    );
    await expect.poll(() => f.worker?.hasActivePause).toBe(true);
    f.adapter.review.release();
    await applied(await reconfirm);
    await f.runtime.waitForIdle(f.scope);
    let state = await f.state();
    expect(state.humanGate?.reason, JSON.stringify(await f.runtime.summary(f.scope))).toBe(
      'completion_confirmation:exit-review-2',
    );
    expect(latestCoordinationLedger(state)?.progress.isRequestSatisfied.answer).toBe(false);
    const current = validationReceipt(state, state.parallelExecution?.acceptedReceiptId as string);
    expect(current.inputCommit).toBe(oldReceipt.worktree.headCommit);
    expect(current.controlFingerprint).not.toBe(oldReceipt.controlFingerprint);
    for (const [path, value] of oldTests)
      expect(await readFile(join(current.worktree.path, path), 'utf8')).toBe(value);
    expect(current.results.total).toBe(8);
    expect(state.messages.filter((m) => m.payload.kind === 'coding_wave')).toHaveLength(2);
    expect(
      (
        await f.send(
          'gate-confirm',
          'Confirm these requirement changes.',
          confirmation('requirement-proposal:contract-input'),
        )
      ).status,
    ).toBe(409);
    await applied(
      await f.send(
        'leader-rework',
        `/resolve-gate ${state.humanGate?.gateId} request_changes ${EXIT_FEEDBACK}`,
      ),
    );
    await f.runtime.waitForIdle(f.scope);
    state = await f.state();
    expect(state.humanGate?.reason, JSON.stringify(await f.runtime.summary(f.scope))).toBe(
      'completion_confirmation:exit-review-3',
    );
    const feedback = f.adapter.views.filter(
      (v) => v.slices.completionFeedback?.rationale === EXIT_FEEDBACK,
    );
    expect(new Set(feedback.map((v) => v.role))).toEqual(new Set(['CODER', 'TESTER', 'REVIEWER']));
    expect(feedback.every((v) => v.slices.completionFeedback?.resumed)).toBe(true);
    const accepted = validationReceipt(state, state.parallelExecution?.acceptedReceiptId as string);
    const retained = await testsAt(accepted.worktree.path);
    for (const [path, value] of oldTests) expect(retained.get(path)).toBe(value);
    const acceptedHead = accepted.worktree.headCommit;
    const sourceFiles = new Map(
      await Promise.all(
        (await readdir(accepted.worktree.path))
          .filter((path) => path.endsWith('.mjs'))
          .map(async (path) => [path, await readFile(join(accepted.worktree.path, path))] as const),
      ),
    );
    await applied(
      await f.send('approve-exit', `/resolve-gate ${state.humanGate?.gateId} approve_completion`),
    );
    await f.runtime.waitForIdle(f.scope);
    state = await f.state();
    expect(state.phase).toBe('done');
    expect(latestCoordinationLedger(state)?.progress.isRequestSatisfied.answer).toBe(true);
    expect(state.humanGate).toBeUndefined();
    expect(
      state.messages.find((m) => m.msgId === 'approve-exit')?.payload.resolution,
    ).toMatchObject({
      completionEvidence: { validationReceiptId: state.parallelExecution?.acceptedReceiptId },
    });
    expect(
      (
        await f.send(
          'done-confirm',
          'Confirm these requirement changes.',
          confirmation('requirement-proposal:contract-input'),
        )
      ).status,
    ).toBe(409);
    const summary = await new TaskOrchestrationRuntime(
      createMessageRuntime(f.root, new ChannelStream()),
      f.factory,
    ).summary(f.scope);
    expect(summary).toMatchObject({ runStatus: 'completed', phase: 'done' });
    const artifact = summary?.artifactPath as string;
    expect((await readdir(artifact)).sort()).toEqual([...sourceFiles.keys()].sort());
    for (const [path, bytes] of sourceFiles)
      expect(await readFile(join(artifact, path))).toEqual(bytes);
    for (const [path, value] of retained)
      expect(await readFile(join(artifact, path), 'utf8')).toBe(value);
    expect(await readFile(join(artifact, 'a.mjs'), 'utf8')).toBe('export const a = 4;\n');
    expect(
      validationReceipt(state, state.parallelExecution?.acceptedReceiptId as string).worktree
        .headCommit,
    ).toBe(acceptedHead);
    const target = await fresh.createWorktree('exit-verification', 'verify');
    await cp(artifact, target.path, { recursive: true });
    const rerun = await fresh.run(target, 'node --test --test-reporter=tap *.test.mjs');
    expect(rerun).toMatchObject({ exitCode: 0, timedOut: false });
    expect(rerun.stdout).toContain(`# tests ${accepted.results.total}`);
    expect(rerun.stdout).toContain('# fail 0');
    const trace = await new HarnessTraceReader(f.root).read(f.scope);
    const children = trace.sessions.filter((s) => s.parentSessionId !== undefined);
    expect(children).toHaveLength(1);
    expect(children[0]?.role).toBe('TESTER');
    expect(children[0]?.seedLength).toBeGreaterThan(0);
    expect(
      trace.sessions.some((session) => session.sessionId === children[0]?.parentSessionId),
    ).toBe(true);
    const coderTurns = trace.sessions.filter((s) => s.role === 'CODER').flatMap((s) => s.turns);
    expect(
      coderTurns.some((a, i) =>
        coderTurns.some(
          (b, j) => i !== j && a.startedAt < (b.endedAt ?? 0) && b.startedAt < (a.endedAt ?? 0),
        ),
      ),
    ).toBe(true);
    expect(f.scheduler.activeCount).toBe(0);
    expect(
      await readdir(
        join(f.root, 'projects', f.scope.projectId, 'tasks', f.scope.taskId, 'worktrees'),
      ),
    ).toEqual([]);
    abort.abort();
    const wire = await streamRead;
    expect(wire).not.toContain('"payload":');
    const envelopes = wire
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    const ids = new Set(envelopes.flat().map((e: { msgId?: string }) => e.msgId));
    for (const m of state.messages.filter((m) => m.channelId === 'main'))
      expect(ids.has(m.msgId)).toBe(true);
    expect(f.adapter.observedRuns).toBeGreaterThan(10);
    if (process.env.AGORA_PHASE10_EXIT_EVIDENCE_DIR)
      await cp(f.root, process.env.AGORA_PHASE10_EXIT_EVIDENCE_DIR, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
  } catch (error) {
    errors.push(error);
  } finally {
    await finishWithCleanup(errors, [cleanupStream, () => f.cleanup()]);
  }
}, 120_000);

it('rejects a proposal whose facts change while the real active cohort drains without partially applying related requirements', async () => {
  const f = await fixture('stale-exit');
  const errors: unknown[] = [];
  try {
    await f.start();
    expect((await f.send('stale-input', 'Change the price to 4 and update the sum.')).status).toBe(
      202,
    );
    const before = await f.state();
    const confirming = f.send(
      'stale-confirm',
      'Confirm these requirement changes.',
      confirmation('requirement-proposal:stale-input'),
    );
    await expect.poll(() => f.worker?.hasActivePause).toBe(true);
    // Simulate another authorized serial control commit while model Steps drain;
    // use the real canonical queue, not a fake pause port or direct State write.
    await f.messages.commitMutations(f.scope, [
      mergeByIdMutation('requirements', 'price', { story: 'The established price remains 2.' }),
    ]);
    f.adapter.releaseAll();
    expect((await confirming).status).toBe(409);
    await f.runtime.waitForIdle(f.scope);
    const after = await f.state();
    expect(after.requirements.find((r) => r.id === 'sum')).toEqual(
      before.requirements.find((r) => r.id === 'sum'),
    );
    expect(after.requirements.find((r) => r.id === 'price')?.acceptance).toEqual(['a equals 2.']);
    expect(after.messages.some((m) => m.msgId === 'stale-confirm')).toBe(false);
    expect(latestCoordinationLedger(after)?.progress.isRequestSatisfied.answer).toBe(false);
    expect(after.humanGate?.reason).toBe('completion_confirmation:exit-review-1');
    expect(f.scheduler.activeCount).toBe(0);
  } catch (error) {
    errors.push(error);
  } finally {
    await finishWithCleanup(errors, [() => f.cleanup()]);
  }
}, 90_000);

it('reports a pre-CODER runtime failure and removes the real fixture resources', async () => {
  const f = await fixture('failed-entry', new ExitAdapter('PM'));
  try {
    await expect(f.start()).rejects.toThrow(/CODERs not reached: failed/);
  } finally {
    await f.cleanup();
  }
  expect(f.scheduler.activeCount).toBe(0);
  expect(existsSync(f.root)).toBe(false);
}, 60_000);

it('releases blocked real workers when a stage deadline rejects and cleanup runs', async () => {
  const f = await fixture('missing-entry');
  try {
    await f.start();
    expect(f.scheduler.activeCount).toBe(2);
    await expect(f.waitStage(new Promise(() => {}), 'unreachable stage', 25)).rejects.toThrow(
      'Timed out waiting for unreachable stage',
    );
  } finally {
    await f.cleanup();
  }
  expect(f.adapter.observedRuns).toBeGreaterThan(0);
  expect(f.scheduler.activeCount).toBe(0);
  expect(existsSync(f.root)).toBe(false);
}, 60_000);
