import type { MessageRef } from './channel';
import { assertValidHandoff, type HandoffPacket } from './handoff';
import { type Mutation, setMutation } from './reducer';
import { assertValidRoster, normalizeRoleId } from './roster';
import type { AppState, Message, RoleId, RosterEntry } from './state';

export interface RoleOnboardingReceipt {
  actionId: string;
  role: RoleId;
  handoffRefs: MessageRef[];
}

export interface RoleOnboardingIntent {
  kind: 'onboard_role';
  targetRole: RoleId;
  entrustedHandoffMsgIds: string[];
}

export interface OnboardingHandoff {
  ref: MessageRef;
  packet: HandoffPacket;
}

export interface OnboardingContext {
  actionId: string | null;
  role: RoleId;
  handoffs: OnboardingHandoff[];
}

export interface RoleOnboardingPlan {
  receipt: RoleOnboardingReceipt;
  mutations: readonly Mutation[];
}

interface CanonicalDepartureHandoff {
  ref: MessageRef;
  actionId: string;
  packet: HandoffPacket;
}

export function planRoleOnboarding(
  state: AppState,
  roster: readonly RosterEntry[],
  actionId: string,
  intent: RoleOnboardingIntent,
): RoleOnboardingPlan {
  assertNonEmpty(actionId, 'onboarding actionId');
  assertValidRoster(roster);
  const role = normalizeRoleId(intent.targetRole);
  if (!roster.some((entry) => entry.spec.role === role && entry.status === 'enabled')) {
    throw new Error(`onboarding target role "${role}" must be enabled`);
  }

  const claimed = claimedHandoffRefs(state, roster);
  const selected: CanonicalDepartureHandoff[] = [];
  const selectedKeys = new Set<string>();

  for (const message of state.messages) {
    const candidate = departureHandoffOrUndefined(state, message);
    if (candidate === undefined || candidate.packet.toRole !== role) continue;
    assertRosterAnchor(roster, candidate);
    const key = refKey(candidate.ref);
    if (claimed.has(key)) continue;
    selected.push(candidate);
    selectedKeys.add(key);
  }

  for (const msgId of uniqueEntrustedIds(intent.entrustedHandoffMsgIds)) {
    const message = state.messages.find((entry) => entry.msgId === msgId);
    if (message === undefined) throw new Error(`unknown onboarding handoff "${msgId}"`);
    const candidate = canonicalDepartureHandoff(state, message);
    assertRosterAnchor(roster, candidate);
    if (candidate.packet.toRole !== 'leader') {
      throw new Error(`entrusted onboarding handoff "${msgId}" must be hosted by leader`);
    }
    const key = refKey(candidate.ref);
    if (claimed.has(key)) throw new Error(`onboarding handoff "${msgId}" is already claimed`);
    if (!selectedKeys.has(key)) {
      selected.push(candidate);
      selectedKeys.add(key);
    }
  }

  return {
    receipt: {
      actionId,
      role,
      handoffRefs: selected.map(({ ref }) => ({ ...ref })),
    },
    mutations: [setMutation('nextRole', role)],
  };
}

export function deriveOnboardingContext(state: AppState, requestedRole: RoleId): OnboardingContext {
  const role = normalizeRoleId(requestedRole);
  let latest: RoleOnboardingReceipt | undefined;
  const claimed = new Map<string, string>();

  for (const message of state.messages) {
    const receipt = appliedOnboardingReceiptOrUndefined(state, message);
    if (receipt === undefined) continue;
    for (const ref of receipt.handoffRefs) {
      const key = refKey(ref);
      const previous = claimed.get(key);
      if (previous !== undefined && previous !== receipt.actionId) {
        throw new Error(`onboarding handoff "${ref.msgId}" is claimed by multiple actions`);
      }
      claimed.set(key, receipt.actionId);
    }
    if (receipt.role === role) latest = receipt;
  }

  if (latest === undefined) return { actionId: null, role, handoffs: [] };
  return {
    actionId: latest.actionId,
    role,
    handoffs: latest.handoffRefs.map((ref) => {
      const message = state.messages.find((entry) => entry.msgId === ref.msgId);
      if (message === undefined) throw new Error(`unknown onboarding handoff "${ref.msgId}"`);
      const canonical = canonicalDepartureHandoff(state, message);
      return { ref: { ...canonical.ref }, packet: structuredClone(canonical.packet) };
    }),
  };
}

export function validateAppliedOnboardingMessage(
  state: AppState,
  message: Message,
): RoleOnboardingReceipt {
  const receipt = appliedOnboardingReceiptOrUndefined(state, message);
  if (receipt === undefined) {
    throw new Error(`message "${message.msgId}" is not an applied onboarding message`);
  }
  deriveOnboardingContext(state, receipt.role);
  return receipt;
}

function claimedHandoffRefs(state: AppState, roster: readonly RosterEntry[]): Set<string> {
  const claims = new Map<string, string>();
  for (const message of state.messages) {
    const receipt = appliedOnboardingReceiptOrUndefined(state, message);
    if (receipt === undefined) continue;
    for (const ref of receipt.handoffRefs) {
      const handoffMessage = state.messages.find((entry) => entry.msgId === ref.msgId);
      if (handoffMessage === undefined)
        throw new Error(`unknown onboarding handoff "${ref.msgId}"`);
      assertRosterAnchor(roster, canonicalDepartureHandoff(state, handoffMessage));
      const key = refKey(ref);
      const previous = claims.get(key);
      if (previous !== undefined && previous !== receipt.actionId) {
        throw new Error(`onboarding handoff "${ref.msgId}" is claimed by multiple actions`);
      }
      claims.set(key, receipt.actionId);
    }
  }
  return new Set(claims.keys());
}

function appliedOnboardingReceiptOrUndefined(
  state: AppState,
  message: Message,
): RoleOnboardingReceipt | undefined {
  if (message.payload.kind !== 'leader_intent') return undefined;
  const intent = recordOrUndefined(message.payload.intent);
  const action = recordOrUndefined(message.payload.action);
  if (intent?.kind !== 'onboard_role' || action?.status !== 'applied') return undefined;
  if (message.fromRole !== 'leader' || message.type !== 'chat' || message.channelId !== 'main') {
    throw new Error(`applied onboarding message "${message.msgId}" is not canonical`);
  }
  const targetRole = requiredRole(intent.targetRole, 'onboarding intent targetRole');
  const receipt = recordOrThrow(message.payload.onboarding, 'applied onboarding receipt');
  const actionId = requiredString(receipt.actionId, 'onboarding receipt actionId');
  const receiptRole = requiredRole(receipt.role, 'onboarding receipt role');
  if (actionId !== message.msgId)
    throw new Error('onboarding receipt actionId must match message msgId');
  if (receiptRole !== targetRole)
    throw new Error('onboarding receipt role must match intent targetRole');
  if (!Array.isArray(receipt.handoffRefs))
    throw new Error('onboarding receipt handoffRefs must be an array');

  const seen = new Set<string>();
  const refs = receipt.handoffRefs.map((value) => {
    const ref = recordOrThrow(value, 'onboarding handoffRef');
    const taskId = requiredString(ref.taskId, 'onboarding handoffRef taskId');
    const msgId = requiredString(ref.msgId, 'onboarding handoffRef msgId');
    if (taskId !== state.taskId) throw new Error(`onboarding handoff "${msgId}" is cross-task`);
    const key = refKey({ taskId, msgId });
    if (seen.has(key)) throw new Error(`duplicate onboarding handoffRef "${msgId}"`);
    seen.add(key);
    const handoffMessage = state.messages.find((entry) => entry.msgId === msgId);
    if (handoffMessage === undefined) throw new Error(`unknown onboarding handoff "${msgId}"`);
    const handoff = canonicalDepartureHandoff(state, handoffMessage);
    if (handoff.packet.toRole !== receiptRole && handoff.packet.toRole !== 'leader') {
      throw new Error(
        `onboarding handoff "${msgId}" is not addressed to role "${receiptRole}" or leader`,
      );
    }
    return { taskId, msgId };
  });

  return { actionId, role: receiptRole, handoffRefs: refs };
}

function departureHandoffOrUndefined(
  state: AppState,
  message: Message,
): CanonicalDepartureHandoff | undefined {
  if (message.payload.kind !== 'role_departure_handoff') return undefined;
  return canonicalDepartureHandoff(state, message);
}

function canonicalDepartureHandoff(state: AppState, message: Message): CanonicalDepartureHandoff {
  if (
    message.channelId !== 'main' ||
    message.fromRole !== 'COORDINATOR' ||
    message.type !== 'handoff' ||
    message.payload.kind !== 'role_departure_handoff' ||
    message.to?.length !== 1
  ) {
    throw new Error(`onboarding handoff "${message.msgId}" is not a canonical departure message`);
  }
  const actionId = requiredString(message.payload.actionId, 'departure handoff actionId');
  if (message.msgId !== `role-departure:${actionId}`) {
    throw new Error(`departure handoff "${message.msgId}" does not use its stable msgId`);
  }
  const packet = message.payload.packet as HandoffPacket;
  assertValidHandoff(packet);
  assertExactKeys(packet as unknown as Record<string, unknown>, [
    'fromRole',
    'toRole',
    'done',
    'keyDecisions',
    'openIssues',
    'fileRefs',
    'ts',
  ]);
  if (message.to[0] !== packet.toRole || message.ts !== packet.ts) {
    throw new Error(`departure handoff "${message.msgId}" envelope drifted from its packet`);
  }
  if (!state.handoffPackets.some((entry) => sameHandoffPacket(entry, packet))) {
    throw new Error(`departure handoff "${message.msgId}" packet drifted from AppState`);
  }
  return {
    ref: { taskId: state.taskId, msgId: message.msgId },
    actionId,
    packet: structuredClone(packet),
  };
}

function assertRosterAnchor(
  roster: readonly RosterEntry[],
  handoff: CanonicalDepartureHandoff,
): void {
  const source = roster.find((entry) => entry.spec.role === handoff.packet.fromRole);
  const departure = source?.departure;
  if (
    departure === undefined ||
    departure.actionId !== handoff.actionId ||
    departure.taskId !== handoff.ref.taskId ||
    departure.handoffRef?.taskId !== handoff.ref.taskId ||
    departure.handoffRef.msgId !== handoff.ref.msgId
  ) {
    throw new Error(`departure handoff "${handoff.ref.msgId}" has no matching roster anchor`);
  }
}

function uniqueEntrustedIds(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new Error('entrusted handoff ids must be an array');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value, 'entrusted handoff msgId');
    if (!seen.has(value)) result.push(value);
    seen.add(value);
  }
  return result;
}

function requiredRole(value: unknown, field: string): RoleId {
  if (typeof value !== 'string') throw new Error(`${field} must be a role id`);
  try {
    return normalizeRoleId(value);
  } catch {
    throw new Error(`${field} must be a role id`);
  }
}

function requiredString(value: unknown, field: string): string {
  assertNonEmpty(value, field);
  return value;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${field} must be non-empty`);
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordOrThrow(value: unknown, field: string): Record<string, unknown> {
  const record = recordOrUndefined(value);
  if (record === undefined) throw new Error(`${field} must be an object`);
  return record;
}

function refKey(ref: MessageRef): string {
  return `${ref.taskId}\u0000${ref.msgId}`;
}

function sameHandoffPacket(left: HandoffPacket, right: HandoffPacket): boolean {
  return (
    left.fromRole === right.fromRole &&
    left.toRole === right.toRole &&
    left.done === right.done &&
    sameStrings(left.keyDecisions, right.keyDecisions) &&
    sameStrings(left.openIssues, right.openIssues) &&
    sameStrings(left.fileRefs, right.fileRefs) &&
    left.ts === right.ts
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('departure handoff packet contains unexpected fields');
  }
}
