import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import {
  type AgoraEvalTask,
  type EvalArtifactRef,
  type EvalEfficiency,
  type EvalEnvironment,
  type EvalModelConfig,
  type EvalProfile,
  type EvalResult,
  fingerprintTask,
  type GraderCheck,
  validateEvalTask,
} from './contracts';

export interface EvalObservation {
  testExitCode?: number;
  files?: readonly string[];
  assertions?: Readonly<Record<string, boolean>>;
  invariants?: Readonly<Record<string, boolean | 'unknown'>>;
  efficiency?: Partial<EvalEfficiency>;
}

export interface EvalExecutionContext {
  runRoot: string;
  dataRoot: string;
  workspaceRoot: string;
}

export interface RunEvalTaskOptions {
  task: AgoraEvalTask;
  profile: EvalProfile;
  attempt: number;
  evalRoot: string;
  runnerVersion: string;
  systemVariant: string;
  modelConfig: EvalModelConfig;
  environment: EvalEnvironment;
  execute(context: EvalExecutionContext): Promise<EvalObservation>;
}

const UNKNOWN_EFFICIENCY: Omit<EvalEfficiency, 'durationMs'> = {
  inputTokens: 'unknown',
  outputTokens: 'unknown',
  costUsd: 'unknown',
  modelCalls: 'unknown',
  toolCalls: 'unknown',
  repairIterations: 'unknown',
  humanInterventions: 'unknown',
};

export async function runEvalTask(options: RunEvalTaskOptions): Promise<EvalResult> {
  validateEvalTask(options.task);
  if (!options.task.profiles.includes(options.profile)) {
    throw new Error(`task ${options.task.id} does not support profile ${options.profile}`);
  }
  if (!Number.isInteger(options.attempt) || options.attempt < 1) {
    throw new Error('attempt must be a positive integer');
  }
  const evalRoot = resolve(options.evalRoot);
  if (basename(evalRoot) !== 'evals') throw new Error('evalRoot must end in an evals directory');

  const runId = `${safeId(options.task.id)}-${options.profile}-a${options.attempt}-${randomUUID()}`;
  const runRoot = join(evalRoot, runId);
  const dataRoot = join(runRoot, 'data');
  const workspaceRoot = join(runRoot, 'workspace');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const started = performance.now();
  let observation: EvalObservation = {};
  let failure: EvalResult['failure'];
  try {
    observation = await options.execute({ runRoot, dataRoot, workspaceRoot });
  } catch (error) {
    failure = {
      category: 'execution',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const observationPath = join(runRoot, 'observation.json');
  await writeJsonAtomic(
    observationPath,
    failure === undefined ? observation : { observation, failure },
  );
  const evidence = await artifactRef(runRoot, observationPath, 'application/json');
  const efficiency: EvalEfficiency = {
    ...UNKNOWN_EFFICIENCY,
    ...observation.efficiency,
    durationMs,
  };
  const checks = grade(options.task, observation, efficiency, evidence);
  const result: EvalResult = {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    taskId: options.task.id,
    taskVersion: options.task.version,
    taskFingerprint: fingerprintTask(options.task),
    runnerVersion: options.runnerVersion,
    attempt: options.attempt,
    profile: options.profile,
    systemVariant: options.systemVariant,
    modelConfig: options.modelConfig,
    environment: options.environment,
    limits: options.task.limits,
    checks,
    efficiency,
    ...(failure === undefined ? {} : { failure }),
    artifactRefs: [evidence],
  };
  await writeJsonAtomic(join(runRoot, 'result.json'), result);
  return result;
}

function grade(
  task: AgoraEvalTask,
  observation: EvalObservation,
  efficiency: EvalEfficiency,
  evidence: EvalArtifactRef,
): GraderCheck[] {
  const checks: GraderCheck[] = [];
  if (task.expectedOutcome.testCommand !== undefined) {
    checks.push(
      check(
        'outcome.test-command',
        'outcome',
        statusOf(
          observation.testExitCode === undefined ? 'unknown' : observation.testExitCode === 0,
        ),
        `exitCode=${String(observation.testExitCode ?? 'unknown')}`,
        evidence,
      ),
    );
  }
  for (const file of task.expectedOutcome.requiredFiles ?? []) {
    const present = observation.files?.includes(file);
    checks.push(
      check(
        `outcome.file:${file}`,
        'outcome',
        statusOf(present ?? 'unknown'),
        present === undefined
          ? 'file inventory unavailable'
          : present
            ? 'required file present'
            : 'required file missing',
        evidence,
      ),
    );
  }
  for (const assertion of task.expectedOutcome.assertions ?? []) {
    const value = observation.assertions?.[assertion] ?? 'unknown';
    checks.push(
      check(
        `outcome.assertion:${assertion}`,
        'outcome',
        statusOf(value),
        `assertion=${String(value)}`,
        evidence,
      ),
    );
  }
  for (const invariant of task.expectedInvariants) {
    const category = invariant.startsWith('safety.') ? 'safety' : 'process';
    const value = observation.invariants?.[invariant] ?? 'unknown';
    checks.push(
      check(invariant, category, statusOf(value), `invariant=${String(value)}`, evidence),
    );
  }
  checks.push(
    check(
      'efficiency.duration',
      'efficiency',
      statusOf(efficiency.durationMs <= task.limits.maxDurationMs),
      `${efficiency.durationMs}/${task.limits.maxDurationMs}ms`,
      evidence,
    ),
  );
  checks.push(
    metricBudgetCheck('model-calls', efficiency.modelCalls, task.limits.maxModelCalls, evidence),
  );
  checks.push(
    metricBudgetCheck('tool-calls', efficiency.toolCalls, task.limits.maxToolCalls, evidence),
  );
  if (task.limits.maxCostUsd !== undefined) {
    checks.push(
      metricBudgetCheck('cost-usd', efficiency.costUsd, task.limits.maxCostUsd, evidence),
    );
  }
  return checks;
}

function metricBudgetCheck(
  id: string,
  value: number | 'unknown',
  limit: number,
  evidence: EvalArtifactRef,
): GraderCheck {
  return check(
    `efficiency.${id}`,
    'efficiency',
    value === 'unknown' ? 'unknown' : statusOf(value <= limit),
    `${String(value)}/${limit}`,
    evidence,
  );
}

function statusOf(value: boolean | 'unknown'): 'pass' | 'fail' | 'unknown' {
  return value === 'unknown' ? 'unknown' : value ? 'pass' : 'fail';
}

function check(
  id: string,
  category: GraderCheck['category'],
  status: GraderCheck['status'],
  detail: string,
  evidence: EvalArtifactRef,
): GraderCheck {
  return { id, category, status, detail, evidenceRefs: [evidence] };
}

async function artifactRef(
  runRoot: string,
  path: string,
  mediaType: string,
): Promise<EvalArtifactRef> {
  const data = await readFile(path);
  return {
    path: relative(runRoot, path),
    sha256: createHash('sha256').update(data).digest('hex'),
    mediaType,
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}
