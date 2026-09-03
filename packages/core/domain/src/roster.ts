import type { RoleDeparture, RoleSpec, RosterEntry, RosterStatus } from './state';

const ROLE_ID = /^[A-Z][A-Z0-9_-]*$/;

export const PHASE0_ROSTER: readonly RoleSpec[] = [
  {
    role: 'COORDINATOR',
    executor: 'harness',
    systemPrompt:
      '你是团队协调者，基于复杂度与最近结果决定下一步激活谁、是否并行、是否升级 leader。你不写需求/设计/代码。输出 {nextRoles, parallel, reason, escalate?}。',
    tools: [],
    projection: ['global.summary', 'coordinationContext'],
    routeWhen: 'always',
  },
  {
    role: 'CODER',
    executor: 'harness',
    systemPrompt:
      '你是编码者，只在被分配的 subtask 与 worktree 范围内工作。基于架构与失败测试迭代提交补丁。小技术分歧可提 advisory 异议但继续干活。',
    tools: ['fs.read', 'fs.write', 'sandbox.run', 'git', 'sandbox.applyPatch', 'lint'],
    projection: [
      'assignedSubtask',
      'architecture',
      'conventions',
      'failingTests',
      'fileRefs',
      'reviewFeedback',
      'coordinationContext',
    ],
    routeWhen: 'designReady || testsFailed',
  },
  {
    role: 'TESTER',
    executor: 'harness',
    systemPrompt: '你是测试者，以验收标准为客观判据编写并运行测试，产出结构化结果，不修业务代码。',
    tools: ['fs.read', 'fs.write', 'sandbox.run', 'git'],
    projection: ['acceptance', 'branchOrPatch', 'interfaceContracts', 'coordinationContext'],
    routeWhen: 'codingDone',
  },
];

export const PHASE0_ROSTER_ENTRIES: readonly RosterEntry[] = PHASE0_ROSTER.map((spec) => ({
  spec,
  status: 'enabled',
}));

export interface RosterTransition {
  roster: RosterEntry[];
  changed: boolean;
}

export interface BeginRoleDepartureInput {
  actionId: string;
  taskId: string;
  requestedTs: number;
  successorRole?: string;
}

export function normalizeRoleId(role: string): string {
  const normalized = role.trim().toUpperCase();
  if (normalized === 'LEADER') throw new Error('role id "leader" is reserved');
  if (!ROLE_ID.test(normalized)) {
    throw new Error('role id must match [A-Z][A-Z0-9_-]*');
  }
  return normalized;
}

export function normalizeRoleSpec(spec: RoleSpec): RoleSpec {
  assertRoleSpec(spec);
  return {
    role: normalizeRoleId(spec.role),
    executor: spec.executor,
    systemPrompt: spec.systemPrompt,
    tools: [...spec.tools],
    projection: [...spec.projection],
    routeWhen: spec.routeWhen,
    ...(spec.externalCmd === undefined ? {} : { externalCmd: spec.externalCmd }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
  };
}

export function assertValidRoster(roster: readonly RosterEntry[]): void {
  const seen = new Set<string>();
  for (const entry of roster) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('roster entry must be an object');
    }
    assertExactKeys(entry, ['spec', 'status', 'departure'], 'roster entry');
    if (!isRosterStatus(entry.status)) throw new Error(`invalid roster status: ${entry.status}`);
    const spec = normalizeRoleSpec(entry.spec);
    if (spec.role !== entry.spec.role)
      throw new Error(`roster role id must be normalized: ${spec.role}`);
    if (seen.has(spec.role)) throw new Error(`duplicate role in roster: ${spec.role}`);
    seen.add(spec.role);
    assertDepartureForStatus(entry.status, entry.departure);
  }
  const coordinator = roster.find((entry) => entry.spec.role === 'COORDINATOR');
  if (coordinator?.status !== 'enabled') {
    throw new Error('COORDINATOR must exist and remain enabled');
  }
}

export function enabledRoleSpecs(roster: readonly RosterEntry[]): RoleSpec[] {
  assertValidRoster(roster);
  return roster
    .filter((entry) => entry.status === 'enabled')
    .map((entry) => structuredClone(entry.spec));
}

export function addRole(roster: readonly RosterEntry[], requested: RoleSpec): RosterTransition {
  assertValidRoster(roster);
  const spec = normalizeRoleSpec(requested);
  const existing = roster.find((entry) => entry.spec.role === spec.role);
  if (existing !== undefined) {
    if (
      existing.status === 'enabled' &&
      canonicalJson(normalizeRoleSpec(existing.spec)) === canonicalJson(spec)
    ) {
      return unchanged(roster);
    }
    throw new Error(`role "${spec.role}" conflicts with an existing roster entry`);
  }
  return changed([...cloneRoster(roster), { spec, status: 'enabled' }]);
}

export function enableRole(roster: readonly RosterEntry[], role: string): RosterTransition {
  return changeStatus(roster, role, 'enabled');
}

export function disableRole(roster: readonly RosterEntry[], role: string): RosterTransition {
  const normalized = normalizeRoleId(role);
  if (normalized === 'COORDINATOR') throw new Error('COORDINATOR cannot be disabled');
  return changeStatus(roster, normalized, 'disabled');
}

export function beginRoleDeparture(
  roster: readonly RosterEntry[],
  role: string,
  input: BeginRoleDepartureInput,
): RosterTransition {
  assertValidRoster(roster);
  const normalized = normalizeRoleId(role);
  if (normalized === 'COORDINATOR') throw new Error('COORDINATOR cannot depart');
  assertDepartureInput(input);
  const successorRole =
    input.successorRole === undefined ? undefined : normalizeRoleId(input.successorRole);
  if (successorRole === normalized) throw new Error('departure successor must differ from target');
  const index = roster.findIndex((entry) => entry.spec.role === normalized);
  if (index < 0) throw new Error(`unknown role: ${normalized}`);
  const current = roster[index];
  if (current === undefined) throw new Error(`unknown role: ${normalized}`);
  const requested: RoleDeparture = {
    actionId: input.actionId,
    taskId: input.taskId,
    requestedTs: input.requestedTs,
    ...(successorRole === undefined ? {} : { successorRole }),
    stage: 'draining',
  };
  if (current.status === 'departing' || current.status === 'departed') {
    if (sameDepartureRequest(current.departure, requested)) return unchanged(roster);
    throw new Error(`role "${normalized}" departure conflicts with an existing action`);
  }
  if (successorRole !== undefined) {
    const successor = roster.find((entry) => entry.spec.role === successorRole);
    if (successor?.status !== 'enabled') {
      throw new Error(`departure successor "${successorRole}" must be enabled`);
    }
  }
  if (current.status !== 'enabled' && current.status !== 'disabled') {
    throw new Error(`role "${normalized}" cannot begin departure from ${current.status}`);
  }
  const next = cloneRoster(roster);
  next[index] = { spec: structuredClone(current.spec), status: 'departing', departure: requested };
  assertValidRoster(next);
  return changed(next);
}

export function recordRoleDepartureHandoff(
  roster: readonly RosterEntry[],
  role: string,
  actionId: string,
  handoffRef: { taskId: string; msgId: string },
  awaitingReplacement: boolean,
): RosterTransition {
  assertValidRoster(roster);
  const { index, entry } = departureEntry(roster, role, actionId);
  if (entry.status === 'departed') {
    if (
      entry.departure?.handoffRef?.taskId === handoffRef.taskId &&
      entry.departure.handoffRef.msgId === handoffRef.msgId
    ) {
      return unchanged(roster);
    }
    throw new Error(`role "${entry.spec.role}" departure handoff conflicts with completed action`);
  }
  const departure = entry.departure;
  if (departure === undefined) throw new Error('departing role requires departure metadata');
  if (handoffRef.taskId !== departure.taskId || handoffRef.msgId.length === 0) {
    throw new Error('departure handoffRef must match taskId and have a non-empty msgId');
  }
  const stage = awaitingReplacement ? 'awaiting_replacement' : 'handoff_committed';
  if (
    departure.stage === stage &&
    departure.handoffRef?.taskId === handoffRef.taskId &&
    departure.handoffRef.msgId === handoffRef.msgId
  ) {
    return unchanged(roster);
  }
  if (departure.stage !== 'draining') {
    throw new Error(`departure handoff cannot replace stage ${departure.stage}`);
  }
  const next = cloneRoster(roster);
  next[index] = {
    spec: structuredClone(entry.spec),
    status: 'departing',
    departure: { ...structuredClone(departure), stage, handoffRef: { ...handoffRef } },
  };
  assertValidRoster(next);
  return changed(next);
}

export function completeRoleDeparture(
  roster: readonly RosterEntry[],
  role: string,
  actionId: string,
): RosterTransition {
  assertValidRoster(roster);
  const { index, entry } = departureEntry(roster, role, actionId);
  if (entry.status === 'departed') return unchanged(roster);
  const departure = entry.departure;
  if (departure === undefined) throw new Error('departing role requires departure metadata');
  if (departure.stage !== 'handoff_committed') {
    throw new Error(`role "${entry.spec.role}" cannot complete departure from ${departure.stage}`);
  }
  const next = cloneRoster(roster);
  next[index] = {
    spec: structuredClone(entry.spec),
    status: 'departed',
    departure: { ...structuredClone(departure), stage: 'completed' },
  };
  assertValidRoster(next);
  return changed(next);
}

function changeStatus(
  roster: readonly RosterEntry[],
  role: string,
  target: Extract<RosterStatus, 'enabled' | 'disabled'>,
): RosterTransition {
  assertValidRoster(roster);
  const normalized = normalizeRoleId(role);
  const index = roster.findIndex((entry) => entry.spec.role === normalized);
  if (index < 0) throw new Error(`unknown role: ${normalized}`);
  const current = roster[index];
  if (current === undefined) throw new Error(`unknown role: ${normalized}`);
  if (current.status === target) return unchanged(roster);
  const expected = target === 'enabled' ? 'disabled' : 'enabled';
  if (current.status !== expected) {
    throw new Error(`role "${normalized}" is ${current.status} and cannot become ${target}`);
  }
  const next = cloneRoster(roster);
  next[index] = { spec: structuredClone(current.spec), status: target };
  assertValidRoster(next);
  return changed(next);
}

function assertRoleSpec(spec: RoleSpec): void {
  if (typeof spec !== 'object' || spec === null) throw new Error('role spec must be an object');
  assertExactKeys(
    spec,
    [
      'role',
      'executor',
      'systemPrompt',
      'tools',
      'projection',
      'routeWhen',
      'externalCmd',
      'model',
    ],
    'role spec',
  );
  if (typeof spec.role !== 'string') throw new Error('role id must be a string');
  normalizeRoleId(spec.role);
  if (spec.executor !== 'harness' && spec.executor !== 'external') {
    throw new Error('role executor must be harness or external');
  }
  if (typeof spec.systemPrompt !== 'string' || spec.systemPrompt.length === 0) {
    throw new Error('role systemPrompt must be non-empty');
  }
  if (typeof spec.routeWhen !== 'string' || spec.routeWhen.length === 0) {
    throw new Error('role routeWhen must be non-empty');
  }
  if (!Array.isArray(spec.tools) || !spec.tools.every(nonEmptyString)) {
    throw new Error('role tools must contain non-empty strings');
  }
  if (!Array.isArray(spec.projection) || !spec.projection.every(nonEmptyString)) {
    throw new Error('role projection must contain non-empty strings');
  }
  if (spec.externalCmd !== undefined && typeof spec.externalCmd !== 'string') {
    throw new Error('role externalCmd must be a string');
  }
  if (spec.model !== undefined && typeof spec.model !== 'string') {
    throw new Error('role model must be a string');
  }
}

function assertDepartureInput(input: BeginRoleDepartureInput): void {
  if (typeof input.actionId !== 'string' || input.actionId.length === 0) {
    throw new Error('departure actionId must be non-empty');
  }
  if (typeof input.taskId !== 'string' || input.taskId.length === 0) {
    throw new Error('departure taskId must be non-empty');
  }
  if (typeof input.requestedTs !== 'number' || !Number.isFinite(input.requestedTs)) {
    throw new Error('departure requestedTs must be finite');
  }
}

function assertDepartureForStatus(
  status: RosterStatus,
  departure: RoleDeparture | undefined,
): void {
  if (status === 'enabled' || status === 'disabled') {
    if (departure !== undefined) throw new Error(`${status} roster entry cannot carry departure`);
    return;
  }
  if (departure === undefined)
    throw new Error(`${status} roster entry requires departure metadata`);
  assertExactKeys(
    departure,
    ['actionId', 'taskId', 'requestedTs', 'successorRole', 'stage', 'handoffRef'],
    'role departure',
  );
  assertDepartureInput(departure);
  if (
    departure.stage !== 'draining' &&
    departure.stage !== 'handoff_committed' &&
    departure.stage !== 'awaiting_replacement' &&
    departure.stage !== 'completed'
  ) {
    throw new Error(`invalid departure stage: ${String(departure.stage)}`);
  }
  if (status === 'departed' && departure.stage !== 'completed') {
    throw new Error('departed roster entry requires completed departure');
  }
  if (status === 'departing' && departure.stage === 'completed') {
    throw new Error('departing roster entry cannot have completed departure');
  }
  if (
    departure.successorRole !== undefined &&
    normalizeRoleId(departure.successorRole) !== departure.successorRole
  ) {
    throw new Error(`departure successor role id must be normalized: ${departure.successorRole}`);
  }
  if (departure.stage !== 'draining') {
    const ref = departure.handoffRef;
    if (
      ref === undefined ||
      ref.taskId !== departure.taskId ||
      typeof ref.msgId !== 'string' ||
      ref.msgId.length === 0
    ) {
      throw new Error(`departure stage ${departure.stage} requires a matching handoffRef`);
    }
  } else if (departure.handoffRef !== undefined) {
    throw new Error('draining departure cannot carry a handoffRef');
  }
}

function departureEntry(
  roster: readonly RosterEntry[],
  role: string,
  actionId: string,
): { index: number; entry: RosterEntry } {
  const normalized = normalizeRoleId(role);
  const index = roster.findIndex((entry) => entry.spec.role === normalized);
  const entry = roster[index];
  if (entry === undefined) throw new Error(`unknown role: ${normalized}`);
  if (
    (entry.status !== 'departing' && entry.status !== 'departed') ||
    entry.departure === undefined
  ) {
    throw new Error(`role "${normalized}" has no active departure`);
  }
  if (entry.departure.actionId !== actionId) {
    throw new Error(`role "${normalized}" departure actionId conflicts with persisted action`);
  }
  return { index, entry };
}

function sameDepartureRequest(
  current: RoleDeparture | undefined,
  requested: RoleDeparture,
): boolean {
  return (
    current !== undefined &&
    current.actionId === requested.actionId &&
    current.taskId === requested.taskId &&
    current.requestedTs === requested.requestedTs &&
    current.successorRole === requested.successorRole
  );
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected !== undefined)
    throw new Error(`${label} contains unexpected field "${unexpected}"`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRosterStatus(value: unknown): value is RosterStatus {
  return (
    value === 'enabled' || value === 'disabled' || value === 'departing' || value === 'departed'
  );
}

function cloneRoster(roster: readonly RosterEntry[]): RosterEntry[] {
  return structuredClone([...roster]);
}

function unchanged(roster: readonly RosterEntry[]): RosterTransition {
  return { roster: cloneRoster(roster), changed: false };
}

function changed(roster: RosterEntry[]): RosterTransition {
  return { roster, changed: true };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(value.map((entry) => JSON.parse(canonicalJson(entry))));
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, JSON.parse(canonicalJson(entry))]),
    ),
  );
}
