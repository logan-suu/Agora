import { PHASE0_ROSTER, type RoleSpec } from '@agora/core-domain';
import { ARCHITECT_ROLE, PM_ROLE, REVIEWER_ROLE } from './roles';

function fromPhase0(role: string): RoleSpec {
  const found = PHASE0_ROSTER.find((entry) => entry.role === role);
  if (found === undefined) {
    throw new Error(`missing role in PHASE0_ROSTER: ${role}`);
  }
  return found;
}

/**
 * The six-role default roster (spec §2 order): COORDINATOR, PM, ARCHITECT,
 * CODER, TESTER, REVIEWER. The Phase 0 triad is reused verbatim from
 * `PHASE0_ROSTER` (single source of truth + R9: Phase 0/1 consumers untouched);
 * the three new roles live here in `packages/roles/definitions` (the "roles are
 * data" home, blueprint §12). `routeWhen` values are skeleton strings — the
 * condition evaluator lands in task 2.2.
 */
export const DEFAULT_ROSTER: readonly RoleSpec[] = [
  fromPhase0('COORDINATOR'),
  PM_ROLE,
  ARCHITECT_ROLE,
  fromPhase0('CODER'),
  fromPhase0('TESTER'),
  REVIEWER_ROLE,
];

/**
 * Roster loading guard (task 2.1). Enforces the invariants a composition root
 * must not violate: unique role ids, and every worker bound to the thin
 * harness executor in phases 0-9 (decision D2; `external` is a reserved
 * extension point only).
 */
export function validateRoster(roster: readonly RoleSpec[]): void {
  const seen = new Set<string>();
  for (const entry of roster) {
    if (seen.has(entry.role)) {
      throw new Error(`duplicate role in roster: ${entry.role}`);
    }
    seen.add(entry.role);
    if (entry.executor !== 'harness') {
      throw new Error(
        `role "${entry.role}" must use the harness executor in phases 0-9 (decision D2)`,
      );
    }
  }
}
