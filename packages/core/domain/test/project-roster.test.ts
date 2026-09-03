import { describe, expect, it } from 'vitest';

import {
  addRole,
  disableRole,
  enabledRoleSpecs,
  enableRole,
  normalizeRoleId,
  type RoleSpec,
  type RosterEntry,
} from '../src/index';

const COORDINATOR: RoleSpec = {
  role: 'COORDINATOR',
  executor: 'harness',
  systemPrompt: 'Coordinate the team.',
  tools: [],
  projection: ['global.summary'],
  routeWhen: 'always',
};

const CODER: RoleSpec = {
  role: 'CODER',
  executor: 'harness',
  systemPrompt: 'Write code.',
  tools: ['fs.read'],
  projection: ['assignedSubtask'],
  routeWhen: 'designReady',
};

const INITIAL: readonly RosterEntry[] = [
  { spec: COORDINATOR, status: 'enabled' },
  { spec: CODER, status: 'enabled' },
];

describe('project roster transitions', () => {
  it('normalizes role ids before identity comparison', () => {
    expect(normalizeRoleId(' release_manager ')).toBe('RELEASE_MANAGER');
    expect(() => normalizeRoleId('leader')).toThrow(/reserved/i);
    expect(() => normalizeRoleId('bad role')).toThrow(/role id/i);
  });

  it('adds a normalized enabled role and treats an identical replay as a no-op', () => {
    const releaseManager: RoleSpec = {
      ...CODER,
      role: 'release_manager',
      systemPrompt: 'Prepare releases.',
    };

    const added = addRole(INITIAL, releaseManager);
    expect(added.changed).toBe(true);
    expect(added.roster.at(-1)).toMatchObject({
      spec: { role: 'RELEASE_MANAGER' },
      status: 'enabled',
    });

    const replayed = addRole(added.roster, { ...releaseManager, role: 'RELEASE_MANAGER' });
    expect(replayed.changed).toBe(false);
    expect(replayed.roster).toEqual(added.roster);
  });

  it('treats explicit undefined optional fields as an identical enabled replay', () => {
    const explicitUndefined = {
      ...CODER,
      externalCmd: undefined,
      model: undefined,
    } as unknown as RoleSpec;
    const roster: readonly RosterEntry[] = [
      { spec: COORDINATOR, status: 'enabled' },
      { spec: explicitUndefined, status: 'enabled' },
    ];

    const replayed = addRole(roster, { ...CODER });

    expect(replayed.changed).toBe(false);
    expect(replayed.roster).toEqual(roster);
  });

  it('rejects a conflicting spec for an existing normalized identity', () => {
    expect(() => addRole(INITIAL, { ...CODER, role: 'coder', systemPrompt: 'Different.' })).toThrow(
      /conflict/i,
    );
  });

  it('disables and enables only through the permitted lifecycle edges', () => {
    const disabled = disableRole(INITIAL, 'coder');
    expect(disabled.changed).toBe(true);
    expect(disabled.roster[1]?.status).toBe('disabled');
    expect(disableRole(disabled.roster, 'CODER').changed).toBe(false);

    const enabled = enableRole(disabled.roster, 'CODER');
    expect(enabled.changed).toBe(true);
    expect(enabled.roster[1]?.status).toBe('enabled');
    expect(enableRole(enabled.roster, 'coder').changed).toBe(false);

    const departing: readonly RosterEntry[] = [
      { spec: COORDINATOR, status: 'enabled' },
      { spec: CODER, status: 'departing' },
    ];
    expect(() => enableRole(departing, 'CODER')).toThrow(/departing/i);
    expect(() => disableRole(departing, 'CODER')).toThrow(/departing/i);
  });

  it('never permits COORDINATOR to be disabled', () => {
    expect(() => disableRole(INITIAL, 'COORDINATOR')).toThrow(/COORDINATOR/);
  });

  it('derives executable definitions only from enabled entries', () => {
    const disabled = disableRole(INITIAL, 'CODER').roster;
    expect(enabledRoleSpecs(disabled).map((spec) => spec.role)).toEqual(['COORDINATOR']);
  });
});
