import { isWorkspaceVersionV1, type WorkspaceVersionV1 } from './local-workspace';

/** Immutable references for one explicit same-task validation round. Runtime
 * phase, workers, test results and approval remain in their canonical records. */
export interface LocalDeliveryRoundV1 {
  roundId: string;
  actionId: string;
  deliveryComparisonId: string;
  inputHash: string;
  grantId: string;
  grantRevision: number;
  sourceReceiptId: string;
  sourceVersion: WorkspaceVersionV1;
  candidateVersion: WorkspaceVersionV1;
  targetVersion: Extract<WorkspaceVersionV1, { kind: 'files' }>;
  targetIndexHash: string | null;
  controlFingerprint: string;
}

export interface LocalDeliveryStateV1 {
  schemaVersion: 'local-delivery-v1';
  goal: 'apply_to_directory' | 'artifact_only';
  rootId: string;
  currentRoundId: string | null;
  rounds: LocalDeliveryRoundV1[];
}

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable === true && Object.hasOwn(field, 'value');
    })
  );
};
const roundKeys = [
  'roundId',
  'actionId',
  'deliveryComparisonId',
  'inputHash',
  'grantId',
  'grantRevision',
  'sourceReceiptId',
  'sourceVersion',
  'candidateVersion',
  'targetVersion',
  'targetIndexHash',
  'controlFingerprint',
] as const;

function isRound(value: unknown): value is LocalDeliveryRoundV1 {
  return (
    exact(value, roundKeys) &&
    id(value.roundId) &&
    id(value.actionId) &&
    id(value.deliveryComparisonId) &&
    hash(value.inputHash) &&
    id(value.grantId) &&
    typeof value.grantRevision === 'number' &&
    Number.isSafeInteger(value.grantRevision) &&
    value.grantRevision >= 0 &&
    id(value.sourceReceiptId) &&
    isWorkspaceVersionV1(value.sourceVersion) &&
    isWorkspaceVersionV1(value.candidateVersion) &&
    isWorkspaceVersionV1(value.targetVersion) &&
    value.targetVersion.kind === 'files' &&
    (value.targetIndexHash === null || hash(value.targetIndexHash)) &&
    hash(value.controlFingerprint)
  );
}

export function isLocalDeliveryStateV1(value: unknown): value is LocalDeliveryStateV1 {
  if (
    !exact(value, ['schemaVersion', 'goal', 'rootId', 'currentRoundId', 'rounds']) ||
    value.schemaVersion !== 'local-delivery-v1' ||
    (value.goal !== 'apply_to_directory' && value.goal !== 'artifact_only') ||
    !id(value.rootId) ||
    !Array.isArray(value.rounds) ||
    Object.getPrototypeOf(value.rounds) !== Array.prototype ||
    value.rounds.length > 1024 ||
    Reflect.ownKeys(value.rounds).length !== value.rounds.length + 1
  )
    return false;
  const ids = new Set<string>();
  const actions = new Set<string>();
  const comparisons = new Set<string>();
  for (let index = 0; index < value.rounds.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value.rounds, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value') || !isRound(field.value)) return false;
    const round = field.value;
    if (
      ids.has(round.roundId) ||
      actions.has(round.actionId) ||
      comparisons.has(round.deliveryComparisonId)
    )
      return false;
    ids.add(round.roundId);
    actions.add(round.actionId);
    comparisons.add(round.deliveryComparisonId);
  }
  return value.rounds.length === 0
    ? value.currentRoundId === null
    : value.currentRoundId === value.rounds.at(-1)?.roundId;
}

function sameVersion(left: WorkspaceVersionV1, right: WorkspaceVersionV1): boolean {
  return (
    left.kind === right.kind &&
    left.manifestId === right.manifestId &&
    left.manifestHash === right.manifestHash &&
    (left.kind === 'files' || (right.kind === 'git' && left.commit === right.commit))
  );
}

function sameRound(left: LocalDeliveryRoundV1, right: LocalDeliveryRoundV1): boolean {
  return (
    left.roundId === right.roundId &&
    left.actionId === right.actionId &&
    left.deliveryComparisonId === right.deliveryComparisonId &&
    left.inputHash === right.inputHash &&
    left.grantId === right.grantId &&
    left.grantRevision === right.grantRevision &&
    left.sourceReceiptId === right.sourceReceiptId &&
    sameVersion(left.sourceVersion, right.sourceVersion) &&
    sameVersion(left.candidateVersion, right.candidateVersion) &&
    sameVersion(left.targetVersion, right.targetVersion) &&
    left.targetIndexHash === right.targetIndexHash &&
    left.controlFingerprint === right.controlFingerprint
  );
}

export function assertLocalDeliveryTransition(
  previous: LocalDeliveryStateV1 | undefined,
  next: LocalDeliveryStateV1 | undefined,
): void {
  if (next !== undefined && !isLocalDeliveryStateV1(next)) throw Error('invalid_local_delivery');
  if (previous === undefined) return;
  if (!isLocalDeliveryStateV1(previous) || next === undefined)
    throw Error('local_delivery_history_changed');
  if (
    previous.goal !== next.goal ||
    previous.rootId !== next.rootId ||
    previous.rounds.length > next.rounds.length ||
    previous.rounds.some((round, index) => {
      const current = next.rounds[index];
      return current === undefined || !sameRound(round, current);
    })
  )
    throw Error('local_delivery_history_changed');
}
