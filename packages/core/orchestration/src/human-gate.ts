import {
  type AppState,
  appendMutation,
  buildCompletionResolution,
  buildObjectionResolution,
  type CompletionResolutionAction,
  currentCompletionEvidence,
  type HumanGate,
  type HumanGateRequest,
  type Mutation,
  mergeByIdMutation,
  type ReviewBinding,
  setMutation,
} from '@agora/core-domain';
import type { TaskScope } from '@agora/runtime-state';

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ROLE_REASON = /^required_role_unavailable:([A-Za-z][A-Za-z0-9_-]*)$/;
const DEPARTURE_REASON = /^role_departure_requires_replacement:([A-Za-z][A-Za-z0-9_-]*)$/;
const OBJECTION_REASON = /^blocking_objection:([A-Za-z0-9][A-Za-z0-9._:-]*)$/;
const COMPLETION_REASON = /^completion_confirmation:([A-Za-z0-9][A-Za-z0-9._:-]*)$/;
const INTEGRATION_REASON = /^integration_conflict:([A-Za-z0-9][A-Za-z0-9._:-]*)$/;

export interface HumanGateResolutionInput {
  actionId: string;
  gateId: string;
  option: string;
  argument?: string;
  enabledRoles: readonly string[];
  ts?: number;
}

export interface HumanGateResolutionReceipt {
  gateId: string;
  option: string;
  argument?: string;
  safePointRefs: string[];
  resumeSessionId: string;
  workerResumes?: WorkerResumePlan[];
  completionEvidence?: ReviewBinding;
  integrationRework?: AppState['integration'];
}

export interface WorkerResumePlan {
  workerId: string;
  sourceSafePointRef: string;
  resumeSessionId: string;
}

export interface HumanGateResolutionPlan {
  receipt: HumanGateResolutionReceipt;
  mutations: readonly Mutation[];
  objectionResolution?: ObjectionResolutionAction;
  completionResolution?: CompletionResolutionAction;
}

export interface ObjectionResolutionAction {
  objectionId: string;
  option: 'accept_objection' | 'reject_objection';
  resolutionDecisionId: string;
}

export interface AdvisoryObjectionResolutionInput {
  actionId: string;
  objectionId: string;
  option: 'accept_objection' | 'reject_objection';
  rationale: string;
  ts: number;
}

export interface AdvisoryObjectionResolutionPlan {
  action: ObjectionResolutionAction;
  mutations: readonly Mutation[];
}

export interface HumanGateRequestPort {
  suspend(scope: TaskScope, request: HumanGateRequest): Promise<AppState>;
}

export interface HumanGateLifecyclePort extends HumanGateRequestPort {
  resume(scope: TaskScope, actionId: string, receipt: HumanGateResolutionReceipt): Promise<void>;
}

export function materializeHumanGate(
  request: HumanGateRequest,
  safePointRefs: readonly string[],
): HumanGate {
  assertSafeToken(request.triggerMsgId, 'humanGate triggerMsgId');
  if (!Number.isInteger(request.triggerTs) || request.triggerTs < 0) {
    throw new Error('humanGate triggerTs must be a non-negative integer');
  }
  if (request.reason.length === 0 || request.options.length === 0) {
    throw new Error('humanGate request requires a reason and at least one option');
  }
  if (new Set(request.options).size !== request.options.length) {
    throw new Error('humanGate request options must be unique');
  }
  for (const option of request.options) assertSafeToken(option, 'humanGate option');
  if (safePointRefs.some((ref) => ref.length === 0)) {
    throw new Error('humanGate safePointRefs must be non-empty opaque references');
  }
  if (new Set(safePointRefs).size !== safePointRefs.length) {
    throw new Error('humanGate safePointRefs must be unique');
  }
  return {
    gateId: `human-gate:${request.triggerMsgId}`,
    reason: request.reason,
    options: [...request.options],
    phase: request.phase,
    openedTs: request.triggerTs,
    safePointRefs: [...safePointRefs],
  };
}

export function planHumanGateResolution(
  state: AppState,
  input: HumanGateResolutionInput,
): HumanGateResolutionPlan {
  assertSafeToken(input.actionId, 'humanGate actionId');
  assertSafeToken(input.gateId, 'humanGate gateId');
  assertSafeToken(input.option, 'humanGate option');
  const gate = state.humanGate;
  if (gate === undefined) throw new Error('no active humanGate exists');
  if (gate.gateId !== input.gateId) {
    throw new Error(`gate "${input.gateId}" does not match the active gate`);
  }
  if (!gate.options.includes(input.option)) {
    throw new Error(`option "${input.option}" is not allowed by gate "${gate.gateId}"`);
  }

  const mutations: Mutation[] = [];
  let objectionResolution: ObjectionResolutionAction | undefined;
  let completionResolution: CompletionResolutionAction | undefined;
  if (gate.reason === 'iteration_limit') {
    requireOption(input, 'continue', false);
    mutations.push(setMutation('iterationCount', 0));
  } else {
    const unavailable = ROLE_REASON.exec(gate.reason);
    const departure = DEPARTURE_REASON.exec(gate.reason);
    const objection = OBJECTION_REASON.exec(gate.reason);
    const completion = COMPLETION_REASON.exec(gate.reason);
    const integration = INTEGRATION_REASON.exec(gate.reason);
    if (unavailable !== null) {
      requireOption(input, 'retry', false);
      const role = normalizeRole(unavailable[1] as string);
      if (!hasEnabledRole(input.enabledRoles, role)) {
        throw new Error(`required role "${role}" is not enabled`);
      }
    } else if (departure !== null) {
      requireOption(input, 'assign_enabled_successor', true);
      const target = normalizeRole(departure[1] as string);
      const successor = normalizeRole(input.argument as string);
      if (successor === target) throw new Error('departure successor must differ from target');
      if (!hasEnabledRole(input.enabledRoles, successor)) {
        throw new Error(`departure successor "${successor}" is not enabled`);
      }
      const blocked = state.subtasks.filter(
        (subtask) => subtask.ownerRole === target && subtask.status === 'blocked',
      );
      if (blocked.length === 0) {
        throw new Error(`departure gate for "${target}" has no blocked responsibilities`);
      }
      mutations.push(
        ...blocked.map((subtask) =>
          mergeByIdMutation('subtasks', subtask.id, { ownerRole: successor, status: 'todo' }),
        ),
      );
    } else if (objection !== null) {
      const rationale = requireRationale(input);
      if (input.option !== 'accept_objection' && input.option !== 'reject_objection') {
        throw new Error(`option "${input.option}" is not valid for this humanGate reason`);
      }
      const built = buildObjectionResolution(state, {
        actionId: input.actionId,
        objectionId: objection[1] as string,
        option: input.option,
        rationale,
        ts: input.ts ?? gate.openedTs,
        mode: 'blocking_gate',
      });
      mutations.push(appendMutation('decisionLedger', built.decision));
      objectionResolution = {
        objectionId: objection[1] as string,
        option: input.option,
        resolutionDecisionId: built.decision.id,
      };
      if (built.requirementPatch !== undefined) {
        mutations.push(
          mergeByIdMutation('requirements', built.requirementPatch.id, built.requirementPatch),
        );
      }
    } else if (completion !== null) {
      if (input.option !== 'approve_completion' && input.option !== 'request_changes') {
        throw new Error(`option "${input.option}" is not valid for this humanGate reason`);
      }
      const built = buildCompletionResolution(state, {
        actionId: input.actionId,
        reviewId: completion[1] as string,
        option: input.option,
        ...(input.argument === undefined ? {} : { rationale: input.argument }),
        ts: input.ts ?? gate.openedTs,
      });
      mutations.push(appendMutation('decisionLedger', built.decision));
      completionResolution = built.action;
    } else if (integration !== null) {
      requireOption(input, 'request_rework', true);
      const workerId = input.argument as string;
      const current = state.integration;
      if (
        current === undefined ||
        current.integrationId !== integration[1] ||
        current.status !== 'conflict'
      ) {
        throw new Error('integration conflict gate does not match canonical Integration');
      }
      const conflict = current.conflicts.find((entry) => entry.workerId === workerId);
      if (conflict === undefined) {
        throw new Error(`worker "${workerId}" is not an integration conflict contributor`);
      }
      const subtask = state.subtasks.find((entry) => entry.id === conflict.subtaskId);
      if (subtask === undefined) throw new Error('integration conflict subtask is missing');
      if (state.parallelExecution !== undefined) {
        const execution = state.parallelExecution;
        const wave = execution.activeWave;
        if (
          wave === undefined ||
          wave.waveId !== current.waveId ||
          !wave.coderWorkerIds.includes(workerId)
        )
          throw new Error('integration rework is not a current wave contribution');
        const dispatchId = `integration-rework:${input.actionId}`;
        const replacementId = `worker:${dispatchId}:0`;
        const { validation: _validation, ...coding } = wave;
        mutations.push(
          mergeByIdMutation('workers', replacementId, {
            workerId: replacementId,
            role: 'CODER',
            subtaskId: conflict.subtaskId,
            executor: 'harness',
            status: 'pending',
            sessionId: `session:${replacementId}`,
            startedTs: input.ts ?? gate.openedTs,
          }),
          mergeByIdMutation('subtasks', conflict.subtaskId, {
            status: 'in_progress',
            worktree: undefined,
          }),
          setMutation('parallelExecution', {
            ...execution,
            activeWave: {
              ...coding,
              attempt: wave.attempt + 1,
              coderWorkerIds: wave.coderWorkerIds.map((id) =>
                id === workerId ? replacementId : id,
              ),
            },
          }),
          setMutation('integration', undefined),
          setMutation('phase', 'coding'),
          setMutation('nextRole', 'CODER'),
          setMutation('iterationCount', state.iterationCount + 1),
        );
      } else {
        const { resultCommit: _resultCommit, ...withoutResult } = current;
        mutations.push(
          mergeByIdMutation('subtasks', conflict.subtaskId, { status: 'todo' }),
          setMutation('integration', {
            ...withoutResult,
            mergedBranches: [],
            conflicts: [],
            status: 'idle',
          }),
        );
      }
    } else {
      throw new Error(`humanGate reason "${gate.reason}" has no resolver`);
    }
  }
  mutations.push(setMutation('humanGate', undefined));
  const workerResumes = deriveHumanGateWorkerResumes(state, gate, input.actionId);
  return {
    receipt: {
      ...(state.parallelExecution !== undefined && input.option === 'request_rework'
        ? { integrationRework: state.integration }
        : {}),
      ...(completionResolution === undefined || state.parallelExecution === undefined
        ? {}
        : { completionEvidence: currentCompletionEvidence(state) }),
      gateId: gate.gateId,
      option: input.option,
      ...(input.argument === undefined ? {} : { argument: input.argument }),
      safePointRefs: [...gate.safePointRefs],
      resumeSessionId: `human-gate-resume:${input.actionId}`,
      ...(workerResumes === undefined ? {} : { workerResumes }),
    },
    mutations,
    ...(objectionResolution === undefined ? {} : { objectionResolution }),
    ...(completionResolution === undefined ? {} : { completionResolution }),
  };
}

export function deriveHumanGateWorkerResumes(
  state: AppState,
  gate: HumanGate,
  actionId: string,
): WorkerResumePlan[] | undefined {
  assertSafeToken(actionId, 'humanGate actionId');
  const paused = state.workers
    .filter((worker) => worker.status === 'paused')
    .sort((left, right) => left.workerId.localeCompare(right.workerId));
  if (paused.length === 0) return undefined;
  const pausedRefs = paused.map((worker) => worker.safePoint);
  const gateRefs = new Set(gate.safePointRefs);
  if (
    pausedRefs.some((ref) => ref === undefined || ref.length === 0) ||
    new Set(pausedRefs).size !== paused.length ||
    gateRefs.size !== gate.safePointRefs.length ||
    gateRefs.size !== paused.length ||
    pausedRefs.some((ref) => !gateRefs.has(ref as string))
  ) {
    throw new Error('humanGate safePointRefs must match paused workers one-to-one');
  }
  return paused.map((worker) => {
    assertSafeToken(worker.workerId, 'paused workerId');
    return {
      workerId: worker.workerId,
      sourceSafePointRef: worker.safePoint as string,
      resumeSessionId: `human-gate-resume:${actionId}:${worker.workerId}`,
    };
  });
}

export function validateHumanGateWorkerResumes(
  state: AppState,
  actionId: string,
  safePointRefs: readonly string[],
  value: unknown,
): WorkerResumePlan[] | undefined {
  assertSafeToken(actionId, 'humanGate actionId');
  const paused = state.workers
    .filter((worker) => worker.status === 'paused')
    .sort((left, right) => left.workerId.localeCompare(right.workerId));
  if (value === undefined) {
    if (paused.length > 0) {
      throw new Error('humanGate worker resume receipt is missing for paused workers');
    }
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('humanGate worker resume receipt must be a non-empty array');
  }
  const plans = value.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'resumeSessionId,sourceSafePointRef,workerId'
    ) {
      throw new Error('humanGate worker resume entry has an invalid shape');
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.workerId !== 'string' ||
      typeof record.sourceSafePointRef !== 'string' ||
      typeof record.resumeSessionId !== 'string'
    ) {
      throw new Error('humanGate worker resume entry requires string fields');
    }
    assertSafeToken(record.workerId, 'humanGate resume workerId');
    return {
      workerId: record.workerId,
      sourceSafePointRef: record.sourceSafePointRef,
      resumeSessionId: record.resumeSessionId,
    };
  });
  const workerIds = plans.map((plan) => plan.workerId);
  const planRefs = plans.map((plan) => plan.sourceSafePointRef);
  if (
    new Set(workerIds).size !== plans.length ||
    new Set(planRefs).size !== plans.length ||
    new Set(safePointRefs).size !== safePointRefs.length ||
    safePointRefs.length !== plans.length ||
    paused.length !== plans.length ||
    plans.some(
      (plan, index) => index > 0 && (workerIds[index - 1]?.localeCompare(plan.workerId) ?? 0) >= 0,
    ) ||
    plans.some(
      (plan) =>
        plan.resumeSessionId !== `human-gate-resume:${actionId}:${plan.workerId}` ||
        !safePointRefs.includes(plan.sourceSafePointRef) ||
        !paused.some(
          (worker) =>
            worker.workerId === plan.workerId && worker.safePoint === plan.sourceSafePointRef,
        ),
    )
  ) {
    throw new Error('humanGate worker resume receipt conflicts with canonical paused workers');
  }
  return plans;
}

export function planAdvisoryObjectionResolution(
  state: AppState,
  input: AdvisoryObjectionResolutionInput,
): AdvisoryObjectionResolutionPlan {
  const built = buildObjectionResolution(state, {
    actionId: input.actionId,
    objectionId: input.objectionId,
    option: input.option,
    rationale: input.rationale,
    ts: input.ts,
    mode: 'advisory_direct',
  });
  return {
    action: {
      objectionId: input.objectionId,
      option: input.option,
      resolutionDecisionId: built.decision.id,
    },
    mutations: [appendMutation('decisionLedger', built.decision)],
  };
}

function requireRationale(input: HumanGateResolutionInput): string {
  if (input.argument === undefined || input.argument.trim().length === 0) {
    throw new Error(`option "${input.option}" requires a Leader rationale`);
  }
  if (input.argument.length > 2000) {
    throw new Error('humanGate rationale must not exceed 2000 characters');
  }
  return input.argument;
}

function requireOption(
  input: HumanGateResolutionInput,
  expected: string,
  argumentRequired: boolean,
): void {
  if (input.option !== expected) {
    throw new Error(`option "${input.option}" is not valid for this humanGate reason`);
  }
  if (argumentRequired && input.argument === undefined) {
    throw new Error(`option "${expected}" requires an argument`);
  }
  if (!argumentRequired && input.argument !== undefined) {
    throw new Error(`option "${expected}" does not accept an argument`);
  }
  if (input.argument !== undefined) assertSafeToken(input.argument, 'humanGate argument');
}

function hasEnabledRole(enabledRoles: readonly string[], role: string): boolean {
  return enabledRoles.some((candidate) => normalizeRole(candidate) === role);
}

function normalizeRole(role: string): string {
  return role.toUpperCase();
}

function assertSafeToken(value: string, field: string): void {
  if (!SAFE_TOKEN.test(value)) throw new Error(`${field} must be a safe non-empty token`);
}
