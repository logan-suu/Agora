import { describe, expect, it } from 'vitest';
import {
  type ComplexityInput,
  evaluateComplexity,
  TIER0_KEYWORDS,
  TIER2_KEYWORDS,
} from '../src/complexity';

function input(overrides: Partial<ComplexityInput> = {}): ComplexityInput {
  return { goal: '实现一个带 TTL 的 LRU 缓存', ...overrides };
}

describe('evaluateComplexity (task 4.1, spec §3 tier classification)', () => {
  it('classifies a single-file single-entity goal as Tier 0 (rule R3)', () => {
    const result = evaluateComplexity(input());
    expect(result.tier).toBe(0);
    expect(result.signals.rule).toBe('tier0.single_entity');
  });

  it('classifies a multi-module service goal as Tier 2 via keyword rule R1', () => {
    const result = evaluateComplexity(input({ goal: '实现 REST API 服务，含用户与订单模块' }));
    expect(result.tier).toBe(2);
    expect(result.signals.rule).toBe('tier2.multi_module');
    expect(result.signals.matchedTier2Keywords).toEqual(expect.arrayContaining(['api', '模块']));
  });

  it('matches English keywords case-insensitively', () => {
    const result = evaluateComplexity(input({ goal: 'Build a REST API Service' }));
    expect(result.tier).toBe(2);
    expect(result.signals.rule).toBe('tier2.multi_module');
    expect(result.signals.matchedTier2Keywords).toEqual(expect.arrayContaining(['rest', 'api']));
  });

  it('R1 beats R3: a mixed goal naming both a cache and an API module stays Tier 2', () => {
    const result = evaluateComplexity(input({ goal: '实现一个缓存服务的 API 模块' }));
    expect(result.tier).toBe(2);
    expect(result.signals.rule).toBe('tier2.multi_module');
    expect(result.signals.matchedTier0Keywords).toEqual(expect.arrayContaining(['缓存']));
  });

  it('defaults an unremarkable mid-band goal to Tier 1 (no keyword, no scale input)', () => {
    const result = evaluateComplexity(input({ goal: '给用户设置页增加导入导出功能' }));
    expect(result.tier).toBe(1);
    expect(result.signals.rule).toBe('tier1.default');
    expect(result.signals.matchedTier2Keywords).toEqual([]);
    expect(result.signals.matchedTier0Keywords).toEqual([]);
  });

  it('R2: estimatedFileCount >= 5 escalates to Tier 2 without any keyword', () => {
    const result = evaluateComplexity(input({ goal: '某项实现', estimatedFileCount: 5 }));
    expect(result.tier).toBe(2);
    expect(result.signals.rule).toBe('tier2.scale_inputs');
  });

  it('R2: dependencyCount >= 2 escalates to Tier 2 without any keyword', () => {
    const result = evaluateComplexity(input({ goal: '某项实现', dependencyCount: 2 }));
    expect(result.tier).toBe(2);
    expect(result.signals.rule).toBe('tier2.scale_inputs');
  });

  it('R3: estimatedFileCount <= 1 alone qualifies a short keyword-free goal as Tier 0', () => {
    const result = evaluateComplexity(input({ goal: '某项实现', estimatedFileCount: 1 }));
    expect(result.tier).toBe(0);
    expect(result.signals.rule).toBe('tier0.single_entity');
  });

  it('R3 length guard: a >80-char goal carrying only Tier 0 keywords stays Tier 1', () => {
    const goal = '实现一个缓存'.repeat(14);
    expect(goal.length).toBeGreaterThan(80);
    const result = evaluateComplexity(input({ goal }));
    expect(result.tier).toBe(1);
    expect(result.signals.rule).toBe('tier1.default');
  });

  it('records the full signal set: rule, length, matches, and null scale inputs', () => {
    const goal = '实现一个带 TTL 的 LRU 缓存';
    const result = evaluateComplexity(input({ goal }));
    expect(result.signals).toEqual({
      rule: 'tier0.single_entity',
      goalLengthChars: goal.length,
      matchedTier2Keywords: [],
      matchedTier0Keywords: expect.arrayContaining(['缓存', 'lru']),
      estimatedFileCount: null,
      dependencyCount: null,
    });
  });

  it('is deterministic and pure: same input yields equal output and the input is not mutated', () => {
    const frozen = Object.freeze(input({ goal: '实现一个队列工具' }));
    const first = evaluateComplexity(frozen);
    const second = evaluateComplexity(frozen);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(frozen.goal).toBe('实现一个队列工具');
  });

  it('returns fresh signal arrays so callers cannot corrupt later evaluations', () => {
    const first = evaluateComplexity(input({ goal: '实现一个缓存' }));
    const matched = first.signals.matchedTier0Keywords as string[];
    matched.push('污染');
    const second = evaluateComplexity(input({ goal: '实现一个缓存' }));
    expect(second.signals.matchedTier0Keywords).toEqual(['缓存']);
  });

  it('exposes the keyword constants for drift-guarding (disjoint, non-empty, canonical entries)', () => {
    expect(TIER2_KEYWORDS.length).toBeGreaterThan(0);
    expect(TIER0_KEYWORDS.length).toBeGreaterThan(0);
    expect(TIER2_KEYWORDS).toContain('api');
    expect(TIER2_KEYWORDS).toContain('模块');
    expect(TIER2_KEYWORDS).toContain('数据库');
    expect(TIER0_KEYWORDS).toContain('缓存');
    expect(TIER0_KEYWORDS).toContain('function');
    const overlap = TIER0_KEYWORDS.filter((keyword) =>
      (TIER2_KEYWORDS as readonly string[]).includes(keyword),
    );
    expect(overlap).toEqual([]);
  });
});
