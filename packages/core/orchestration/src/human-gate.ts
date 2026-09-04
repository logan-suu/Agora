import {
  type AppState,
  appendMutation,
  buildObjectionResolution,
  type HumanGate,
  type HumanGateRequest,
  type Mutation,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import type { TaskScope } from '@agora/runtime-state';

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ROLE_REASON = /^required_role_unavailable:([A-Za-z][A-Za-z0-9_-]*)$/;
const DEPARTURE_REASON = /^role_departure_requires_replacement:([A-Za-z][A-Za-z0-9_-]*)$/;
const OBJECTION_REASON = /^blocking_objection:([A-Za-z0-9][A-Za-z0-9._:-]*)$/;

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
}

export interface HumanGateResolutionPlan {
  receipt: HumanGateResolutionReceipt;
  mutations: readonly Mutation[];
  objectionResolution?: ObjectionResolutionAction;
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
  if (gate.reason === 'iteration_limit') {
    requireOption(input, 'continue', false);
    mutations.push(setMutation('iterationCount', 0));
  } else {
    const unavailable = ROLE_REASON.exec(gate.reason);
    const departure = DEPARTURE_REASON.exec(gate.reason);
    const objection = OBJECTION_REASON.exec(gate.reason);
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
    } else {
      throw new Error(`humanGate reason "${gate.reason}" has no Phase 8 resolver`);
    }
  }
  mutations.push(setMutation('humanGate', undefined));
  return {
    receipt: {
      gateId: gate.gateId,
      option: input.option,
      ...(input.argument === undefined ? {} : { argument: input.argument }),
      safePointRefs: [...gate.safePointRefs],
      resumeSessionId: `human-gate-resume:${input.actionId}`,
    },
    mutations,
    ...(objectionResolution === undefined ? {} : { objectionResolution }),
  };
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
