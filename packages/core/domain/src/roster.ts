import type { RoleSpec } from './state';

export const PHASE0_ROSTER: readonly RoleSpec[] = [
  {
    role: 'COORDINATOR',
    enabled: true,
    executor: 'harness',
    systemPrompt:
      '你是团队协调者，基于复杂度与最近结果决定下一步激活谁、是否并行、是否升级 leader。你不写需求/设计/代码。输出 {nextRoles, parallel, reason, escalate?}。',
    tools: [],
    projection: ['global.summary', 'coordinationContext'],
    routeWhen: 'always',
  },
  {
    role: 'CODER',
    enabled: true,
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
    enabled: true,
    executor: 'harness',
    systemPrompt: '你是测试者，以验收标准为客观判据编写并运行测试，产出结构化结果，不修业务代码。',
    tools: ['fs.read', 'fs.write', 'sandbox.run', 'git'],
    projection: ['acceptance', 'branchOrPatch', 'interfaceContracts', 'coordinationContext'],
    routeWhen: 'codingDone',
  },
];
