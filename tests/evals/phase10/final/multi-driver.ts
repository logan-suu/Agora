import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelContext } from '@agora/comm-channels';
import { type AppState, validationReceipt } from '@agora/core-domain';
import {
  GlobalScheduler,
  type HumanGateResolutionReceipt,
  type SlotLease,
} from '@agora/core-orchestration';
import { HarnessTraceReader } from '@agora/runtime-executor';
import type { Dockerode } from '@agora/runtime-sandbox';
import type { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { ChannelStream } from '../../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../../apps/web/src/server/task-composition';
import { createPostTask } from '../../../../apps/web/src/server/task-handlers';
import { TaskOrchestrationRuntime } from '../../../../apps/web/src/server/task-orchestration-runtime';
import type { EvalExecutionContext } from '../../core/runner';
import type { Variant } from './accounting';
import { applyContextPolicy } from './context-policy';
import { fixedRoster, type MeteredAdapter } from './model-adapter';
import { mountBelongsToTask } from './task-container';
import { seedRepository } from './workspace';

export class ObservedScheduler extends GlobalScheduler {
  peak = 0;
  readonly intervals: { leaseId: string; workerId: string; start: number; end?: number }[] = [];
  override async acquire(project: string, task: string, worker: string, signal?: AbortSignal) {
    const lease = await super.acquire(project, task, worker, signal);
    this.peak = Math.max(this.peak, this.activeCount);
    this.intervals.push({ leaseId: lease.leaseId, workerId: worker, start: lease.grantedTs });
    return lease;
  }
  override async release(lease: SlotLease) {
    await super.release(lease);
    const record = this.intervals.find((i) => i.leaseId === lease.leaseId);
    if (record && record.end === undefined) record.end = Date.now();
  }
}
export async function runMulti(options: {
  context: EvalExecutionContext;
  docker: Dockerode;
  image: string;
  goal: string;
  seed: Readonly<Record<string, string>>;
  adapter: LlmAdapter;
  meter?: MeteredAdapter;
  variant: Variant;
  requirementUpdate?: string;
  background?: readonly string[];
}) {
  const { context } = options;
  const scope = { projectId: 'agora', taskId: 'benchmark' };
  const taskRoot = join(context.dataRoot, 'projects/agora/tasks/benchmark');
  await mkdir(taskRoot, { recursive: true });
  const seed = await seedRepository(join(taskRoot, 'repository'), options.seed);
  const scheduler = new ObservedScheduler({ cap: options.variant === 'parallel' ? 3 : 1 });
  const messages = createMessageRuntime(
    context.dataRoot,
    new ChannelStream(),
    fixedRoster(options.variant),
  );
  const evidence = {
    baseCommit: seed.commit,
    completed: false,
    completionBound: false,
    forks: 0,
    resumeCompositions: 0,
    plannedWorkerResumes: 0,
    traceOmittedEvents: 0,
    gateReached: false,
    gateLeaseCount: -1,
    finalLeaseCount: -1,
    leasePeak: 0,
    iterations: 0,
    repairIterations: 0,
    requirementSubmitted: false,
    requirementApplied: false,
    projections: [] as {
      role: string;
      resumed: boolean;
      beforeChars: number;
      afterChars: number;
      changed: boolean;
    }[],
    waves: [] as string[][],
    validations: [] as { id: string; passed: boolean; total: number }[],
    times: { start: Date.now(), gate: 0, approve: 0, archive: 0, cleanupStart: 0, cleanupEnd: 0 },
    resources: {
      containerPeak: 0,
      worktreePeak: 0,
      compositionPeak: 0,
      samples: 0,
      cpu: 'unknown',
      memory: 'unknown',
      sampleIntervalMs: 500,
    },
    leaseIntervals: scheduler.intervals,
    finalStatePath: join(taskRoot, 'state.json'),
  };
  let stopped = false,
    compositions = 0,
    samplingFailure: unknown;
  const sample = async () => {
    const containers = await options.docker.listContainers({ all: true });
    evidence.resources.containerPeak = Math.max(
      evidence.resources.containerPeak,
      containers.filter((c) => c.Mounts.some((m) => mountBelongsToTask(m.Source, taskRoot))).length,
    );
    try {
      evidence.resources.worktreePeak = Math.max(
        evidence.resources.worktreePeak,
        (await readdir(join(taskRoot, 'worktrees'), { withFileTypes: true })).filter((e) =>
          e.isDirectory(),
        ).length,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    evidence.resources.samples++;
  };
  const sampling = (async () => {
    while (!stopped) {
      try {
        await sample();
      } catch (error) {
        samplingFailure = error;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  context.registerCleanup(async () => {
    evidence.times.cleanupStart = Date.now();
    stopped = true;
    await sampling;
    evidence.finalLeaseCount = scheduler.activeCount;
    evidence.leasePeak = scheduler.peak;
    evidence.times.cleanupEnd = Date.now();
    await writeFile(
      join(context.runRoot, 'multi-evidence.json'),
      JSON.stringify(evidence, null, 2),
    );
    if (samplingFailure) throw samplingFailure;
    assert.equal(scheduler.activeCount, 0, 'worker leases remain after cleanup');
    const containers = await options.docker.listContainers({ all: true });
    assert(
      !containers.some((c) => c.Mounts.some((m) => mountBelongsToTask(m.Source, taskRoot))),
      'task container remains after cleanup',
    );
    return { invariants: { 'safety.cleanup': true } };
  });
  const post = async (msgId: string, display: string) => {
    const response = await createPostMessage(messages)(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...scope, channelId: 'main', msgId, display }),
      }),
    );
    assert.equal(response.status, 202, await response.text());
  };
  let event: Promise<void> | undefined;
  let eventError: unknown;
  let background: Promise<void> | undefined;
  const factory = createWebTaskCompositionFactory({
    dataRoot: context.dataRoot,
    scheduler,
    sandboxConfig: { kind: 'docker', docker: options.docker, image: options.image },
    executorOptions: {
      adapter: options.adapter,
      provider: 'phase10-eval',
      deepseek: false,
      ...(options.meter
        ? {
            approval: () =>
              options.meter?.approveTool() ??
              Promise.resolve({ kind: 'deny' as const, reason: 'missing meter' }),
          }
        : {}),
    },
  });
  const runtime = new TaskOrchestrationRuntime(messages, async (input) => {
    if (input.resume) {
      evidence.resumeCompositions++;
      evidence.plannedWorkerResumes += input.resume.receipt.workerResumes?.length ?? 0;
    }
    const composition = await factory({
      ...input,
      buildChannelContext: async (state, role) => {
        background ??= (async () => {
          for (const [index, summary] of (options.background ?? []).entries()) {
            await messages.commitMessage(scope, {
              msgId: `background-${index}`,
              channelId: 'main',
              fromRole: 'COORDINATOR',
              type: 'handoff',
              display: summary,
              payload: { kind: 'eval_scenario_background', summary },
              ts: index + 1,
            });
          }
        })();
        await background;
        const original = (await input.buildChannelContext(
          (await input.loadState()) ?? state,
          role,
        )) as ChannelContext[];
        const projected = applyContextPolicy(
          original,
          options.variant === 'sparse' ? 'sparse' : 'current',
        );
        evidence.projections.push({
          role,
          resumed: input.resume !== undefined,
          beforeChars: JSON.stringify(original).length,
          afterChars: JSON.stringify(projected).length,
          changed: JSON.stringify(original) !== JSON.stringify(projected),
        });
        return projected;
      },
      ...(input.transitionStep === undefined
        ? {}
        : {
            transitionStep: async (state, role, mutations) => {
              const next = await input.transitionStep?.(state, role, mutations);
              assert(next);
              if (role === 'CODER' && options.requirementUpdate && !evidence.requirementSubmitted) {
                evidence.requirementSubmitted = true;
                // Do not await the cohort barrier inside the worker's own commit boundary.
                event = post('requirement-update', options.requirementUpdate).catch((error) => {
                  eventError = error;
                });
              }
              return next;
            },
          }),
    });
    compositions++;
    evidence.resources.compositionPeak = Math.max(evidence.resources.compositionPeak, compositions);
    let released = false;
    const release = async (terminal: boolean) => {
      if (released) return;
      await (terminal ? composition.dispose() : composition.suspend());
      released = true;
      compositions--;
    };
    context.registerCleanup(async () => {
      await release(false);
      return undefined;
    });
    return {
      ...composition,
      dispose: () => release(true),
      suspend: () => release(false),
      archiveArtifact: async () => {
        const artifact = await composition.archiveArtifact();
        evidence.times.archive = Date.now();
        return artifact;
      },
    };
  });
  try {
    const start = await createPostTask(runtime)(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...scope, requestId: 'start', goal: options.goal }),
      }),
    );
    assert.equal(start.status, 202, await start.text());
    await runtime.waitForIdle(scope);
    await event;
    if (eventError) throw eventError;
    let state = await messages.store.load(scope);
    assert(state);
    assert.match(
      state.humanGate?.reason ?? '',
      /^completion_confirmation:/,
      JSON.stringify(await runtime.summary(scope)),
    );
    evidence.gateReached = true;
    evidence.times.gate = Date.now();
    evidence.gateLeaseCount = scheduler.activeCount;
    assert.equal(scheduler.activeCount, 0, 'gate did not release worker leases');
    evidence.times.approve = Date.now();
    await post('approve', `/resolve-gate ${state.humanGate?.gateId} approve_completion`);
    await runtime.waitForIdle(scope);
    state = await messages.store.load(scope);
    assert(state);
    assert.equal(
      (await runtime.summary(scope))?.runStatus,
      'completed',
      JSON.stringify(await runtime.summary(scope)),
    );
    const receipt = state.messages.find((m) => m.msgId === 'approve')?.payload.resolution as
      | HumanGateResolutionReceipt
      | undefined;
    evidence.completionBound =
      receipt?.completionEvidence?.validationReceiptId !== undefined &&
      receipt.completionEvidence.validationReceiptId === state.parallelExecution?.acceptedReceiptId;
    assert(evidence.completionBound, 'completion is not bound to the accepted validation');
    evidence.completed = true;
    return { artifact: join(taskRoot, 'artifacts/worktree'), evidence };
  } finally {
    const state: AppState | undefined = await messages.store.load(scope);
    if (state) {
      evidence.iterations = state.iterationCount;
      evidence.waves = state.messages
        .filter((m) => m.payload.kind === 'coding_wave')
        .map((m) => m.payload.subtaskIds as string[]);
      evidence.validations = state.messages
        .filter((m) => m.payload.kind === 'wave_validation')
        .map((m) => {
          const r = validationReceipt(state, m.msgId);
          return { id: m.msgId, passed: r.results.passed, total: r.results.total };
        });
      evidence.repairIterations = state.messages.filter((m) =>
        ['review_rework', 'coding_retry', 'parallel_replan_dispatch'].includes(
          String(m.payload.kind),
        ),
      ).length;
      evidence.requirementApplied = state.messages.some(
        (m) =>
          m.msgId === 'requirement-update' &&
          (m.payload.action as { status?: string } | undefined)?.status === 'applied',
      );
      const trace = await new HarnessTraceReader(context.dataRoot).read(scope, { maxEvents: 2000 });
      evidence.forks = trace.sessions.filter((s) => s.parentSessionId !== undefined).length;
      evidence.traceOmittedEvents = trace.omittedEventCount;
      await writeFile(join(context.runRoot, 'trace.json'), JSON.stringify(trace, null, 2));
    }
    await writeFile(
      join(context.runRoot, 'multi-evidence.json'),
      JSON.stringify(evidence, null, 2),
    );
  }
}
