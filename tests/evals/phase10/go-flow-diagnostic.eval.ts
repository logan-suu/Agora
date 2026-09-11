import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Dockerode, DockerSandbox } from '@agora/runtime-sandbox';
import { SecureFiles } from '@agora/runtime-sandbox/secure-files';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import { runEvalTask } from '../core/runner';
import { BudgetLedger } from './final/accounting';
import { FlowToolPolicy } from './final/flow-tool-policy';
import { CONFIG, fixedRoster, MeteredAdapter } from './final/model-adapter';
import { runMulti } from './final/multi-driver';
import { runSingle } from './final/single-driver';

// Explicit, real-model diagnostic; never collected by the default test suite.
it('phase10 authorized Go single and mixed full flow diagnostic', async () => {
  if (process.env.AGORA_GO_FLOW_DIAGNOSTIC !== 'authorized-2026-09-10')
    throw new Error('explicit full-flow diagnostic authorization is required');
  const budgetPath = process.env.AGORA_GO_DIAGNOSTIC_BUDGET;
  if (!budgetPath || !existsSync(budgetPath))
    throw new Error('reuse the existing diagnostic budget');
  const budget = new BudgetLedger(budgetPath, 0.51, 0.01);
  const baselineRequests = JSON.parse(await readFile(budgetPath, 'utf8')).requests.length as number;
  const baselineQuota = budget.spent;
  if (baselineQuota === 'unknown') throw new Error('prior unknown usage requires audit');
  const docker = new Dockerode({
    socketPath: join(process.env.HOME ?? '', '.docker/run/docker.sock'),
  });
  const candidates = (await docker.listImages()).filter((entry) =>
    entry.RepoTags?.includes('agora-benchmark:task105'),
  );
  if (candidates.length !== 1 || !candidates[0])
    throw new Error('benchmark image must resolve uniquely');
  const image = (await docker.getImage(candidates[0].Id).inspect()).Id;
  if (image !== candidates[0].Id) throw new Error('benchmark image identity drift');
  const plan = {
    version: 1,
    subtasks: [{ id: 'A', title: 'Implement answer.mjs', dependsOn: [] }],
  };
  const goal = `Build a modular API system implementing exactly one ES module answer.mjs exporting function answer() that returns number 42. Use exactly this executionPlan: ${JSON.stringify(plan)}. No extra source modules, server or CLI. Write Node built-in *.test.mjs tests and commit and run them via node --test --test-reporter=tap. Preserve the one-subtask DAG. REVIEWER approves the validated artifact; when running the multi-role product use its normal Leader completion gate. This is a driver diagnostic, not a benchmark task.`;
  // Count earlier stopped full-flow runs too; a new process never resets this stage's cap.
  let requests = (
    JSON.parse(await readFile(budgetPath, 'utf8')).requests as { trial: string }[]
  ).filter((r) => r.trial.startsWith('go-flow-')).length;
  let stopped = false;
  const started = Date.now();
  const toolPolicy = new FlowToolPolicy();
  class FlowMeter extends MeteredAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (
        stopped ||
        existsSync(resolve('.data/evals/go-flow-stop-requested.json')) ||
        requests >= 40 ||
        Date.now() - started > 1_200_000
      )
        throw new Error('full-flow diagnostic stopped before next request');
      try {
        toolPolicy.inspect(options);
      } catch (error) {
        stopped = true;
        throw error;
      }
      requests++;
      try {
        yield* super.stream(options);
        if (this.calls.at(-1)?.costUsd === undefined)
          throw new Error('missing usage; full-flow diagnostic stopped');
      } catch (error) {
        stopped = true;
        throw error;
      } finally {
        console.log(
          JSON.stringify({
            stage: 'request-end',
            requests,
            model: options.model,
            quotaUsd: budget.spent,
            failed: stopped,
          }),
        );
      }
    }
  }
  for (const variant of ['single', 'mixed'] as const) {
    const meter = new FlowMeter(budget, `go-flow-${variant}`, 'diagnostic');
    const task = {
      schemaVersion: 1 as const,
      id: `phase10-go-flow-${variant}`,
      version: '1',
      source: 'Own answer42 diagnostic; no benchmark or holdout',
      profiles: ['model' as const],
      goal,
      repository: { fixture: 'answer42', revision: '1' },
      expectedOutcome: { assertions: ['answer42'] },
      expectedInvariants: ['safety.cleanup'],
      limits: {
        maxIterations: 8,
        maxDurationMs: 1_200_000,
        maxModelCalls: 40,
        maxToolCalls: 240,
        maxCostUsd: 0.5,
      },
    };
    const result = await runEvalTask({
      task,
      profile: 'model',
      attempt: 1,
      evalRoot: resolve('.data/evals'),
      runnerVersion: 'go-full-flow-diagnostic-v1',
      systemVariant: variant,
      modelConfig: {
        provider: CONFIG.provider,
        model: variant === 'single' ? 'deepseek-v4-flash' : 'role-routed',
        parameters: {
          endpoint: CONFIG.endpoint,
          contextLimit: CONFIG.contextLimit,
          maxTokens: CONFIG.maxTokens,
          temperature: CONFIG.temperature,
          thinking: CONFIG.thinking,
          reasoningEffort: CONFIG.reasoningEffort,
          accountingMetric: CONFIG.accountingMetric,
          roleModels: JSON.stringify(
            Object.fromEntries(fixedRoster(variant).map((r) => [r.role, r.model])),
          ),
        },
      },
      environment: { sandbox: 'Docker', imageOrRuntime: image, platform: process.arch },
      execute: async (context) => {
        console.log(
          JSON.stringify({
            stage: 'start',
            variant,
            runRoot: context.runRoot,
            remainingQuota: budget.remaining('diagnostic'),
          }),
        );
        const sourceFiles = [
          'tests/evals/phase10/go-flow-diagnostic.eval.ts',
          'tests/evals/phase10/final/model-adapter.ts',
          'tests/evals/phase10/final/go-tool-stream.ts',
          'tests/evals/phase10/final/model-profile.ts',
          'tests/evals/phase10/final/flow-tool-policy.ts',
          'tests/evals/phase10/final/single-driver.ts',
          'tests/evals/phase10/final/multi-driver.ts',
        ];
        await writeFile(
          join(context.runRoot, 'diagnostic-config.json'),
          JSON.stringify(
            {
              budgetPath,
              baselineRequests,
              baselineQuota,
              maxFlowRequestsIncludingStoppedRuns: 40,
              diagnosticTotalQuota: 0.5,
              image,
              sourceHashes: Object.fromEntries(
                sourceFiles.map((path) => [
                  path,
                  createHash('sha256').update(readFileSync(path)).digest('hex'),
                ]),
              ),
            },
            null,
            2,
          ),
        );
        context.registerCleanup(async () => {
          await writeFile(
            join(context.runRoot, 'model-requests.json'),
            JSON.stringify(
              { calls: meter.calls, toolCalls: meter.toolCalls, quotaUsd: budget.spent },
              null,
              2,
            ),
          );
          return {
            efficiency: {
              modelCalls: meter.calls.length,
              toolCalls: meter.toolCalls,
              costUsd: meter.calls.every((c) => c.costUsd !== undefined)
                ? meter.calls.reduce((n, c) => n + (c.costUsd ?? 0), 0)
                : 'unknown',
            },
          };
        });
        const common = {
          context,
          docker,
          image,
          goal,
          seed: { 'TASK.md': goal },
          adapter: meter,
          meter,
        };
        const flow =
          variant === 'single' ? await runSingle(common) : await runMulti({ ...common, variant });
        const code = new SecureFiles(flow.artifact).read('answer.mjs');
        const verifier = new DockerSandbox({ docker, image, baseDir: context.runRoot });
        context.registerCleanup(async () => {
          await verifier.teardown('verify-answer');
          return undefined;
        });
        const workspace = await verifier.createWorktree('verify-answer', 'verifier');
        await verifier.write(workspace, 'answer.mjs', code);
        const verification = await verifier.run(
          workspace,
          `node --input-type=module -e "import('./answer.mjs').then(m=>{if(m.answer()!==42)throw Error('bad answer');console.log('verified')})"`,
        );
        await writeFile(
          join(context.runRoot, 'verification.json'),
          JSON.stringify(verification, null, 2),
        );
        const trace = JSON.parse(await readFile(join(context.runRoot, 'trace.json'), 'utf8')) as {
          sessions: { sessionId: string; role: string }[];
        };
        const routes = meter.calls.map((c) => ({
          model: c.model,
          role: trace.sessions.find((s) => s.sessionId === c.sessionId)?.role,
        }));
        await writeFile(join(context.runRoot, 'routes.json'), JSON.stringify(routes, null, 2));
        const expected = new Map(fixedRoster(variant).map((r) => [r.role as string, r.model]));
        expect(routes.every((r) => r.role !== undefined && expected.get(r.role) === r.model)).toBe(
          true,
        );
        if (variant === 'mixed') expect(new Set(routes.map((r) => r.model)).size).toBe(2);
        return { assertions: { answer42: verification.exitCode === 0 && !verification.timedOut } };
      },
    });
    console.log(
      JSON.stringify({
        stage: 'final',
        variant,
        status: result.overallStatus,
        runId: result.runId,
        modelCalls: meter.calls.length,
        quotaUsd: budget.spent,
        newRequests: requests,
      }),
    );
    if (result.overallStatus !== 'pass') stopped = true;
    expect(result.overallStatus, result.failure?.detail).toBe('pass');
  }
}, 1_800_000);
