import type { RoleSpec, RosterEntry, RosterStatus } from './state';

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
    assertExactKeys(entry, ['spec', 'status'], 'roster entry');
    if (!isRosterStatus(entry.status)) throw new Error(`invalid roster status: ${entry.status}`);
    const spec = normalizeRoleSpec(entry.spec);
    if (spec.role !== entry.spec.role)
      throw new Error(`roster role id must be normalized: ${spec.role}`);
    if (seen.has(spec.role)) throw new Error(`duplicate role in roster: ${spec.role}`);
    seen.add(spec.role);
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
