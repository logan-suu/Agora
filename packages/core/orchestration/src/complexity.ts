import type { Complexity } from '@agora/core-domain';

export interface ComplexityInput {
  goal: string;
  estimatedFileCount?: number;
  dependencyCount?: number;
}

export const TIER2_KEYWORDS = [
  '模块',
  '微服务',
  '数据库',
  '前后端',
  '系统',
  '平台',
  '架构',
  '迁移',
  '中间件',
  'api',
  'rest',
  'graphql',
  'microservice',
  'database',
  'migration',
  'platform',
  'middleware',
  'system',
  'backend',
  'distributed',
] as const;

export const TIER0_KEYWORDS = [
  '函数',
  '方法',
  '类',
  '工具',
  '辅助',
  '缓存',
  'lru',
  '队列',
  '栈',
  '单文件',
  '脚本',
  '正则',
  '校验',
  'function',
  'helper',
  'util',
  'cache',
  'stack',
  'queue',
  'regex',
  'validator',
  'script',
] as const;

const GOAL_TIER0_MAX_CHARS = 80;
const TIER2_FILE_COUNT_THRESHOLD = 5;
const TIER2_DEPENDENCY_COUNT_THRESHOLD = 2;

export function evaluateComplexity(input: ComplexityInput): Complexity {
  const goal = input.goal.toLowerCase();
  const matchedTier2Keywords = TIER2_KEYWORDS.filter((keyword) => goal.includes(keyword));
  const matchedTier0Keywords = TIER0_KEYWORDS.filter((keyword) => goal.includes(keyword));
  const signals = {
    goalLengthChars: input.goal.length,
    matchedTier2Keywords: [...matchedTier2Keywords],
    matchedTier0Keywords: [...matchedTier0Keywords],
    estimatedFileCount: input.estimatedFileCount ?? null,
    dependencyCount: input.dependencyCount ?? null,
  };

  if (matchedTier2Keywords.length > 0) {
    return { tier: 2, signals: { rule: 'tier2.multi_module', ...signals } };
  }
  if (
    (input.estimatedFileCount !== undefined &&
      input.estimatedFileCount >= TIER2_FILE_COUNT_THRESHOLD) ||
    (input.dependencyCount !== undefined &&
      input.dependencyCount >= TIER2_DEPENDENCY_COUNT_THRESHOLD)
  ) {
    return { tier: 2, signals: { rule: 'tier2.scale_inputs', ...signals } };
  }
  if (
    (matchedTier0Keywords.length > 0 ||
      (input.estimatedFileCount !== undefined && input.estimatedFileCount <= 1)) &&
    signals.goalLengthChars <= GOAL_TIER0_MAX_CHARS
  ) {
    return { tier: 0, signals: { rule: 'tier0.single_entity', ...signals } };
  }
  return { tier: 1, signals: { rule: 'tier1.default', ...signals } };
}
