import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { resolveRoleTools } from '../src/loader';

// 纯单元测试（R11）：用桩 ToolDefinition 验证 RoleSpec.tools → wire 名展开逻辑
// （逻辑名分组/去重/不可用跳过），不涉及真实工具执行。

function stub(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: {},
    output: { schema: {}, render: () => [] as ContentBlock[] },
    execute: async () => undefined,
  };
}

/** 与 mcp-bridge LOGICAL_GROUPS 一致的展开表（测试侧桩）。 */
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  'fs.read': ['fs_read'],
  'fs.write': ['fs_write'],
  'sandbox.run': ['sandbox_run'],
  git: ['git_createWorktree', 'git_applyPatch', 'git_diff', 'git_merge'],
  'sandbox.applyPatch': ['git_applyPatch'],
};

function lookupOf(): (logical: string) => readonly ToolDefinition[] | undefined {
  const byWire = new Map<string, ToolDefinition>();
  for (const wireNames of Object.values(GROUPS)) {
    for (const wireName of wireNames) byWire.set(wireName, stub(wireName));
  }
  return (logical) => {
    const wireNames = GROUPS[logical];
    if (wireNames === undefined) return undefined;
    const definitions = wireNames
      .map((wireName) => byWire.get(wireName))
      .filter((definition): definition is ToolDefinition => definition !== undefined);
    return definitions.length === 0 ? undefined : definitions;
  };
}

describe('resolveRoleTools (task 1.5 RoleSpec.tools whitelist expansion)', () => {
  it('expands the CODER whitelist to concrete wire tools, dedupes the git alias, and reports lint unavailable', () => {
    const resolved = resolveRoleTools(
      ['fs.read', 'fs.write', 'sandbox.run', 'git', 'sandbox.applyPatch', 'lint'],
      lookupOf(),
    );
    expect(resolved.allowNames).toEqual([
      'fs_read',
      'fs_write',
      'sandbox_run',
      'git_createWorktree',
      'git_applyPatch',
      'git_diff',
      'git_merge',
    ]);
    expect(resolved.definitions.map((d) => d.name)).toEqual(resolved.allowNames);
    expect(resolved.unavailable).toEqual(['lint']);
  });

  it('keeps TESTER scoped to fs + sandbox.run + the git group', () => {
    const resolved = resolveRoleTools(['fs.read', 'fs.write', 'sandbox.run', 'git'], lookupOf());
    expect(resolved.allowNames).toEqual([
      'fs_read',
      'fs_write',
      'sandbox_run',
      'git_createWorktree',
      'git_applyPatch',
      'git_diff',
      'git_merge',
    ]);
    expect(resolved.unavailable).toEqual([]);
  });

  it('produces an empty allow list for a tool-less role (COORDINATOR)', () => {
    const resolved = resolveRoleTools([], lookupOf());
    expect(resolved.allowNames).toEqual([]);
    expect(resolved.definitions).toEqual([]);
    expect(resolved.unavailable).toEqual([]);
  });

  it('reports unknown logical names as unavailable instead of failing', () => {
    const resolved = resolveRoleTools(['nope.read', 'fs.read'], lookupOf());
    expect(resolved.allowNames).toEqual(['fs_read']);
    expect(resolved.unavailable).toEqual(['nope.read']);
  });
});
