import type { RoleSpec } from '@agora/core-domain';

/**
 * PM — Product Manager (task 2.1, spec §2). Conditionally triggered: converts a
 * vague `goal` into structured `requirements`; raises `blocking` objections
 * when a leader decision contradicts confirmed requirements. Tool-free: pure
 * reasoning over projected slices (goal/requirements/leaderDecisions), the same
 * principle as the COORDINATOR. The §2 bullet states "工具：无（纯推理）"; the
 * matrix row granting PM `fs.read` is a documented conflict pending an issue +
 * /sync-docs-agora fix.
 */
export const PM_ROLE: RoleSpec = {
  role: 'PM',
  enabled: true,
  executor: 'harness',
  systemPrompt:
    '你是产品经理，产出带验收标准的结构化需求。若 leader 新指令与已确认需求冲突，提 blocking 异议说明冲突点、等 leader 裁决，不擅自改需求。',
  tools: [],
  projection: ['goal', 'requirements', 'leaderDecisions'],
  routeWhen: 'goalAmbiguous',
};

/**
 * ARCHITECT — Architect (task 2.1, spec §2). Read-only repo access: turns
 * `requirements` into module breakdown, interfaces, data structures and
 * technology choices (`architecture` + `conventions`). `git.readonly` is the
 * matrix's 只读 surface (diff only) — DEF-006 (task 2.5) split the coarse
 * `git` group so the main-repo mutations reach no model role.
 */
export const ARCHITECT_ROLE: RoleSpec = {
  role: 'ARCHITECT',
  enabled: true,
  executor: 'harness',
  systemPrompt:
    '你是架构师，给出可实现的设计与约定；重设计时逐条回应结构化 reviewFeedback，关键决策附理由写入台账。',
  tools: ['fs.read', 'git.readonly'],
  projection: ['requirements', 'repoStructure', 'conventions', 'architecture', 'reviewFeedback'],
  routeWhen: 'requirementsReady',
};

/**
 * REVIEWER — Reviewer (task 2.1, spec §2). Quality/convention/security review
 * producing actionable `reviewComments`; approval requires the leader's final
 * confirmation (human-gate carrier). `git.readonly` is the matrix's 只读 diff
 * surface (DEF-006 split, task 2.5). `lint` resolves the biome-backed
 * lint-server since task 2.5 (DEF-005 resolved in PR #27).
 */
export const REVIEWER_ROLE: RoleSpec = {
  role: 'REVIEWER',
  enabled: true,
  executor: 'harness',
  systemPrompt:
    '你是评审者，按结构化 reviewContext 审查质量/规范/安全或连续失败根因，结合 failingTests/fileRefs 产出可执行修改意见，通过结论需 leader 最终确认。',
  tools: ['fs.read', 'git.readonly', 'lint'],
  projection: [
    'pendingPatch',
    'conventions',
    'architecture',
    'reviewContext',
    'failingTests',
    'fileRefs',
  ],
  routeWhen: 'testsPassed',
};
