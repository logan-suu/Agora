import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { evaluateComplexity } from '@agora/core-orchestration';
import { Dockerode } from '@agora/runtime-sandbox';
import { SecureFiles } from '@agora/runtime-sandbox/secure-files';
import { expect, it } from 'vitest';
import { fingerprintTask } from '../core/contracts';
import { type EvalObservation, runEvalTask } from '../core/runner';
import { HOLDOUTS, type HoldoutName } from '../fixtures/phase10/holdout';
import {
  BudgetLedger,
  FRESH_HOLDOUT_NAMES,
  type PublicName,
  trialMatrix,
} from './final/accounting';
import { inspectBenchmarkImage } from './final/benchmark-image';
import {
  assertFormalAuthorization,
  FORMAL_POLICY,
  FormalGuard,
  GuardedFormalMeter,
} from './final/formal-guard';
import { verifyHoldout } from './final/holdout-verifier';
import { GroupRegistry, sourceFingerprint } from './final/manifest';
import { CONFIG, fixedRoster } from './final/model-adapter';
import { runMulti } from './final/multi-driver';
import { resolveOpenCodeGoApiKey } from './final/opencode-go';
import { budgetTrialId, operatorStopRequested, PROTOCOL, resolveGroupId } from './final/protocol';
import { sha256 } from './final/public-adapter';
import { buildReport, reportMarkdown } from './final/report';
import { runSingle } from './final/single-driver';
import { EXECUTION_ENVIRONMENT } from './final/task-environment';
import { taskDefinition } from './final/tasks';
import { verifyPublic } from './final/verifier';

const groupId = resolveGroupId(process.env.AGORA_BENCHMARK_GROUP);
const root = resolve('.data/evals', groupId);
const preflightRoot = resolve('.data/evals/phase10-preflight');
const sources = join(preflightRoot, 'sources');
const budgetPath = resolve('.data/evals', CONFIG.budgetFile);
const docker = new Dockerode({
  socketPath: join(process.env.HOME ?? '', '.docker/run/docker.sock'),
});

async function prepare() {
  assert(existsSync(budgetPath), 'shared Go quota ledger missing; cannot reset prior spending');
  await mkdir(root, { recursive: true });
  const image = await inspectBenchmarkImage(docker);
  const environmentCheck = JSON.parse(
    await readFile(join(preflightRoot, 'environment-preflight.json'), 'utf8'),
  );
  assert(
    environmentCheck.image === image.Id &&
      environmentCheck.gitCliAvailable === false &&
      /^v20\./.test(environmentCheck.nodeVersion) &&
      environmentCheck.contractHash === sha256(EXECUTION_ENVIRONMENT),
    'execution environment preflight drift',
  );
  const publicCheck = JSON.parse(await readFile(join(preflightRoot, 'preflight.json'), 'utf8'));
  const holdoutCheck = JSON.parse(
    await readFile(join(preflightRoot, 'holdout-preflight.json'), 'utf8'),
  );
  assert(
    publicCheck.image === image.Id && holdoutCheck.image === image.Id,
    'preflight image drift',
  );
  assert(
    publicCheck.results.length === 4 &&
      publicCheck.results.every(
        (r: {
          positive: boolean;
          negative: boolean;
          contractProjectedToPm?: boolean;
          taskVersion?: number;
        }) => r.positive && !r.negative && r.contractProjectedToPm === true && r.taskVersion === 6,
      ),
  );
  assert(
    FRESH_HOLDOUT_NAMES.every((name) =>
      holdoutCheck.results.some(
        (r: { name: string; tier: number; semanticNegative?: { passed: boolean } }) =>
          r.name === name && r.tier === 2 && r.semanticNegative?.passed === false,
      ),
    ) &&
      holdoutCheck.results.every(
        (r: {
          name: HoldoutName;
          fingerprint: string;
          positive: { passed: boolean };
          negative: { passed: boolean };
        }) =>
          r.positive.passed &&
          !r.negative.passed &&
          r.fingerprint === sha256(JSON.stringify(HOLDOUTS[r.name])),
      ),
  );
  const trials = trialMatrix(FORMAL_POLICY.matrix),
    tasks = [];
  for (const trial of trials) {
    const def = await taskDefinition(trial, sources);
    if (trial.variant !== 'single')
      assert.equal(
        evaluateComplexity({ goal: def.task.goal }).tier,
        2,
        'benchmark comparison requires production Tier 2 routing',
      );
    tasks.push({
      trial: trial.id,
      fingerprint: fingerprintTask(def.task),
      seedHash: sha256(JSON.stringify(def.seed)),
      modelSeedFiles: Object.entries(def.seed).map(([path, content]) => ({
        path,
        sha256: sha256(content),
      })),
      roster: fixedRoster(trial.variant).map((r) => ({ role: r.role, model: r.model })),
    });
  }
  const publicGroup = JSON.parse(
    await readFile(
      resolve('.data/evals', FORMAL_POLICY.completedPublicGroup, 'group.json'),
      'utf8',
    ),
  );
  assert(
    publicGroup.fingerprint === FORMAL_POLICY.completedPublicFingerprint,
    'completed public group identity drift',
  );
  const publicTrials = publicGroup.manifest.trials.filter(
    (t: { suite: string }) => t.suite === 'public',
  );
  assert(publicTrials.length === 36, 'completed public matrix missing');
  const completedPublicComparison = {
    groupId: FORMAL_POLICY.completedPublicGroup,
    fingerprint: publicGroup.fingerprint,
    sourceFingerprint: publicGroup.manifest.frozen.source.fingerprint,
    attempts: publicTrials.map((t: { id: string }) => {
      const a = publicGroup.attempts.find((a: { id: string }) => a.id === t.id);
      assert(
        a?.status === 'final' && a.result?.lifecycle === 'final',
        'public comparison incomplete',
      );
      return { id: t.id, runId: a.result.runId, resultHash: sha256(JSON.stringify(a.result)) };
    }),
  };
  const frozen = {
    groupId,
    protocol: PROTOCOL,
    completedPublicComparison,
    source: sourceFingerprint(process.cwd()),
    image: { id: image.Id, architecture: image.Architecture, size: image.Size },
    environmentLockHash: sha256(
      await readFile(join(preflightRoot, 'environment-package-lock.json')),
    ),
    config: CONFIG,
    tasks,
    sourceManifests: await Promise.all(
      ['grade-school', 'wordy', 'book-store', 'forth'].map(async (name) =>
        JSON.parse(await readFile(join(sources, name, 'source-manifest.json'), 'utf8')),
      ),
    ),
    limits: FORMAL_POLICY,
    warmPolicy:
      'prebuilt image; fresh network-none 512MiB cpuShares512 container/workspace/session for every attempt; shared provider cache remains uncontrolled',
  };
  return {
    registry: new GroupRegistry(join(root, 'group.json'), { schemaVersion: 1, trials, frozen }),
    image: image.Id as string,
    frozen,
  };
}
async function publish(registry: GroupRegistry) {
  const report = buildReport(registry);
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(root, 'report.md'), reportMarkdown(report));
  return report;
}
it('phase10 freeze final benchmark', async () => {
  const { registry } = await prepare();
  await publish(registry);
  expect(registry.manifest.trials).toHaveLength(18);
}, 60_000);

it('phase10 run final model benchmark', async () => {
  assertFormalAuthorization(groupId, process.env.AGORA_GO_FORMAL_AUTHORIZATION);
  await resolveOpenCodeGoApiKey();
  const { registry, image } = await prepare();
  assert(
    !registry.read().attempts.some((attempt) => attempt.status === 'started'),
    'unfinished attempt requires audit before resuming',
  );
  const lock = join(root, 'execution.lock'),
    fd = openSync(lock, 'wx', 0o600);
  const budget = new BudgetLedger(budgetPath, FORMAL_POLICY.totalUsd, FORMAL_POLICY.formalUsd);
  const guard = new FormalGuard(root);
  const start = Date.parse(registry.read().createdAt);
  try {
    for (const trial of trialMatrix(FORMAL_POLICY.matrix)) {
      if (operatorStopRequested(root)) {
        await writeFile(
          join(root, 'stopped.json'),
          JSON.stringify(
            {
              beforeTrial: trial.id,
              reason: 'operator-stop-requested',
              at: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        break;
      }
      if (!registry.pending().includes(trial.id)) continue;
      const rates =
        CONFIG.peakRates[trial.variant === 'mixed' ? 'deepseek-flash' : 'deepseek-v4-flash'];
      const minimum =
        (CONFIG.contextLimit * rates.input + CONFIG.maxTokens * rates.output) / 1_000_000;
      if (
        Date.now() - start >= FORMAL_POLICY.groupMs ||
        budget.spent === 'unknown' ||
        budget.remaining('formal') < minimum
      ) {
        await writeFile(
          join(root, 'stopped.json'),
          JSON.stringify(
            {
              beforeTrial: trial.id,
              reason:
                Date.now() - start >= FORMAL_POLICY.groupMs
                  ? 'group-time-limit'
                  : 'group-budget-limit-or-unknown',
              at: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        break;
      }
      const definition = await taskDefinition(trial, sources);
      const meter = new GuardedFormalMeter(budget, budgetTrialId(groupId, trial.id), guard);
      const result = await runEvalTask({
        task: definition.task,
        profile: 'model',
        attempt: trial.attempt,
        evalRoot: resolve('.data/evals'),
        runnerVersion: PROTOCOL.version,
        systemVariant: trial.variant,
        modelConfig: {
          provider: CONFIG.provider,
          model:
            trial.variant === 'mixed' ? 'role-routed-v4-flash-v4.1-flash' : 'deepseek-v4-flash',
          parameters: {
            groupId,
            publicContractVisibility: PROTOCOL.publicContractVisibility,
            executionEnvironment: PROTOCOL.executionEnvironment,
            publicTestVisibility: PROTOCOL.publicTestVisibility,
            holdoutTestVisibility: PROTOCOL.holdoutTestVisibility,
            maxTokens: CONFIG.maxTokens,
            contextLimit: CONFIG.contextLimit,
            contextMetric: CONFIG.contextMetric,
            accountingMetric: CONFIG.accountingMetric,
            endpoint: CONFIG.endpoint,
            temperature: CONFIG.temperature,
            thinking: CONFIG.thinking,
            reasoningEffort: CONFIG.reasoningEffort,
            roster: JSON.stringify(
              fixedRoster(trial.variant).map((r) => ({ role: r.role, model: r.model })),
            ),
          },
        },
        environment: {
          sandbox: 'DockerSandbox/WorkspaceAdapter',
          imageOrRuntime: image,
          platform: `${process.platform}/${process.arch}`,
        },
        execute: async (context) => {
          registry.start(trial.id, context.runRoot);
          const observation: EvalObservation = {
            assertions: { 'independent-outcome': false },
            invariants: {},
          };
          context.registerCleanup(async () => {
            const known = meter.calls.every(
              (c) => c.usage !== undefined && c.costUsd !== undefined,
            );
            let routesMatch: boolean | 'unknown' = 'unknown';
            const tracePath = join(context.runRoot, 'trace.json');
            if (existsSync(tracePath)) {
              const trace = JSON.parse(await readFile(tracePath, 'utf8'));
              const roster = fixedRoster(trial.variant);
              routesMatch =
                meter.calls.length > 0 &&
                meter.calls.every((call) => {
                  const session = trace.sessions.find(
                    (s: { sessionId: string; role: string }) => s.sessionId === call.sessionId,
                  );
                  return (
                    session && roster.find((r) => r.role === session.role)?.model === call.model
                  );
                });
            }
            observation.invariants = { ...observation.invariants, 'model-routing': routesMatch };
            observation.efficiency = {
              ...observation.efficiency,
              modelCalls: meter.calls.length,
              toolCalls: meter.toolCalls,
              inputTokens: known
                ? meter.calls.reduce(
                    (n, c) =>
                      n +
                      (c.usage?.inputTokens ?? 0) +
                      (c.usage?.cacheReadTokens ?? 0) +
                      (c.usage?.cacheWriteTokens ?? 0),
                    0,
                  )
                : 'unknown',
              outputTokens: known
                ? meter.calls.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0)
                : 'unknown',
              costUsd: known ? meter.calls.reduce((n, c) => n + (c.costUsd ?? 0), 0) : 'unknown',
            };
            await writeFile(
              join(context.runRoot, 'model-requests.json'),
              JSON.stringify(
                { config: CONFIG, calls: meter.calls, toolCalls: meter.toolCalls },
                null,
                2,
              ),
            );
            return observation;
          });
          const common = {
            context,
            docker,
            image,
            goal: definition.task.goal,
            seed: definition.seed,
            adapter: meter,
            meter,
          };
          let artifact: string;
          if (trial.variant === 'single') {
            const flow = await runSingle(common);
            artifact = flow.artifact;
            observation.invariants = { 'single-safe-boundary': flow.completed };
            observation.efficiency = {
              iterations: flow.iterations,
              repairIterations: 0,
              humanInterventions: 0,
            };
          } else {
            const flow = await runMulti({
              ...common,
              variant: trial.variant,
              ...(definition.requirementUpdate
                ? { requirementUpdate: definition.requirementUpdate }
                : {}),
              ...(definition.background ? { background: definition.background } : {}),
            });
            artifact = flow.artifact;
            const expectedWaves =
              trial.suite === 'public' ? [['A']] : [['A', 'B', 'C', 'D'], ['E']];
            const firstWaves = flow.evidence.waves.slice(0, expectedWaves.length);
            observation.invariants = {
              'completion-bound': flow.evidence.completionBound,
              'gate-released': flow.evidence.gateLeaseCount === 0,
              'fixed-plan': JSON.stringify(firstWaves) === JSON.stringify(expectedWaves),
              ...(definition.requirementUpdate
                ? { 'requirement-applied': flow.evidence.requirementApplied }
                : {}),
              ...(trial.variant === 'sparse'
                ? { 'context-policy-reached': flow.evidence.projections.some((p) => p.changed) }
                : {}),
            };
            observation.efficiency = {
              iterations: flow.evidence.iterations,
              repairIterations: flow.evidence.repairIterations,
              humanInterventions: 1 + Number(flow.evidence.requirementSubmitted),
            };
          }
          const reader = new SecureFiles(artifact),
            candidate: Record<string, string> = {};
          for (const file of definition.files) candidate[file] = reader.read(file);
          observation.files = Object.keys(candidate);
          const verification =
            trial.suite === 'public'
              ? await verifyPublic({
                  docker,
                  image,
                  root: context.runRoot,
                  sources,
                  name: trial.task as PublicName,
                  code: candidate[`${trial.task}.js`] as string,
                })
              : await verifyHoldout({
                  docker,
                  image,
                  root: context.runRoot,
                  name: trial.task as HoldoutName,
                  files: candidate,
                });
          observation.assertions = { 'independent-outcome': verification.passed };
          observation.invariants = { ...observation.invariants, 'safety.verifier-integrity': true };
          await writeFile(
            join(context.runRoot, 'independent-outcome.json'),
            JSON.stringify(verification, null, 2),
          );
          return observation;
        },
      });
      registry.finish(trial.id, result);
      if (result.overallStatus !== 'pass') guard.stop(trial.id, 'attempt-not-passed');
      await publish(registry);
      console.log(
        `Phase10 ${trial.id}: ${result.overallStatus}; calls=${meter.calls.length}; group quota-equivalent USD=${budget.spent}`,
      );
    }
  } catch (error) {
    guard.stop(groupId, 'runner-failure');
    throw error;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    await publish(registry);
  }
  const report = await publish(registry);
  expect(report.final, 'planned experiment incomplete').toBe(registry.manifest.trials.length);
  expect(
    report.rows.filter((r) => !r.passed).map((r) => r.id),
    'failed attempts retained; see report',
  ).toEqual([]);
}, 30_000_000);

it('phase10 report final benchmark', async () => {
  assert(existsSync(join(root, 'group.json')), 'no frozen group');
  const stored = JSON.parse(readFileSync(join(root, 'group.json'), 'utf8'));
  const registry = new GroupRegistry(join(root, 'group.json'), stored.manifest);
  await publish(registry);
});
