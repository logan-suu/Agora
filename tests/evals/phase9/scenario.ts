import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AppState, validationReceipt } from '@agora/core-domain';
import {
  GlobalScheduler,
  type HumanGateResolutionReceipt,
  type SlotLease,
} from '@agora/core-orchestration';
import { HarnessTraceReader } from '@agora/runtime-executor';
import { Dockerode, DockerSandbox, type RunResult } from '@agora/runtime-sandbox';
import { SecureFiles } from '@agora/runtime-sandbox/secure-files';
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { createPostTask } from '../../../apps/web/src/server/task-handlers';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';
import { acceptanceSource, GOAL, PLAN } from '../fixtures/phase9/contract';
import type { MeteredFlashAdapter } from './model-adapter';
import { passesWideProcess, type ValidationOutcome } from './wide-grader';

class ObservedScheduler extends GlobalScheduler {
  peak = 0;
  readonly intervals = new Map<string, { workerId: string; start: number; end?: number }>();
  override async acquire(project: string, task: string, worker: string, signal?: AbortSignal) {
    const lease = await super.acquire(project, task, worker, signal);
    this.peak = Math.max(this.peak, this.activeCount);
    if (!this.intervals.has(lease.leaseId))
      this.intervals.set(lease.leaseId, { workerId: worker, start: lease.grantedTs });
    return lease;
  }
  override async release(lease: SlotLease) {
    await super.release(lease);
    const interval = this.intervals.get(lease.leaseId);
    if (interval && interval.end === undefined) interval.end = Date.now();
  }
}

export async function runWideFlow(options: {
  root: string;
  cap: number;
  adapter: LlmAdapter;
  meter?: MeteredFlashAdapter;
  imageId?: string;
}) {
  const socket = join(process.env.HOME ?? '', '.docker/run/docker.sock');
  const docker = new Dockerode(existsSync(socket) ? { socketPath: socket } : {});
  await docker.ping();
  const imageId: string = (await docker.getImage(options.imageId ?? 'node:20-slim').inspect()).Id;
  await mkdir(options.root, { recursive: true });
  const physicalRoot = await realpath(options.root);
  const scope = { projectId: 'agora', taskId: 'wide-pipeline' };
  const taskRoot = join(options.root, 'projects', scope.projectId, 'tasks', scope.taskId);
  const scheduler = new ObservedScheduler({ cap: options.cap });
  const cleanups: (() => Promise<unknown>)[] = [];
  const times = {
    start: Date.now(),
    gate: 0,
    approve: 0,
    archive: 0,
    verificationStart: 0,
    verificationEnd: 0,
    cleanupStart: 0,
    cleanupEnd: 0,
  };
  const resources = {
    containerPeak: 0,
    retainedWorktreePeak: 0,
    compositionPeak: 0,
    sampleIntervalMs: 200,
    samples: 0,
    retainedLogicalBytesPeak: 0,
    retainedAllocatedBytesPeak: 0,
    fileMeasurementMisses: 0,
    finalTaskLogicalBytes: 0,
    finalTaskAllocatedBytes: 0,
    finalLinkedWorktrees: 0,
    stagedWorktreeBytes: 'unknown',
    cpuUsage: 'unknown',
    memoryUsage: 'unknown',
    measurementScope:
      'Task directory plus task-mounted containers; shared teardown staging, CPU and memory usage are not sampled.',
  };
  const cleanupIntervals: { kind: string; start: number; end: number }[] = [];
  let compositions = 0,
    stopped = false;
  const sample = async () => {
    const containers = await docker.listContainers({ all: true });
    resources.containerPeak = Math.max(
      resources.containerPeak,
      containers.filter((item) => item.Mounts.some((m) => m.Source.includes(physicalRoot))).length,
    );
    try {
      resources.retainedWorktreePeak = Math.max(
        resources.retainedWorktreePeak,
        (await readdir(join(taskRoot, 'worktrees'), { withFileTypes: true })).filter((entry) =>
          entry.isDirectory(),
        ).length,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    resources.samples++;
    if (existsSync(taskRoot)) {
      try {
        const disk = new SecureFiles(taskRoot).measure();
        resources.retainedLogicalBytesPeak = Math.max(
          resources.retainedLogicalBytesPeak,
          disk.logicalBytes,
        );
        resources.retainedAllocatedBytesPeak = Math.max(
          resources.retainedAllocatedBytesPeak,
          disk.allocatedBytes,
        );
      } catch (error) {
        if (error instanceof Error && /No such file|directory changed/.test(error.message))
          resources.fileMeasurementMisses++;
        else throw error;
      }
    }
  };
  let sampleFailure: unknown;
  const sampling = (async () => {
    while (!stopped) {
      try {
        await sample();
      } catch (error) {
        sampleFailure = error;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  const result: {
    status: string;
    failure?: string;
    waves: string[][];
    leasePeak: number;
    finalLeaseCount: number;
    validationTotals: number[];
    validationOutcomes: ValidationOutcome[];
    processPassed: boolean;
    traceCoderSessions: number;
    traceForks: number;
    traceOmittedEvents: number;
    integrationConflicts: number;
    imageId: string;
    completionBound: boolean;
    freshVerification: RunResult;
    iterations: number;
    repairIterations: number;
    times: typeof times;
    resources: typeof resources;
    cleanupErrors: string[];
    leaseIntervals: unknown[];
    cleanupIntervals: typeof cleanupIntervals;
  } = {
    status: 'not-started',
    waves: [],
    leasePeak: 0,
    finalLeaseCount: 0,
    validationTotals: [],
    validationOutcomes: [],
    processPassed: false,
    traceCoderSessions: 0,
    traceForks: 0,
    traceOmittedEvents: 0,
    integrationConflicts: 0,
    imageId,
    completionBound: false,
    freshVerification: { exitCode: null, stdout: '', stderr: 'not executed', timedOut: false },
    iterations: 0,
    repairIterations: 0,
    times,
    resources,
    cleanupErrors: [],
    leaseIntervals: [],
    cleanupIntervals,
  };
  const messages = createMessageRuntime(options.root, new ChannelStream());
  const meter = options.meter;
  const baseFactory = createWebTaskCompositionFactory({
    dataRoot: options.root,
    scheduler,
    sandboxConfig: { kind: 'docker', docker, image: imageId },
    executorOptions: {
      adapter: options.adapter,
      provider: 'phase9-eval',
      deepseek: false,
      ...(meter === undefined ? {} : { approval: () => meter.approveTool() }),
    },
  });
  const runtime = new TaskOrchestrationRuntime(messages, async (input) => {
    const composition = await baseFactory(input);
    compositions++;
    resources.compositionPeak = Math.max(resources.compositionPeak, compositions);
    let released = false;
    const release = async (terminal: boolean) => {
      const start = Date.now();
      await (terminal ? composition.dispose() : composition.suspend());
      if (!released) {
        cleanupIntervals.push({ kind: terminal ? 'terminal' : 'suspend', start, end: Date.now() });
        released = true;
        compositions--;
      }
    };
    cleanups.push(() => release(false));
    return {
      ...composition,
      archiveArtifact: async () => {
        const artifact = await composition.archiveArtifact();
        times.archive = Date.now();
        return artifact;
      },
      suspend: () => release(false),
      dispose: () => release(true),
    };
  });
  try {
    const response = await createPostTask(runtime)(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...scope, requestId: 'start', goal: GOAL }),
      }),
    );
    assert.equal(response.status, 202, await response.text());
    await runtime.waitForIdle(scope);
    let state = await messages.store.load(scope);
    assert(state);
    const before = await runtime.summary(scope);
    assert(before, 'runtime summary is missing');
    assert.match(
      state.humanGate?.reason ?? '',
      /^completion_confirmation:/,
      JSON.stringify({
        runStatus: before.runStatus,
        phase: before.phase,
        currentRole: before.currentRole,
        error: before.error,
      }),
    );
    times.gate = Date.now();
    await sample();
    assert.deepEqual(
      state.subtasks.map((x) => ({ id: x.id, dependsOn: x.dependsOn })),
      PLAN.subtasks.map((x) => ({ id: x.id, dependsOn: x.dependsOn })),
      'model changed the fixed DAG',
    );
    result.waves = state.messages
      .filter((m) => m.payload.kind === 'coding_wave')
      .map((m) => m.payload.subtaskIds as string[]);
    const receipts = state.messages
      .filter((m) => m.payload.kind === 'wave_validation')
      .map((m) => validationReceipt(state as AppState, m.msgId));
    result.validationTotals = receipts.map((x) => x.results.total);
    result.validationOutcomes = receipts.map((receipt) => ({
      receiptId: `wave-validation:${receipt.dispatchId}`,
      passed: receipt.results.passed,
    }));
    result.processPassed = passesWideProcess(
      result.waves,
      result.validationOutcomes,
      state.parallelExecution?.acceptedReceiptId,
    );
    assert(result.processPassed, 'fixed DAG or final accepted validation is missing');
    assert(state.subtasks.every((x) => x.status === 'done'));
    const trace = await new HarnessTraceReader(options.root).read(scope);
    result.traceCoderSessions = trace.sessions.filter((x) => x.role === 'CODER').length;
    await writeFile(
      join(options.root, 'trace-before-approval.json'),
      JSON.stringify(trace, null, 2),
    );
    times.approve = Date.now();
    const approval = await createPostMessage(messages)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          channelId: 'main',
          msgId: 'approve',
          display: `/resolve-gate ${state.humanGate?.gateId} approve_completion`,
        }),
      }),
    );
    assert.equal(approval.status, 202, await approval.text());
    await runtime.waitForIdle(scope);
    state = await messages.store.load(scope);
    assert(state);
    const summary = await runtime.summary(scope);
    assert(summary);
    result.status = summary.runStatus;
    assert.equal(summary.runStatus, 'completed', JSON.stringify(summary));
    const resolution = state.messages.find((m) => m.msgId === 'approve')?.payload.resolution as
      | HumanGateResolutionReceipt
      | undefined;
    result.completionBound =
      resolution?.completionEvidence?.validationReceiptId ===
      state.parallelExecution?.acceptedReceiptId;
    assert(result.completionBound, 'completion did not bind accepted receipt');
    result.iterations = state.iterationCount;
    result.repairIterations = state.messages.filter((m) =>
      ['review_rework', 'coding_retry', 'parallel_replan_dispatch'].includes(
        String(m.payload.kind),
      ),
    ).length;
    const restored = new TaskOrchestrationRuntime(messages, baseFactory);
    assert.equal((await restored.summary(scope))?.runStatus, 'completed');
    const artifact = join(taskRoot, 'artifacts/worktree');
    times.verificationStart = Date.now();
    const fresh = new DockerSandbox({ docker, image: imageId, baseDir: options.root });
    cleanups.push(() => fresh.teardown('fresh-verification'));
    const target = await fresh.createWorktree('fresh-verification', 'verify');
    new SecureFiles(artifact).snapshotTo(join(target.path, 'artifact'));
    await fresh.write(
      target,
      'artifact/independent-outcome.test.mjs',
      acceptanceSource(['A', 'B', 'C', 'D', 'E']),
    );
    result.freshVerification = await fresh.run(
      target,
      'cd artifact && node --test --test-reporter=tap independent-outcome.test.mjs',
    );
    assert.equal(result.freshVerification.exitCode, 0, result.freshVerification.stderr);
    times.verificationEnd = Date.now();
    const finalTrace = await new HarnessTraceReader(options.root).read(scope, { maxEvents: 2000 });
    result.traceForks = finalTrace.sessions.filter(
      (session) => session.parentSessionId !== undefined,
    ).length;
    result.traceOmittedEvents = finalTrace.omittedEventCount;
    await writeFile(join(options.root, 'trace-final.json'), JSON.stringify(finalTrace, null, 2));
  } catch (error) {
    result.status = 'failed';
    result.failure = error instanceof Error ? error.message.slice(0, 3000) : String(error);
  } finally {
    let latest: AppState | undefined;
    try {
      latest = await messages.store.load(scope);
    } catch (error) {
      result.cleanupErrors.push(`final state inspection failed: ${error}`);
    }
    try {
      if (latest !== undefined) {
        result.waves = latest.messages
          .filter((message) => message.payload.kind === 'coding_wave')
          .map((message) => message.payload.subtaskIds as string[]);
        const validations = latest.messages.filter(
          (message) => message.payload.kind === 'wave_validation',
        );
        result.validationTotals = validations.map(
          (message) => validationReceipt(latest, message.msgId).results.total,
        );
        result.validationOutcomes = validations.map((message) => ({
          receiptId: message.msgId,
          passed: validationReceipt(latest, message.msgId).results.passed,
        }));
        result.iterations = latest.iterationCount;
        // This driver stops at the first non-completion gate; it never resolves conflicts.
        result.integrationConflicts = latest.integration?.status === 'conflict' ? 1 : 0;
        result.repairIterations = latest.messages.filter((message) =>
          ['review_rework', 'coding_retry', 'parallel_replan_dispatch'].includes(
            String(message.payload.kind),
          ),
        ).length;
      }
    } catch (error) {
      result.cleanupErrors.push(`final evidence inspection failed: ${error}`);
    }
    times.cleanupStart = Date.now();
    stopped = true;
    await sampling;
    for (const cleanup of cleanups.reverse())
      try {
        await cleanup();
      } catch (error) {
        result.cleanupErrors.push(String(error));
      }
    if (sampleFailure !== undefined)
      result.cleanupErrors.push(`resource sampling failed: ${sampleFailure}`);
    times.cleanupEnd = Date.now();
    try {
      const retained = new SecureFiles(taskRoot).measure();
      resources.finalTaskLogicalBytes = retained.logicalBytes;
      resources.finalTaskAllocatedBytes = retained.allocatedBytes;
      resources.finalLinkedWorktrees = (
        await readdir(join(taskRoot, 'worktrees'), { withFileTypes: true })
      ).filter((entry) => entry.isDirectory()).length;
    } catch (error) {
      result.cleanupErrors.push(`final resource inspection failed: ${error}`);
    }
    result.leasePeak = scheduler.peak;
    result.finalLeaseCount = scheduler.activeCount;
    result.leaseIntervals = [...scheduler.intervals.values()];
    if (result.cleanupErrors.length > 0) result.status = 'failed';
    await writeFile(join(options.root, 'wide-flow-evidence.json'), JSON.stringify(result, null, 2));
  }
  return result;
}
