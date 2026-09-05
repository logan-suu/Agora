import type { Decision } from './ledger';
import type { AppState, Message } from './state';

export const DEFAULT_COMPLETION_APPROVAL_RATIONALE =
  'Leader approved the current completion candidate.';

export type CompletionResolutionOption = 'approve_completion' | 'request_changes';

export interface BuildCompletionResolutionInput {
  actionId: string;
  reviewId: string;
  option: CompletionResolutionOption;
  rationale?: string;
  ts: number;
}

export interface CompletionResolutionAction {
  reviewId: string;
  option: CompletionResolutionOption;
  resolutionDecisionId: string;
}

export interface BuiltCompletionResolution {
  action: CompletionResolutionAction;
  decision: Decision;
}

export interface CompletionResolutionView extends CompletionResolutionAction {
  actionId: string;
  rationale: string;
  resumed: boolean;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function currentApprovedReviewId(state: AppState): string {
  let cursor: number | undefined;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (
      message?.fromRole === 'COORDINATOR' &&
      message.type === 'announce' &&
      message.payload.nextRole === 'REVIEWER'
    ) {
      const recorded = message.payload.reviewCommentCursor;
      if (
        typeof recorded !== 'number' ||
        !Number.isInteger(recorded) ||
        recorded < 0 ||
        recorded > state.reviewComments.length
      ) {
        throw new Error('current REVIEWER dispatch requires a valid reviewCommentCursor');
      }
      cursor = recorded;
      break;
    }
  }
  if (cursor === undefined) {
    throw new Error('completion resolution requires a current REVIEWER dispatch');
  }
  const verdicts = state.reviewComments.slice(cursor).filter((entry) => entry.kind === 'verdict');
  if (verdicts.length !== 1) {
    throw new Error(
      `completion resolution requires exactly one current REVIEWER verdict; got ${verdicts.length}`,
    );
  }
  const verdict = verdicts[0];
  if (
    verdict?.verdict !== 'approved' ||
    typeof verdict.id !== 'string' ||
    !SAFE_ID.test(verdict.id)
  ) {
    throw new Error('completion resolution requires a safe current REVIEWER approved verdict');
  }
  return verdict.id;
}

export function buildCompletionResolution(
  state: AppState,
  input: BuildCompletionResolutionInput,
): BuiltCompletionResolution {
  if (input.option !== 'approve_completion' && input.option !== 'request_changes') {
    throw new Error(
      'invalid completion resolution: option must be "approve_completion" or "request_changes"',
    );
  }
  if (!SAFE_ID.test(input.actionId) || !SAFE_ID.test(input.reviewId)) {
    throw new Error('invalid completion resolution: actionId and reviewId must be safe ids');
  }
  if (!Number.isInteger(input.ts) || input.ts < 0) {
    throw new Error('invalid completion resolution: timestamp must be a non-negative integer');
  }
  if (currentApprovedReviewId(state) !== input.reviewId) {
    throw new Error(
      `completion resolution review "${input.reviewId}" is not the current REVIEWER verdict`,
    );
  }
  const rationale = completionRationale(input.option, input.rationale);
  const resolutionDecisionId = `task-completion-resolution:${input.actionId}`;
  if (state.decisionLedger.some((decision) => decision.id === resolutionDecisionId)) {
    throw new Error(`completion resolution decision "${resolutionDecisionId}" already exists`);
  }
  return {
    action: { reviewId: input.reviewId, option: input.option, resolutionDecisionId },
    decision: {
      id: resolutionDecisionId,
      topic: `task-completion:${state.taskId}`,
      decision: input.option,
      rationale,
      authority: 'leader',
      by: 'leader',
      ts: input.ts,
    },
  };
}

export function deriveCompletionResolution(
  state: AppState,
  reviewId: string,
): CompletionResolutionView | undefined {
  if (currentApprovedReviewId(state) !== reviewId) {
    throw new Error(
      `completion resolution review "${reviewId}" is not the current REVIEWER verdict`,
    );
  }
  const messages = state.messages.filter(
    (message) => asRecord(message.payload.completionResolution)?.reviewId === reviewId,
  );
  if (messages.length === 0) return undefined;
  if (messages.length !== 1) {
    throw new Error(`completion resolution for review "${reviewId}" has conflicting messages`);
  }
  const message = messages[0] as Message;
  const completion = asRecord(message.payload.completionResolution);
  const intent = asRecord(message.payload.intent);
  const action = asRecord(message.payload.action);
  const receipt = asRecord(message.payload.resolution);
  const option = completion?.option;
  const decisionId = completion?.resolutionDecisionId;
  const gateId = `human-gate:${reviewId}`;
  const safePointRefs = receipt?.safePointRefs;
  if (
    message.fromRole !== 'leader' ||
    message.channelId !== 'main' ||
    message.type !== 'chat' ||
    message.payload.kind !== 'leader_intent' ||
    action?.status !== 'applied' ||
    intent?.kind !== 'resolve_human_gate' ||
    intent.gateId !== gateId ||
    (option !== 'approve_completion' && option !== 'request_changes') ||
    intent.option !== option ||
    receipt?.gateId !== gateId ||
    receipt.option !== option ||
    receipt.argument !== intent.argument ||
    !Array.isArray(safePointRefs) ||
    safePointRefs.some((ref) => typeof ref !== 'string' || ref.length === 0) ||
    new Set(safePointRefs).size !== safePointRefs.length ||
    receipt.resumeSessionId !== `human-gate-resume:${message.msgId}` ||
    decisionId !== `task-completion-resolution:${message.msgId}`
  ) {
    throw new Error(`completion resolution for review "${reviewId}" has malformed facts`);
  }
  const rationale = completionRationale(
    option,
    typeof intent.argument === 'string' ? intent.argument : undefined,
  );
  const decision = state.decisionLedger.find((candidate) => candidate.id === decisionId);
  if (
    decision === undefined ||
    decision.topic !== `task-completion:${state.taskId}` ||
    decision.decision !== option ||
    decision.rationale !== rationale ||
    decision.authority !== 'leader' ||
    decision.by !== 'leader' ||
    decision.ts !== message.ts ||
    decision.supersedes !== undefined ||
    decision.objectionResolution !== undefined
  ) {
    throw new Error(`completion resolution decision "${String(decisionId)}" drifted`);
  }
  return {
    reviewId,
    option,
    actionId: message.msgId,
    resolutionDecisionId: decision.id,
    rationale,
    resumed: hasCanonicalResumedMarker(state, message.msgId, gateId, receipt.resumeSessionId),
  };
}

function completionRationale(
  option: CompletionResolutionOption,
  rationale: string | undefined,
): string {
  if (rationale !== undefined && rationale.length > 2000) {
    throw new Error('completion resolution rationale must not exceed 2000 characters');
  }
  if (option === 'approve_completion') {
    return rationale?.trim() ? rationale : DEFAULT_COMPLETION_APPROVAL_RATIONALE;
  }
  if (rationale === undefined || rationale.trim().length === 0) {
    throw new Error('request_changes requires a Leader rationale');
  }
  return rationale;
}

function hasCanonicalResumedMarker(
  state: AppState,
  actionId: string,
  gateId: string,
  resumeSessionId: unknown,
): boolean {
  const marker = state.messages.find(
    (message) => message.msgId === `human-gate-resumed:${actionId}`,
  );
  if (marker === undefined) return false;
  if (
    marker.fromRole !== 'COORDINATOR' ||
    marker.channelId !== 'main' ||
    marker.type !== 'announce' ||
    marker.payload.kind !== 'human_gate_resumed' ||
    marker.payload.actionId !== actionId ||
    marker.payload.gateId !== gateId ||
    marker.payload.resumeSessionId !== resumeSessionId
  ) {
    throw new Error(`completion resolution resumed marker for action "${actionId}" drifted`);
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
