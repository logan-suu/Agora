import type { AppState, Message, TestResults, WorktreeRef } from './state';
import { isGitObjectId, isWorktreeRef } from './state';

export interface ExecutionPlan {
  version: 1;
  subtasks: { id: string; title: string; dependsOn: string[] }[];
}

export interface ParallelExecution {
  version: 1;
  planId: string;
  initialBase: { branch: string; commit: string };
  acceptedReceiptId?: string;
  activeWave?: {
    waveId: string;
    attempt: number;
    base: { branch: string; commit: string };
    subtaskIds: string[];
    coderWorkerIds: string[];
    preparationWorkerId?: string;
    validation?: {
      dispatchId: string;
      workerId: string;
      integrationId: string;
      inputCommit: string;
      worktree?: WorktreeRef;
      receiptId?: string;
    };
  };
}

export type ExecutionWave = NonNullable<ParallelExecution['activeWave']>;

export interface ReviewBinding {
  planId: string;
  validationReceiptId: string;
  commit: string;
  controlFingerprint: string;
}

export interface WaveValidationReceipt {
  kind: 'wave_validation';
  version: 1;
  planId: string;
  waveId: string;
  attempt: number;
  dispatchId: string;
  workerId: string;
  integrationId: string;
  inputCommit: string;
  worktree: WorktreeRef;
  subtaskIds: string[];
  controlFingerprint: string;
  results: TestResults;
  evidence: { path: string; sha256: string; exitCode: number; timedOut: boolean };
}

export const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const id = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_EXECUTION_ID.test(value);
const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const ids = (value: unknown, allowEmpty = false): value is string[] =>
  Array.isArray(value) &&
  (allowEmpty || value.length > 0) &&
  value.every(id) &&
  new Set(value).size === value.length;

export function isExecutionPlan(value: unknown): value is ExecutionPlan {
  if (
    !record(value) ||
    !keys(value, ['version', 'subtasks']) ||
    value.version !== 1 ||
    !Array.isArray(value.subtasks) ||
    value.subtasks.length === 0
  )
    return false;
  const nodes = value.subtasks;
  if (
    !nodes.every(
      (node) =>
        record(node) &&
        keys(node, ['id', 'title', 'dependsOn']) &&
        id(node.id) &&
        nonEmpty(node.title) &&
        ids(node.dependsOn, true),
    )
  )
    return false;
  const typed = nodes as ExecutionPlan['subtasks'];
  const graph = new Map(typed.map((node) => [node.id, node.dependsOn]));
  if (
    graph.size !== nodes.length ||
    typed.some((node) => node.dependsOn.some((dependency) => !graph.has(dependency)))
  )
    return false;
  // Kahn's algorithm avoids recursion limits on untrusted model plans.
  const remaining = new Map(typed.map((node) => [node.id, new Set(node.dependsOn)]));
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([nodeId]) => nodeId);
    if (ready.length === 0) return false;
    for (const nodeId of ready) {
      remaining.delete(nodeId);
      for (const dependencies of remaining.values()) dependencies.delete(nodeId);
    }
  }
  return true;
}

export function executionPlanFromArchitecture(architecture: Record<string, unknown> = {}): {
  plan: ExecutionPlan;
  degraded: boolean;
} {
  if (Object.hasOwn(architecture, 'executionPlan')) {
    if (!isExecutionPlan(architecture.executionPlan))
      throw new Error('invalid architecture.executionPlan DAG');
    return { plan: structuredClone(architecture.executionPlan), degraded: false };
  }
  const modules = architecture.modules;
  if (modules !== undefined && (!Array.isArray(modules) || !modules.every(nonEmpty)))
    throw new Error('legacy modules must be non-empty strings');
  const titles =
    Array.isArray(modules) && modules.length > 0
      ? (modules as string[])
      : ['Implement the requested change'];
  return {
    degraded: true,
    plan: {
      version: 1,
      subtasks: titles.map((title, index) => ({
        id: `module-${index + 1}`,
        title,
        dependsOn: index === 0 ? [] : [`module-${index}`],
      })),
    },
  };
}

export function reopenClosure(plan: ExecutionPlan, targets: readonly string[]): string[] {
  if (
    !isExecutionPlan(plan) ||
    !ids(targets) ||
    targets.some((target) => !plan.subtasks.some((node) => node.id === target))
  )
    throw new Error('rework subtaskIds must be unique non-empty current-plan references');
  const selected = new Set(targets);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of plan.subtasks) {
      if (!selected.has(node.id) && node.dependsOn.some((dependency) => selected.has(dependency))) {
        selected.add(node.id);
        changed = true;
      }
    }
  }
  return [...selected].sort();
}

function isBase(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, ['branch', 'commit']) &&
    isWorktreeRef({ path: '/base', branch: value.branch, baseCommit: value.commit })
  );
}

export function isParallelExecution(value: unknown): value is ParallelExecution {
  if (
    !record(value) ||
    !keys(value, ['version', 'planId', 'initialBase', 'acceptedReceiptId', 'activeWave']) ||
    value.version !== 1 ||
    !id(value.planId) ||
    !isBase(value.initialBase) ||
    (value.acceptedReceiptId !== undefined && !id(value.acceptedReceiptId))
  )
    return false;
  const wave = value.activeWave;
  if (wave === undefined) return true;
  if (
    !record(wave) ||
    !keys(wave, [
      'waveId',
      'attempt',
      'base',
      'subtaskIds',
      'coderWorkerIds',
      'preparationWorkerId',
      'validation',
    ]) ||
    !id(wave.waveId) ||
    !Number.isSafeInteger(wave.attempt) ||
    (wave.attempt as number) < 1 ||
    !isBase(wave.base) ||
    !ids(wave.subtaskIds) ||
    !ids(wave.coderWorkerIds) ||
    wave.subtaskIds.length !== wave.coderWorkerIds.length ||
    (wave.preparationWorkerId !== undefined &&
      (!id(wave.preparationWorkerId) || wave.coderWorkerIds.includes(wave.preparationWorkerId)))
  )
    return false;
  const validation = wave.validation;
  return (
    validation === undefined ||
    (record(validation) &&
      keys(validation, [
        'dispatchId',
        'workerId',
        'integrationId',
        'inputCommit',
        'worktree',
        'receiptId',
      ]) &&
      id(validation.dispatchId) &&
      validation.workerId === `worker:${validation.dispatchId}:0` &&
      !wave.coderWorkerIds.includes(validation.workerId) &&
      id(validation.integrationId) &&
      isGitObjectId(validation.inputCommit) &&
      (validation.worktree === undefined ||
        (isWorktreeRef(validation.worktree) &&
          validation.worktree.baseCommit === validation.inputCommit)) &&
      (validation.receiptId === undefined ||
        validation.receiptId === `wave-validation:${validation.dispatchId}`))
  );
}

export function isStrictTestResults(value: unknown): value is TestResults {
  if (
    !record(value) ||
    !keys(value, ['passed', 'total', 'failed', 'failures', 'coverage']) ||
    typeof value.passed !== 'boolean' ||
    !Number.isSafeInteger(value.total) ||
    (value.total as number) <= 0 ||
    !Number.isSafeInteger(value.failed) ||
    (value.failed as number) < 0 ||
    (value.failed as number) > (value.total as number) ||
    !Array.isArray(value.failures) ||
    value.failures.length !== value.failed ||
    value.passed !== (value.failed === 0) ||
    (value.coverage !== undefined &&
      (typeof value.coverage !== 'number' ||
        !Number.isFinite(value.coverage) ||
        value.coverage < 0 ||
        value.coverage > 100))
  )
    return false;
  return value.failures.every(
    (failure) =>
      record(failure) &&
      keys(failure, ['test', 'message', 'file', 'line']) &&
      nonEmpty(failure.test) &&
      nonEmpty(failure.message) &&
      typeof failure.file === 'string' &&
      Number.isSafeInteger(failure.line) &&
      (failure.line as number) >= 0,
  );
}

export function isReviewBinding(value: unknown): value is ReviewBinding {
  return (
    record(value) &&
    keys(value, ['planId', 'validationReceiptId', 'commit', 'controlFingerprint']) &&
    id(value.planId) &&
    id(value.validationReceiptId) &&
    isGitObjectId(value.commit) &&
    typeof value.controlFingerprint === 'string' &&
    SHA256.test(value.controlFingerprint)
  );
}

export function isWaveValidationReceipt(value: unknown): value is WaveValidationReceipt {
  if (
    !record(value) ||
    !keys(value, [
      'kind',
      'version',
      'planId',
      'waveId',
      'attempt',
      'dispatchId',
      'workerId',
      'integrationId',
      'inputCommit',
      'worktree',
      'subtaskIds',
      'controlFingerprint',
      'results',
      'evidence',
    ]) ||
    value.kind !== 'wave_validation' ||
    value.version !== 1 ||
    !id(value.planId) ||
    !id(value.waveId) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !id(value.dispatchId) ||
    value.workerId !== `worker:${value.dispatchId}:0` ||
    !id(value.integrationId) ||
    !isGitObjectId(value.inputCommit) ||
    !isWorktreeRef(value.worktree) ||
    value.worktree.baseCommit !== value.inputCommit ||
    !isGitObjectId(value.worktree.headCommit) ||
    !ids(value.subtaskIds) ||
    typeof value.controlFingerprint !== 'string' ||
    !SHA256.test(value.controlFingerprint) ||
    !isStrictTestResults(value.results)
  )
    return false;
  const evidence = value.evidence;
  return (
    record(evidence) &&
    keys(evidence, ['path', 'sha256', 'exitCode', 'timedOut']) &&
    typeof evidence.path === 'string' &&
    /^validation\/[A-Za-z0-9][A-Za-z0-9._:-]*\.json$/.test(evidence.path) &&
    typeof evidence.sha256 === 'string' &&
    SHA256.test(evidence.sha256) &&
    Number.isSafeInteger(evidence.exitCode) &&
    typeof evidence.timedOut === 'boolean' &&
    (!value.results.passed || (evidence.exitCode === 0 && evidence.timedOut === false))
  );
}

export function validationReceipt(state: AppState, receiptId: string): WaveValidationReceipt {
  const matches = state.messages.filter((message) => message.msgId === receiptId);
  const message = matches[0];
  if (
    matches.length !== 1 ||
    message === undefined ||
    message.fromRole !== 'COORDINATOR' ||
    message.type !== 'announce' ||
    message.channelId !== 'main' ||
    !isWaveValidationReceipt(message.payload) ||
    message.msgId !== `wave-validation:${message.payload.dispatchId}`
  )
    throw new Error(`invalid validation receipt ${receiptId}`);
  const receipt = message.payload;
  const worker = state.workers.find((candidate) => candidate.workerId === receipt.workerId);
  const dispatch = state.messages.find((candidate) => candidate.msgId === receipt.dispatchId);
  if (
    worker === undefined ||
    worker.role !== 'TESTER' ||
    worker.subtaskId !== undefined ||
    dispatch?.fromRole !== 'COORDINATOR' ||
    dispatch.type !== 'announce' ||
    dispatch.payload.kind !== 'wave_validation_dispatch' ||
    dispatch.payload.planId !== receipt.planId ||
    dispatch.payload.waveId !== receipt.waveId ||
    dispatch.payload.attempt !== receipt.attempt ||
    dispatch.payload.integrationId !== receipt.integrationId ||
    dispatch.payload.inputCommit !== receipt.inputCommit ||
    state.messages.indexOf(dispatch) >= state.messages.indexOf(message) ||
    canonicalJson(dispatch.payload.subtaskIds) !== canonicalJson(receipt.subtaskIds)
  )
    throw new Error(`validation receipt ${receiptId} has drifted dispatch identity`);
  validationSourceReceipt(state, receipt.dispatchId);
  return receipt;
}

/** Resolve only an earlier, identity-bound cumulative validation source. */
export function validationSourceReceipt(
  state: AppState,
  dispatchId: string,
): { receiptId: string; receipt: WaveValidationReceipt } | undefined {
  const dispatchIndex = state.messages.findIndex((message) => message.msgId === dispatchId);
  const dispatch = state.messages[dispatchIndex];
  if (
    dispatch?.fromRole !== 'COORDINATOR' ||
    dispatch.type !== 'announce' ||
    dispatch.payload.kind !== 'wave_validation_dispatch'
  )
    throw new Error('validation requires its canonical dispatch');
  const sourceId = dispatch.payload.sourceReceiptId;
  if (sourceId === undefined) return undefined;
  const sourceIndex = state.messages.findIndex((message) => message.msgId === sourceId);
  if (typeof sourceId !== 'string' || sourceIndex < 0 || sourceIndex >= dispatchIndex)
    throw new Error('validation source receipt must precede its dispatch');
  const receipt = validationReceipt(state, sourceId);
  if (
    receipt.waveId !== dispatch.payload.waveId ||
    receipt.attempt !== dispatch.payload.attempt ||
    receipt.integrationId !== dispatch.payload.integrationId ||
    receipt.worktree.headCommit !== dispatch.payload.inputCommit ||
    canonicalJson(receipt.subtaskIds) !== canonicalJson(dispatch.payload.subtaskIds)
  )
    throw new Error('validation source receipt identity drifted');
  return { receiptId: sourceId, receipt };
}

export function currentReviewDispatch(state: AppState): Message | undefined {
  return [...state.messages]
    .reverse()
    .find(
      (message) =>
        message.fromRole === 'COORDINATOR' &&
        message.type === 'announce' &&
        message.payload.nextRole === 'REVIEWER',
    );
}

export function assertParallelState(state: AppState): void {
  if (
    state.architecture !== undefined &&
    Object.hasOwn(state.architecture, 'executionPlan') &&
    !isExecutionPlan(state.architecture.executionPlan)
  )
    throw new Error('invalid architecture.executionPlan DAG');
  for (const message of state.messages) {
    if (
      message.payload?.kind === 'wave_validation' &&
      (!isWaveValidationReceipt(message.payload) ||
        message.fromRole !== 'COORDINATOR' ||
        message.type !== 'announce' ||
        message.msgId !== `wave-validation:${message.payload.dispatchId}`)
    )
      throw new Error('invalid wave_validation message');
  }
  const execution = state.parallelExecution;
  if (execution === undefined) return;
  if (!isParallelExecution(execution)) throw new Error('invalid parallelExecution');
  const planMessage = state.messages.find((message) => message.msgId === execution.planId);
  if (
    planMessage?.fromRole !== 'COORDINATOR' ||
    planMessage.type !== 'announce' ||
    planMessage.payload.kind !== 'execution_plan' ||
    !isExecutionPlan(planMessage.payload.plan)
  )
    throw new Error('parallelExecution requires its canonical execution_plan control fact');
  for (const node of planMessage.payload.plan.subtasks) {
    const subtask = state.subtasks.find((candidate) => candidate.id === node.id);
    if (
      subtask === undefined ||
      subtask.ownerRole !== 'CODER' ||
      subtask.title !== node.title ||
      canonicalJson(subtask.dependsOn) !== canonicalJson(node.dependsOn)
    )
      throw new Error(`execution plan subtask ${node.id} drifted`);
  }
  if (execution.acceptedReceiptId !== undefined) {
    const receipt = validationReceipt(state, execution.acceptedReceiptId);
    if (!receipt.results.passed) throw new Error('accepted validation receipt must have passed');
  }
  const wave = execution.activeWave;
  if (wave === undefined) return;
  if (
    !state.messages.some(
      (message) =>
        message.msgId === wave.waveId &&
        message.fromRole === 'COORDINATOR' &&
        message.payload.kind === 'coding_wave',
    )
  )
    throw new Error('active wave requires its canonical coding_wave control fact');
  for (const [index, subtaskId] of wave.subtaskIds.entries()) {
    const worker = state.workers.find(
      (candidate) => candidate.workerId === wave.coderWorkerIds[index],
    );
    if (
      !planMessage.payload.plan.subtasks.some((node) => node.id === subtaskId) ||
      worker?.role !== 'CODER' ||
      worker.subtaskId !== subtaskId
    )
      throw new Error('wave worker/subtask assignment mismatch');
  }
  if (wave.validation !== undefined) {
    validationSourceReceipt(state, wave.validation.dispatchId);
    const worker = state.workers.find(
      (candidate) => candidate.workerId === wave.validation?.workerId,
    );
    if (worker?.role !== 'TESTER' || worker.subtaskId !== undefined)
      throw new Error('invalid validation worker assignment');
    if (wave.validation.receiptId !== undefined) {
      const receipt = validationReceipt(state, wave.validation.receiptId);
      if (
        receipt.planId !== execution.planId ||
        receipt.waveId !== wave.waveId ||
        receipt.attempt !== wave.attempt ||
        receipt.integrationId !== wave.validation.integrationId ||
        receipt.inputCommit !== wave.validation.inputCommit ||
        canonicalJson(receipt.subtaskIds) !== canonicalJson(validationSubtaskIds(state, wave))
      )
        throw new Error('active validation receipt identity mismatch');
    }
  }
}

/** Include unchanged contributions retained by a canonical root-cause repair. */
export function validationSubtaskIds(state: AppState, wave: ExecutionWave): string[] {
  const waveIndex = state.messages.findIndex((message) => message.msgId === wave.waveId);
  const dispatch = state.messages[waveIndex];
  if (
    dispatch?.fromRole !== 'COORDINATOR' ||
    dispatch.type !== 'announce' ||
    dispatch.channelId !== 'main' ||
    dispatch.payload.kind !== 'coding_wave'
  )
    throw new Error('validation scope requires its canonical coding wave');
  const sourceId = dispatch.payload.reworkSourceMsgId;
  if (sourceId === undefined) return [...wave.subtaskIds];
  const sourceIndex = state.messages.findIndex((message) => message.msgId === sourceId);
  const source = state.messages[sourceIndex];
  if (
    !id(sourceId) ||
    sourceIndex < 0 ||
    sourceIndex >= waveIndex ||
    source?.fromRole !== 'COORDINATOR' ||
    source.type !== 'announce' ||
    source.channelId !== 'main' ||
    source.payload.kind !== 'review_rework' ||
    !ids(source.payload.subtaskIds) ||
    !id(source.payload.failedReceiptId)
  )
    throw new Error('validation scope requires an earlier canonical review rework');
  const planIndex = state.messages.findIndex(
    (message) => message.msgId === dispatch.payload.planId,
  );
  const planMessage = state.messages[planIndex];
  if (
    planIndex < 0 ||
    planIndex >= waveIndex ||
    planMessage?.fromRole !== 'COORDINATOR' ||
    planMessage.type !== 'announce' ||
    planMessage.payload.kind !== 'execution_plan' ||
    !isExecutionPlan(planMessage.payload.plan)
  )
    throw new Error('validation repair requires its historical canonical plan');
  const plan = planMessage.payload.plan;
  const targets = source.payload.subtaskIds;
  if (
    canonicalJson(reopenClosure(plan, targets)) !== canonicalJson([...targets].sort()) ||
    wave.subtaskIds.some((subtaskId) => !targets.includes(subtaskId))
  )
    throw new Error('validation repair scope drifted from its rework closure');
  const receiptIndex = state.messages.findIndex(
    (message) => message.msgId === source.payload.failedReceiptId,
  );
  if (receiptIndex < 0 || receiptIndex >= sourceIndex)
    throw new Error('validation rework receipt must precede its control fact');
  const receipt = validationReceipt(state, source.payload.failedReceiptId);
  if (receipt.planId !== dispatch.payload.planId)
    throw new Error('validation rework receipt belongs to another plan');
  if (
    !record(dispatch.payload.base) ||
    dispatch.payload.base.commit !== receipt.worktree.headCommit ||
    dispatch.payload.base.branch !== receipt.worktree.branch
  )
    throw new Error('validation repair base does not preserve its cumulative receipt');
  const retained = receipt.results.passed
    ? []
    : receipt.subtaskIds.filter((subtaskId) => !targets.includes(subtaskId));
  if (retained.some((subtaskId) => !plan.subtasks.some((node) => node.id === subtaskId)))
    throw new Error('validation retained contribution is outside the current plan');
  return [...new Set([...wave.subtaskIds, ...retained])].sort();
}

export function adoptedExecutionPlan(state: AppState): ExecutionPlan {
  const message = state.messages.find(
    (candidate) => candidate.msgId === state.parallelExecution?.planId,
  );
  if (!isExecutionPlan(message?.payload.plan)) throw new Error('missing adopted execution plan');
  return message.payload.plan;
}

/** Stable input encoding; SHA-256 is supplied by the infrastructure adapter. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
