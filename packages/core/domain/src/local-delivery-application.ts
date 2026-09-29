/** Immutable application facts. A fact never grants target access: completion
 * still requires a trusted reader to verify the private proof and live target. */
import {
  currentApprovedReviewId,
  currentCompletionEvidence,
  deriveCompletionResolution,
} from './completion-resolution';
import { latestCoordinationLedger } from './coordination-ledger';
import { isLocalReviewBinding } from './local-validation';
import { isWorkspaceVersionV1, type WorkspaceVersionV1 } from './local-workspace';
import { canonicalJson, isReviewBinding } from './parallel-execution';
import { type AppState, isMessage, type Message } from './state';
import { parseWorkspaceControl } from './workspace-control';

export interface LocalDeliveryApplicationReceipt {
  kind: 'workspace_delivery_application';
  version: 1;
  projectId: string;
  taskId: string;
  applyActionId: string;
  completionActionId: string;
  claimId: string;
  workspaceId: string;
  deliveryProposalId: string;
  inputHash: string;
  roundId: string | null;
  reviewId: string;
  validationReceiptId: string;
  candidateVersion: WorkspaceVersionV1;
  targetVersion: WorkspaceVersionV1;
  grantId: string;
  grantRevision: number;
  controlFingerprint: string;
  treeReceiptId: string;
  treeInputHash: string;
  closureReceiptId: string;
  proofHash: string;
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Select canonical identity only. The host must still prove the private
 * validation evidence and actual target before any application or completion. */
export function currentLocalDeliveryCandidate(state: AppState) {
  const delivery = state.localExecution?.delivery;
  const evidence = currentCompletionEvidence(state);
  if (!delivery) throw Error('delivery_candidate_evidence_changed');
  if (isLocalReviewBinding(evidence)) {
    if (
      (evidence.roundId ?? null) !== delivery.currentRoundId ||
      evidence.workspaceVersion.kind !== 'files'
    )
      throw Error('delivery_candidate_evidence_changed');
    return { evidence, version: evidence.workspaceVersion, roundId: evidence.roundId ?? null };
  }
  const version = state.testResults?.workspaceVersion;
  if (
    !state.localExecution?.git ||
    delivery.currentRoundId !== null ||
    !isReviewBinding(evidence) ||
    !isWorkspaceVersionV1(version) ||
    version.kind !== 'git' ||
    version.commit !== evidence.commit
  )
    throw Error('delivery_candidate_evidence_changed');
  return { evidence, version, roundId: null };
}
export function isLocalDeliveryApplicationReceipt(
  v: unknown,
): v is LocalDeliveryApplicationReceipt {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const names = [
    'kind',
    'version',
    'projectId',
    'taskId',
    'applyActionId',
    'completionActionId',
    'claimId',
    'workspaceId',
    'deliveryProposalId',
    'inputHash',
    'roundId',
    'reviewId',
    'validationReceiptId',
    'candidateVersion',
    'targetVersion',
    'grantId',
    'grantRevision',
    'controlFingerprint',
    'treeReceiptId',
    'treeInputHash',
    'closureReceiptId',
    'proofHash',
  ];
  return (
    Object.keys(r).length === names.length &&
    names.every((k) => Object.hasOwn(r, k)) &&
    r.kind === 'workspace_delivery_application' &&
    r.version === 1 &&
    [
      'projectId',
      'taskId',
      'applyActionId',
      'completionActionId',
      'claimId',
      'workspaceId',
      'deliveryProposalId',
      'reviewId',
      'validationReceiptId',
      'grantId',
      'treeReceiptId',
      'closureReceiptId',
    ].every((k) => id(r[k])) &&
    ['inputHash', 'controlFingerprint', 'treeInputHash', 'proofHash'].every((k) => hash(r[k])) &&
    (r.roundId === null || id(r.roundId)) &&
    Number.isSafeInteger(r.grantRevision) &&
    (r.grantRevision as number) >= 0 &&
    isWorkspaceVersionV1(r.candidateVersion) &&
    isWorkspaceVersionV1(r.targetVersion) &&
    r.targetVersion.kind === 'files'
  );
}

export function assertLocalDeliveryApplicationMessage(
  message: unknown,
): asserts message is Message & { payload: LocalDeliveryApplicationReceipt } {
  if (
    !isMessage(message) ||
    message.fromRole !== 'COORDINATOR' ||
    message.type !== 'announce' ||
    message.channelId !== 'main' ||
    !isLocalDeliveryApplicationReceipt(message.payload) ||
    message.msgId !== `delivery-applied:${message.payload.completionActionId}`
  )
    throw Error('invalid_delivery_application_receipt');
}

/** Check current canonical lineage, without pretending that stored target bytes
 * remain current. Historical facts remain readable when a later round replaces C. */
export function assertCurrentDeliveryApplication(
  state: AppState,
  message: Message,
  committed = true,
) {
  assertLocalDeliveryApplicationMessage(message);
  const receipt = message.payload;
  const { evidence, version, roundId } = currentLocalDeliveryCandidate(state);
  const delivery = state.localExecution?.delivery;
  const sources = state.messages.filter((m) => m.msgId === receipt.applyActionId);
  const source = sources[0];
  const intent = source && parseWorkspaceControl(source.display);
  const workspace = state.localExecution?.workspaces.find(
    (w) => w.workspaceId === receipt.workspaceId,
  );
  if (
    !delivery ||
    receipt.projectId !== state.projectId ||
    receipt.taskId !== state.taskId ||
    receipt.roundId !== delivery.currentRoundId ||
    receipt.reviewId !== currentApprovedReviewId(state) ||
    receipt.validationReceiptId !== evidence.validationReceiptId ||
    receipt.controlFingerprint !== evidence.controlFingerprint ||
    !same(receipt.candidateVersion, version) ||
    receipt.roundId !== roundId ||
    sources.length !== 1 ||
    !source ||
    source.fromRole !== 'leader' ||
    source.channelId !== 'main' ||
    source.type !== 'chat' ||
    source.payload.kind !== 'leader_intent' ||
    !same(source.payload.intent, intent) ||
    !same(source.payload.action, { status: 'applied' }) ||
    intent?.verb !== 'apply' ||
    intent.actionId !== source.msgId ||
    intent.projectId !== state.projectId ||
    intent.taskId !== state.taskId ||
    intent.deliveryProposalId !== receipt.deliveryProposalId ||
    intent.inputHash !== receipt.inputHash ||
    message.ts < source.ts ||
    workspace?.purpose !== 'delivery' ||
    workspace.mode !== 'direct' ||
    workspace.rootId !== delivery.rootId ||
    workspace.grantId !== receipt.grantId
  )
    throw Error('delivery_application_binding_changed');
  if (
    committed &&
    (!state.localExecution?.receipts.some(
      (r) =>
        r.actionId === receipt.completionActionId &&
        r.receiptId === `binding:${receipt.completionActionId}`,
    ) ||
      !same(
        state.messages.find((m) => m.msgId === message.msgId),
        message,
      ))
  )
    throw Error('delivery_application_receipt_uncommitted');
  return structuredClone(receipt);
}

/** Select current facts only; old round receipts remain immutable history. */
export function currentDeliveryApplicationMessage(state: AppState): Message | undefined {
  const reviewId = currentApprovedReviewId(state);
  const roundId = state.localExecution?.delivery?.currentRoundId;
  const candidates = state.messages.filter(
    (m) => m.payload.kind === 'workspace_delivery_application',
  );
  for (const message of candidates) assertLocalDeliveryApplicationMessage(message);
  return [...candidates]
    .reverse()
    .find((m) => m.payload.reviewId === reviewId && m.payload.roundId === roundId);
}

/** Pure completion recipe. Its caller must re-prove the private application and
 * live target immediately before an atomic compare-and-commit of the recipe. */
export function buildDeliveryCompletionMessage(
  state: AppState,
  application: Message,
  ts: number,
): Message {
  const receipt = assertCurrentDeliveryApplication(state, application);
  const resolution = deriveCompletionResolution(state, receipt.reviewId);
  const approval = resolution && state.messages.find((m) => m.msgId === resolution.actionId);
  if (
    state.localExecution?.delivery?.goal !== 'apply_to_directory' ||
    !['review', 'done'].includes(state.phase) ||
    state.humanGate ||
    state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status)) ||
    resolution?.option !== 'approve_completion' ||
    !resolution.resumed ||
    !approval ||
    !Number.isSafeInteger(ts) ||
    ts < Math.max(application.ts, approval.ts)
  )
    throw Error('delivery_completion_not_ready');
  return {
    msgId: `delivery-completed:${receipt.completionActionId}`,
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    ts,
    display: 'Approved version delivered to the selected directory.',
    payload: {
      kind: 'workspace_delivery_completion',
      version: 1,
      applicationReceiptId: application.msgId,
      approvalActionId: resolution.actionId,
      reviewId: receipt.reviewId,
      roundId: receipt.roundId,
    },
  };
}

export function assertDeliveryCompletion(state: AppState, application: Message): Message {
  assertLocalDeliveryApplicationMessage(application);
  const id = `delivery-completed:${application.payload.completionActionId}`;
  const matches = state.messages.filter((m) => m.msgId === id);
  const saved = matches[0];
  if (
    matches.length !== 1 ||
    !saved ||
    state.phase !== 'done' ||
    !same(saved, buildDeliveryCompletionMessage(state, application, saved.ts)) ||
    latestCoordinationLedger(state)?.completionCandidate !== true ||
    latestCoordinationLedger(state)?.progress.isRequestSatisfied.answer !== true
  )
    throw Error('delivery_completion_incomplete');
  return structuredClone(saved);
}
