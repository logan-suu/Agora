import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

/**
 * Result of expanding one RoleSpec.tools whitelist (task 1.5, spec §2
 * tool-role permission matrix) into concrete bridged tools.
 */
export interface ResolvedRoleTools {
  /**
   * Wire-safe model-visible tool names granted to the role (e.g.
   * `fs_read`/`git_apply_patch`). Passed to the executor as the agent-scoped
   * `ctx.tools.restrict({ allow })` mask (Phase 1 toolFilter equivalent).
   * Empty for a tool-less role (COORDINATOR): `restrict({ allow: [] })` hides
   * every global tool.
   */
  readonly allowNames: readonly string[];
  /** The concrete ToolDefinitions to register on the executor's ctx. */
  readonly definitions: readonly ToolDefinition[];
  /**
   * Whitelist entries with no catalog implementation (e.g. `lint`, DEF-005).
   * The loader skips them at registration and surfaces them here so the
   * composition root can log the gap instead of silently dropping the grant.
   */
  readonly unavailable: readonly string[];
}

/** One logical-name → definition lookup owned by a {@link ToolCatalog}. */
export type CatalogLookup = (logicalName: string) => readonly ToolDefinition[] | undefined;

/**
 * Expand a RoleSpec.tools whitelist into the role's concrete tools (task 1.5).
 *
 * A single logical entry may expand to several wire tools (`git` → create/
 * applyPatch/diff/merge), and two logical entries may land on the same wire
 * tool (`sandbox.applyPatch` and `git` both grant `git_apply_patch`), so the
 * resolution dedupes by wire name. Entries with no catalog implementation are
 * reported as `unavailable` rather than silently granted or dropped.
 */
export function resolveRoleTools(
  tools: readonly string[],
  lookup: CatalogLookup,
): ResolvedRoleTools {
  const seen = new Set<string>();
  const definitions: ToolDefinition[] = [];
  const unavailable: string[] = [];
  for (const logicalName of tools) {
    const resolved = lookup(logicalName);
    if (resolved === undefined || resolved.length === 0) {
      unavailable.push(logicalName);
      continue;
    }
    for (const definition of resolved) {
      if (seen.has(definition.name)) continue;
      seen.add(definition.name);
      definitions.push(definition);
    }
  }
  return { allowNames: [...seen], definitions, unavailable };
}
