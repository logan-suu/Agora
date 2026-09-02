import { createHash } from 'node:crypto';

export type EvalProfile = 'deterministic' | 'model';
export type EvalStatus = 'pass' | 'fail' | 'unknown';
export type EvalLifecycle = 'provisional' | 'final';
export type MetricValue = number | 'unknown';

export interface EvalLimits {
  maxIterations: number;
  maxDurationMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxCostUsd?: number;
}

export interface AgoraEvalTask {
  schemaVersion: 1;
  id: string;
  version: string;
  source: string;
  profiles: readonly EvalProfile[];
  goal: string;
  repository: { fixture: string; revision: string };
  leaderEvents?: ReadonlyArray<{
    at: { kind: 'phase' | 'step'; value: string | number };
    display: string;
  }>;
  expectedOutcome: {
    testCommand?: string;
    requiredFiles?: readonly string[];
    assertions?: readonly string[];
  };
  expectedInvariants: readonly string[];
  limits: EvalLimits;
}

export interface EvalArtifactRef {
  path: string;
  sha256: string;
  mediaType?: string;
}

export interface GraderCheck {
  id: string;
  category: 'outcome' | 'process' | 'efficiency' | 'safety';
  status: EvalStatus;
  value?: boolean | number | string;
  detail: string;
  evidenceRefs: EvalArtifactRef[];
}

export interface EvalModelConfig {
  provider: string;
  model: string;
  parameters: Record<string, string | number | boolean>;
  seed?: number;
}

export interface EvalEnvironment {
  sandbox: string;
  imageOrRuntime: string;
  platform: string;
}

export interface EvalEfficiency {
  durationMs: number;
  iterations: MetricValue;
  inputTokens: MetricValue;
  outputTokens: MetricValue;
  costUsd: MetricValue;
  modelCalls: MetricValue;
  toolCalls: MetricValue;
  repairIterations: MetricValue;
  humanInterventions: MetricValue;
}

export interface EvalResult {
  schemaVersion: 1;
  runId: string;
  lifecycle: EvalLifecycle;
  overallStatus: EvalStatus;
  startedAt: string;
  finishedAt: string;
  taskId: string;
  taskVersion: string;
  taskFingerprint: string;
  runnerVersion: string;
  attempt: number;
  profile: EvalProfile;
  systemVariant: string;
  modelConfig: EvalModelConfig;
  environment: EvalEnvironment;
  limits: EvalLimits;
  checks: GraderCheck[];
  efficiency: EvalEfficiency;
  failure?: { category: string; detail: string };
  artifactRefs: EvalArtifactRef[];
}

export function validateEvalTask(value: unknown): asserts value is AgoraEvalTask {
  if (!isRecord(value)) throw new Error('task must be an object');
  required(value.schemaVersion === 1, 'schemaVersion must be 1');
  for (const field of ['id', 'version', 'source', 'goal'] as const) {
    required(nonEmpty(value[field]), `${field} must be non-empty`);
  }
  required(
    Array.isArray(value.profiles) &&
      value.profiles.length > 0 &&
      value.profiles.every((entry) => entry === 'deterministic' || entry === 'model') &&
      new Set(value.profiles).size === value.profiles.length,
    'profiles must contain unique deterministic/model values',
  );
  required(isRecord(value.repository), 'repository must be an object');
  if (isRecord(value.repository)) {
    required(nonEmpty(value.repository.fixture), 'repository.fixture must be non-empty');
    required(
      nonEmpty(value.repository.revision) && value.repository.revision !== 'latest',
      'repository.revision must be pinned and cannot be latest',
    );
  }
  required(isRecord(value.expectedOutcome), 'expectedOutcome must be an object');
  if (isRecord(value.expectedOutcome)) {
    const outcome = value.expectedOutcome;
    if (outcome.testCommand !== undefined) {
      required(nonEmpty(outcome.testCommand), 'expectedOutcome.testCommand must be non-empty');
    }
    for (const field of ['requiredFiles', 'assertions'] as const) {
      if (outcome[field] !== undefined) {
        required(
          uniqueNonEmptyStrings(outcome[field]),
          `expectedOutcome.${field} must contain unique non-empty strings`,
        );
      }
    }
    required(
      outcome.testCommand !== undefined ||
        (Array.isArray(outcome.requiredFiles) && outcome.requiredFiles.length > 0) ||
        (Array.isArray(outcome.assertions) && outcome.assertions.length > 0),
      'expectedOutcome must declare at least one check',
    );
  }
  if (value.leaderEvents !== undefined) {
    required(Array.isArray(value.leaderEvents), 'leaderEvents must be an array');
    if (Array.isArray(value.leaderEvents)) {
      for (const event of value.leaderEvents) {
        required(isRecord(event), 'leaderEvents entries must be objects');
        if (!isRecord(event)) continue;
        required(isRecord(event.at), 'leaderEvents.at must be an object');
        if (isRecord(event.at)) {
          const validAt =
            (event.at.kind === 'phase' && nonEmpty(event.at.value)) ||
            (event.at.kind === 'step' && nonNegativeInteger(event.at.value));
          required(validAt, 'leaderEvents.at must contain a valid phase or step');
        }
        required(nonEmpty(event.display), 'leaderEvents.display must be non-empty');
      }
    }
  }
  required(
    Array.isArray(value.expectedInvariants) &&
      value.expectedInvariants.every(nonEmpty) &&
      new Set(value.expectedInvariants).size === value.expectedInvariants.length,
    'expectedInvariants must contain unique non-empty ids',
  );
  required(isRecord(value.limits), 'limits must be an object');
  if (isRecord(value.limits)) {
    for (const field of [
      'maxIterations',
      'maxDurationMs',
      'maxModelCalls',
      'maxToolCalls',
    ] as const) {
      required(positiveInteger(value.limits[field]), `${field} must be a positive integer`);
    }
    if (value.limits.maxCostUsd !== undefined) {
      required(
        typeof value.limits.maxCostUsd === 'number' &&
          Number.isFinite(value.limits.maxCostUsd) &&
          value.limits.maxCostUsd >= 0,
        'maxCostUsd must be a non-negative number',
      );
    }
  }
}

export function fingerprintTask(task: unknown): string {
  validateEvalTask(task);
  return createHash('sha256').update(canonicalJson(task), 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          const entry = value[key];
          if (entry === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
          return [key, canonicalize(entry)];
        }),
    );
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function uniqueNonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty) && new Set(value).size === value.length;
}

function required(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`invalid eval task: ${message}`);
}
