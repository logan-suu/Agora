import type { Decision } from './ledger';
import type { Objection, ObjectionTarget } from './objection';
import type { AppState, Requirement } from './state';

export type ObjectionResolutionOption = 'accept_objection' | 'reject_objection';
export type ObjectionResolutionMode = 'blocking_gate' | 'advisory_direct';

export interface BuildObjectionResolutionInput {
  actionId: string;
  objectionId: string;
  option: ObjectionResolutionOption;
  rationale: string;
  ts: number;
  mode: ObjectionResolutionMode;
}

export interface BuiltObjectionResolution {
  decision: Decision;
  requirementPatch?: { id: string; withdrawnByDecisionId: string };
}

export interface ObjectionResolutionView {
  objectionId: string;
  status: 'unresolved' | 'resolved';
  outcome?: 'accepted' | 'rejected';
  actionId?: string;
  resolutionDecisionId?: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function activeRequirements(
  state: Pick<AppState, 'requirements' | 'decisionLedger' | 'messages' | 'objections'>,
): Requirement[] {
  const canonicalResolutionIds = new Set(
    deriveObjectionResolutions(state)
      .filter((entry) => entry.status === 'resolved')
      .map((entry) => entry.resolutionDecisionId),
  );
  return state.requirements
    .filter((requirement) => {
      if (requirement.withdrawnByDecisionId === undefined) return true;
      const ruling = state.decisionLedger.find(
        (decision) => decision.id === requirement.withdrawnByDecisionId,
      );
      const target = ruling?.objectionResolution?.target;
      if (
        ruling?.authority !== 'leader' ||
        ruling.objectionResolution?.outcome !== 'accepted' ||
        target?.kind !== 'requirement' ||
        target.id !== requirement.id ||
        !canonicalResolutionIds.has(ruling.id)
      ) {
        throw new Error(
          `invalid requirement withdrawal: "${requirement.id}" does not reference its canonical Leader ruling`,
        );
      }
      return false;
    })
    .map((requirement) => ({
      ...requirement,
      acceptance: [...requirement.acceptance],
      nonGoals: [...requirement.nonGoals],
    }));
}

export function buildObjectionResolution(
  state: AppState,
  input: BuildObjectionResolutionInput,
): BuiltObjectionResolution {
  if (!SAFE_ID.test(input.actionId) || !SAFE_ID.test(input.objectionId)) {
    throw new Error('invalid objection resolution: actionId and objectionId must be safe ids');
  }
  if (input.rationale.trim().length === 0) {
    throw new Error('invalid objection resolution: a non-empty Leader rationale is required');
  }
  if (!Number.isInteger(input.ts) || input.ts < 0) {
    throw new Error('invalid objection resolution: timestamp must be a non-negative integer');
  }
  const objection = state.objections.find((candidate) => candidate.id === input.objectionId);
  if (objection === undefined) {
    throw new Error(`invalid objection resolution: unknown objection "${input.objectionId}"`);
  }
  assertMode(objection, input.mode);
  if (
    deriveObjectionResolutions(state).some(
      (entry) => entry.objectionId === objection.id && entry.status === 'resolved',
    )
  ) {
    throw new Error(
      `invalid objection resolution: objection "${objection.id}" is already resolved`,
    );
  }

  const resolutionDecisionId = `objection-resolution:${input.actionId}`;
  if (state.decisionLedger.some((decision) => decision.id === resolutionDecisionId)) {
    throw new Error(
      `invalid objection resolution: decision id "${resolutionDecisionId}" already exists`,
    );
  }
  const accepted = input.option === 'accept_objection';
  const decision: Decision = {
    id: resolutionDecisionId,
    topic: resolutionTopic(state, objection, accepted),
    decision: input.option,
    rationale: input.rationale,
    authority: 'leader',
    by: 'leader',
    ...(accepted && objection.track === 'blocking' && objection.target?.kind === 'decision'
      ? { supersedes: objection.target.id }
      : {}),
    objectionResolution: {
      objectionId: objection.id,
      outcome: accepted ? 'accepted' : 'rejected',
      ...(objection.target === undefined ? {} : { target: { ...objection.target } }),
    },
    ts: input.ts,
  };

  if (accepted && objection.track === 'blocking' && objection.target?.kind === 'requirement') {
    const requirement = state.requirements.find(
      (candidate) => candidate.id === objection.target?.id,
    );
    if (requirement === undefined || requirement.withdrawnByDecisionId !== undefined) {
      throw new Error(
        `invalid objection resolution: requirement "${objection.target.id}" is not active`,
      );
    }
    return {
      decision,
      requirementPatch: { id: requirement.id, withdrawnByDecisionId: resolutionDecisionId },
    };
  }
  return { decision };
}

export function deriveObjectionResolutions(
  state: Pick<AppState, 'objections' | 'messages' | 'decisionLedger' | 'requirements'>,
): ObjectionResolutionView[] {
  return state.objections.map((objection) => {
    const candidates = state.messages.filter((message) => {
      const record = asRecord(message.payload.objectionResolution);
      return record?.objectionId === objection.id;
    });
    if (candidates.length === 0) return { objectionId: objection.id, status: 'unresolved' };
    if (candidates.length !== 1) {
      throw new Error(
        `invalid objection resolution state: objection "${objection.id}" has conflicting resolutions`,
      );
    }
    const message = candidates[0] as (typeof candidates)[number];
    const payload = asRecord(message.payload.objectionResolution);
    const action = asRecord(message.payload.action);
    const option = payload?.option;
    const decisionId = payload?.resolutionDecisionId;
    if (
      message.fromRole !== 'leader' ||
      message.channelId !== 'main' ||
      message.type !== 'chat' ||
      message.payload.kind !== 'leader_intent' ||
      action?.status !== 'applied' ||
      (option !== 'accept_objection' && option !== 'reject_objection') ||
      decisionId !== `objection-resolution:${message.msgId}`
    ) {
      throw new Error(
        `invalid objection resolution state: objection "${objection.id}" has a malformed leader message`,
      );
    }
    const decision = state.decisionLedger.find((candidate) => candidate.id === decisionId);
    if (decision === undefined) {
      throw new Error(
        `invalid objection resolution state: missing resolution decision "${String(decisionId)}"`,
      );
    }
    const rationale = assertCanonicalLeaderMessage(objection, message, option);
    assertResolutionDecision(state, objection, message.ts, option, rationale, decision);
    return {
      objectionId: objection.id,
      status: 'resolved',
      outcome: option === 'accept_objection' ? 'accepted' : 'rejected',
      actionId: message.msgId,
      resolutionDecisionId: decision.id,
    };
  });
}

function assertCanonicalLeaderMessage(
  objection: Objection,
  message: AppState['messages'][number],
  option: ObjectionResolutionOption,
): string {
  const intent = asRecord(message.payload.intent);
  if (objection.track === 'blocking') {
    const receipt = asRecord(message.payload.resolution);
    const refs = receipt?.safePointRefs;
    if (
      intent?.kind !== 'resolve_human_gate' ||
      intent.gateId !== `human-gate:${objection.id}` ||
      intent.option !== option ||
      receipt?.gateId !== `human-gate:${objection.id}` ||
      receipt.option !== option ||
      receipt.argument !== intent.argument ||
      !Array.isArray(refs) ||
      refs.some((ref) => typeof ref !== 'string' || ref.length === 0) ||
      receipt.resumeSessionId !== `human-gate-resume:${message.msgId}`
    ) {
      throw new Error(
        `invalid objection resolution state: blocking objection "${objection.id}" has a malformed gate receipt`,
      );
    }
    if (typeof intent.argument !== 'string' || intent.argument.length === 0) {
      throw new Error(
        `invalid objection resolution state: blocking objection "${objection.id}" has no Leader rationale`,
      );
    }
    return intent.argument;
  }
  if (
    intent?.kind !== 'resolve_objection' ||
    intent.objectionId !== objection.id ||
    intent.option !== option ||
    typeof intent.rationale !== 'string' ||
    intent.rationale.length === 0 ||
    message.payload.resolution !== undefined
  ) {
    throw new Error(
      `invalid objection resolution state: advisory objection "${objection.id}" has a malformed direct ruling`,
    );
  }
  return intent.rationale as string;
}

function assertMode(objection: Objection, mode: ObjectionResolutionMode): void {
  if (mode === 'blocking_gate' && objection.track !== 'blocking') {
    throw new Error('invalid objection resolution: gate mode requires a blocking objection');
  }
  if (mode === 'advisory_direct' && objection.track !== 'advisory') {
    throw new Error('invalid objection resolution: direct mode requires an advisory objection');
  }
}

function resolutionTopic(state: AppState, objection: Objection, accepted: boolean): string {
  if (!accepted || objection.track === 'advisory' || objection.target === undefined) {
    return `objection:${objection.id}`;
  }
  if (objection.target.kind === 'requirement') return `requirement:${objection.target.id}`;
  const target = state.decisionLedger.find((decision) => decision.id === objection.target?.id);
  if (
    target === undefined ||
    state.decisionLedger.some((decision) => decision.supersedes === target.id)
  ) {
    throw new Error(
      `invalid objection resolution: decision "${objection.target.id}" is not current`,
    );
  }
  return target.topic;
}

function assertResolutionDecision(
  state: Pick<AppState, 'decisionLedger' | 'requirements'>,
  objection: Objection,
  messageTs: number,
  option: ObjectionResolutionOption,
  rationale: string,
  decision: Decision,
): void {
  const expectedOutcome = option === 'accept_objection' ? 'accepted' : 'rejected';
  const target = decision.objectionResolution?.target;
  if (
    decision.authority !== 'leader' ||
    decision.by !== 'leader' ||
    decision.decision !== option ||
    decision.rationale !== rationale ||
    decision.ts !== messageTs ||
    decision.objectionResolution?.objectionId !== objection.id ||
    decision.objectionResolution.outcome !== expectedOutcome ||
    !sameTarget(target, objection.target)
  ) {
    throw new Error(
      `invalid objection resolution state: resolution decision "${decision.id}" drifted`,
    );
  }
  const acceptedBlocking = option === 'accept_objection' && objection.track === 'blocking';
  if (acceptedBlocking && objection.target?.kind === 'decision') {
    if (decision.supersedes !== objection.target.id) {
      throw new Error(`invalid objection resolution state: decision target effect is missing`);
    }
  } else if (decision.supersedes !== undefined) {
    throw new Error(`invalid objection resolution state: unexpected decision target effect`);
  }
  if (objection.target?.kind === 'requirement') {
    const requirement = state.requirements.find(
      (candidate) => candidate.id === objection.target?.id,
    );
    if (
      requirement === undefined ||
      (acceptedBlocking && requirement.withdrawnByDecisionId !== decision.id) ||
      (!acceptedBlocking && requirement.withdrawnByDecisionId === decision.id)
    ) {
      throw new Error(`invalid objection resolution state: requirement target effect drifted`);
    }
  }
}

function sameTarget(
  left: ObjectionTarget | undefined,
  right: ObjectionTarget | undefined,
): boolean {
  return left?.kind === right?.kind && left?.id === right?.id;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
