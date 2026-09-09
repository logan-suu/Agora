import { assertValidRoster, normalizeRoleSpec } from './roster';
import type { RosterEntry } from './state';

export interface RoleModelSetting {
  model: string;
  modelConnectionId: string;
}

/** Validate the complete batch before producing an independent roster snapshot. */
export function configureRoleModels(
  roster: readonly RosterEntry[],
  roles: readonly string[],
  setting: RoleModelSetting | null,
): RosterEntry[] {
  assertValidRoster(roster);
  if (!roles.length || new Set(roles).size !== roles.length)
    throw new Error('invalid model targets');
  for (const role of roles) {
    const entry = roster.find((r) => r.spec.role === role);
    if (!entry || !['enabled', 'disabled'].includes(entry.status))
      throw new Error('role is not configurable');
    if (setting) normalizeRoleSpec({ ...entry.spec, ...setting });
  }
  const targets = new Set(roles);
  return roster.map((entry) => {
    const next = structuredClone(entry);
    if (targets.has(next.spec.role)) {
      delete next.spec.model;
      delete next.spec.modelConnectionId;
      if (setting) Object.assign(next.spec, setting);
    }
    return next;
  });
}
