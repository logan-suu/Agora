import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Dockerode } from '@agora/runtime-sandbox';
import { describe, expect, it } from 'vitest';
import type { EvalResult } from '../core/contracts';
import { type EvalObservation, runEvalTask } from '../core/runner';
import { executePhase8DeterministicScenario, usesPhase8Docker } from '../phase8/scenarios';
import { executionFingerprint } from './fingerprint';
import { ExperimentBudget, PRICING } from './metrics';
import { MeteredFlashAdapter, MODEL_CONFIG } from './model-adapter';
import { repairBudget } from './repair-budget';
import { runWideFlow } from './scenario';
import { WideFixtureAdapter } from './scripted-adapter';
import { PHASE9_EVAL_TASKS, WIDE_TASK } from './tasks';

const evalRoot = resolve('.data/evals');
const environment = {
  sandbox: 'docker',
  imageOrRuntime: 'node:20-slim',
  platform: `${process.platform}-${process.arch}`,
};

async function wide(
  cap: number,
  profile: 'deterministic' | 'model',
  attempt: number,
  budget: ExperimentBudget,
  sourceFingerprint = executionFingerprint(),
  pinnedImageId?: string,
  groupId?: string,
) {
  const socketPath = join(process.env.HOME ?? '', '.docker/run/docker.sock');
  const docker = new Dockerode(existsSync(socketPath) ? { socketPath } : {});
  const imageId: string = (await docker.getImage(pinnedImageId ?? 'node:20-slim').inspect()).Id;
  const meter = profile === 'model' ? new MeteredFlashAdapter(budget) : undefined;
  const adapter = meter ?? new WideFixtureAdapter(cap);
  return runEvalTask({
    task: WIDE_TASK,
    profile,
    attempt,
    evalRoot,
    runnerVersion: 'phase9-v2',
    systemVariant: `d17-cap-${cap}`,
    modelConfig:
      profile === 'model'
        ? MODEL_CONFIG
        : { provider: 'scripted', model: 'phase9-wide-v1', parameters: {} },
    environment: { ...environment, imageOrRuntime: imageId },
    execute: async (context) => {
      const fixture = await readFile(resolve('tests/evals/fixtures/phase9/contract.ts'));
      await writeFile(
        resolve(context.runRoot, 'manifest.json'),
        JSON.stringify(
          {
            cap,
            groupId,
            imageId,
            profile,
            attempt,
            pricing: PRICING,
            fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
            modelConfig: profile === 'model' ? MODEL_CONFIG : null,
            limits: WIDE_TASK.limits,
            groupLimitUsd: budget.limitUsd,
            sourceFingerprint,
            sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            harnessVersion: '0.1.1-rc.2',
            warmup:
              'Existing image and native helper prepared before timing; each attempt has fresh State, sessions, repository and containers. No model warmup.',
            leaderPolicy:
              'Approve only the normal completion_confirmation gate immediately after evidence checks; unexpected gates end the attempt without a guessed resolution.',
            dockerLimits: { memoryBytes: 512 * 1024 * 1024, cpuShares: 512, networkMode: 'none' },
            admissionCap: 3,
            groupMaxModelCalls: groupId?.startsWith('phase9-repair-verification-') ? 120 : 1080,
            groupMaxToolCalls: groupId?.startsWith('phase9-repair-verification-') ? 240 : 2160,
            groupMaxDurationMs:
              (groupId?.startsWith('phase9-repair-verification-') ? 20 : 180) * 60_000,
            nodeVersion: process.version,
          },
          null,
          2,
        ),
      );
      const flow = await runWideFlow({
        root: context.dataRoot,
        cap,
        adapter,
        imageId,
        ...(meter === undefined ? {} : { meter }),
      });
      const usage = meter?.calls.reduce(
        (sum, call) => ({
          input:
            sum.input +
            (call.usage?.inputTokens ?? 0) +
            (call.usage?.cacheReadTokens ?? 0) +
            (call.usage?.cacheWriteTokens ?? 0),
          output: sum.output + (call.usage?.outputTokens ?? 0),
        }),
        { input: 0, output: 0 },
      );
      const usageKnown = meter?.calls.every((call) => call.usage !== undefined) ?? false;
      const observation: EvalObservation & { measurements: unknown } = {
        assertions: {
          completed: flow.status === 'completed',
          'independent-outcome': flow.freshVerification.exitCode === 0,
        },
        invariants: {
          'process.fixed-dag-waves': flow.processPassed,
          'process.leases-bounded': flow.leasePeak <= cap && flow.finalLeaseCount === 0,
          'process.leader-bound': flow.completionBound,
          'safety.cleanup': flow.cleanupErrors.length === 0,
        },
        efficiency: {
          iterations: flow.iterations,
          repairIterations: flow.repairIterations,
          humanInterventions: flow.times.approve > 0 ? 1 : 0,
          inputTokens: usageKnown ? (usage?.input ?? 'unknown') : 'unknown',
          outputTokens: usageKnown ? (usage?.output ?? 'unknown') : 'unknown',
          modelCalls: meter?.calls.length ?? 0,
          toolCalls: meter?.toolCalls ?? 'unknown',
          costUsd: meter?.costUsd ?? 0,
        },
        measurements: {
          flow,
          requests: meter?.calls ?? [],
          pricing: PRICING,
          modelAliasLimitation: 'Provider alias weights cannot be pinned by this client.',
          stageDurations: {
            startToArchiveMs: flow.times.archive
              ? flow.times.archive - flow.times.start
              : 'unknown',
            leaderWaitMs: flow.times.approve ? flow.times.approve - flow.times.gate : 'unknown',
            executionMinusLeaderMs: flow.times.archive
              ? flow.times.archive - flow.times.start - (flow.times.approve - flow.times.gate)
              : 'unknown',
            freshVerificationMs: flow.times.verificationEnd
              ? flow.times.verificationEnd - flow.times.verificationStart
              : 'unknown',
            cleanupMs: flow.times.cleanupEnd - flow.times.cleanupStart,
          },
        },
      };
      return observation;
    },
  });
}

describe('phase9 deterministic baseline', () => {
  for (const task of PHASE9_EVAL_TASKS.filter((task) => task.id !== WIDE_TASK.id))
    it(task.id, async () => {
      const docker = usesPhase8Docker(task.id);
      const result = await runEvalTask({
        task,
        profile: 'deterministic',
        attempt: 1,
        evalRoot,
        runnerVersion: 'phase9-v2',
        systemVariant: 'multi-agent-role-projection',
        modelConfig: { provider: 'scripted', model: 'phase8-fixture-v1', parameters: {} },
        environment: {
          sandbox: docker ? 'docker' : 'isolated-node',
          imageOrRuntime: docker ? 'node:20-slim' : process.version,
          platform: environment.platform,
        },
        execute: (context) => executePhase8DeterministicScenario(task, context),
      });
      expect(result.failure).toBeUndefined();
      expect(result.overallStatus).toBe('pass');
    });
  for (const cap of [1, 2, 3])
    it(`same wide DAG at cap ${cap}`, async () => {
      const result = await wide(cap, 'deterministic', 1, new ExperimentBudget());
      expect(result.failure).toBeUndefined();
      expect(result.overallStatus, JSON.stringify(result.checks)).toBe('pass');
    }, 180_000);
});

describe('phase9 model baseline', () => {
  it('records nine independent attempts in rotated cap order without replacing failures', async () => {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required');
    const budget = new ExperimentBudget(7.94),
      start = Date.now();
    const results: EvalResult[] = [];
    const sourceFingerprint = executionFingerprint();
    const groupId = `phase9-comparison-${randomUUID()}`;
    const socketPath = join(process.env.HOME ?? '', '.docker/run/docker.sock');
    const docker = new Dockerode(existsSync(socketPath) ? { socketPath } : {});
    const imageId: string = (await docker.getImage('node:20-slim').inspect()).Id;
    for (const [index, cap] of [1, 2, 3, 2, 3, 1, 3, 1, 2].entries()) {
      if (Date.now() - start > 180 * 60_000) throw new Error('group wall-time budget exhausted');
      if (executionFingerprint() !== sourceFingerprint)
        throw new Error('execution sources changed during fixed comparison');
      const result = await wide(
        cap,
        'model',
        Math.floor(index / 3) + 1,
        budget,
        sourceFingerprint,
        imageId,
        groupId,
      );
      results.push(result);
      await writeFile(
        resolve(evalRoot, `${groupId}.json`),
        JSON.stringify(
          {
            schemaVersion: 1,
            groupId,
            sourceFingerprint,
            imageId,
            order: [1, 2, 3, 2, 3, 1, 3, 1, 2],
            plannedAttempts: 9,
            results,
            groupCostUsd: budget.costUsd,
            complete: results.length === 9,
            interpretation:
              'Exploratory three samples per cap; no required speedup or statistical significance claim.',
          },
          null,
          2,
        ),
      );
      console.info(
        `Phase 9 attempt ${index + 1}/9 cap=${cap}: ${result.overallStatus}, cost=${result.efficiency.costUsd}`,
      );
      expect(result.lifecycle).toBe('final');
    }
    expect(
      results.filter((result) => result.overallStatus !== 'pass').map((result) => result.runId),
      'All attempts were recorded; failed model outcomes remain failures',
    ).toEqual([]);
  }, 14_400_000);
});

describe('phase9 model repair verification', () => {
  it('completes the public DAG with the repaired configuration before comparison', async () => {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required');
    const result = await wide(
      3,
      'model',
      1,
      await repairBudget(evalRoot),
      executionFingerprint(),
      undefined,
      `phase9-repair-verification-${randomUUID()}`,
    );
    console.info(
      `Phase 9 repair verification ${result.runId}: ${result.overallStatus}, cost=${result.efficiency.costUsd}`,
    );
    expect(result.lifecycle).toBe('final');
    expect(result.overallStatus, JSON.stringify(result.checks)).toBe('pass');
  }, 1_800_000);
});
