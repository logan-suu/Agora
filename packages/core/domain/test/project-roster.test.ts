import { describe, expect, it } from 'vitest';

import {
  addRole,
  assignRoleDepartureSuccessor,
  beginRoleDeparture,
  completeRoleDeparture,
  disableRole,
  enabledRoleSpecs,
  enableRole,
  normalizeRoleId,
  type RoleSpec,
  type RosterEntry,
  recordRoleDepartureHandoff,
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

const DEPARTURE = {
  actionId: 'remove-coder-1',
  taskId: 'task-7-2',
  requestedTs: 1_000,
  successorRole: 'TESTER',
} as const;

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
      {
        spec: CODER,
        status: 'departing',
        departure: { ...DEPARTURE, stage: 'draining' },
      },
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

  it('begins a durable departure from enabled or disabled and replays the same action as a no-op', () => {
    const withTester: readonly RosterEntry[] = [
      ...INITIAL,
      { spec: { ...CODER, role: 'TESTER' }, status: 'enabled' },
    ];
    const begun = beginRoleDeparture(withTester, 'coder', DEPARTURE);

    expect(begun.changed).toBe(true);
    expect(begun.roster[1]).toEqual({
      spec: CODER,
      status: 'departing',
      departure: { ...DEPARTURE, stage: 'draining' },
    });
    expect(beginRoleDeparture(begun.roster, 'CODER', DEPARTURE).changed).toBe(false);
    const successorDisabledAfterBegin = disableRole(begun.roster, 'TESTER').roster;
    expect(beginRoleDeparture(successorDisabledAfterBegin, 'CODER', DEPARTURE).changed).toBe(false);

    const disabled = disableRole(withTester, 'CODER').roster;
    expect(
      beginRoleDeparture(disabled, 'CODER', { ...DEPARTURE, actionId: 'disabled' }).roster[1],
    ).toMatchObject({ status: 'departing', departure: { actionId: 'disabled' } });
  });

  it('rejects coordinator departure, unknown or non-enabled successors, and conflicting actions', () => {
    expect(() => beginRoleDeparture(INITIAL, 'COORDINATOR', DEPARTURE)).toThrow(/COORDINATOR/);
    expect(() => beginRoleDeparture(INITIAL, 'CODER', DEPARTURE)).toThrow(/successor.*TESTER/i);

    const withTester: readonly RosterEntry[] = [
      ...INITIAL,
      { spec: { ...CODER, role: 'TESTER' }, status: 'enabled' },
    ];
    expect(() =>
      beginRoleDeparture(withTester, 'CODER', { ...DEPARTURE, successorRole: 'CODER' }),
    ).toThrow(/successor/i);
    const begun = beginRoleDeparture(withTester, 'CODER', DEPARTURE).roster;
    expect(() =>
      beginRoleDeparture(begun, 'CODER', { ...DEPARTURE, actionId: 'another-action' }),
    ).toThrow(/conflict/i);
  });

  it('records a stable handoff before completing departure and preserves the departed identity', () => {
    const withTester: readonly RosterEntry[] = [
      ...INITIAL,
      { spec: { ...CODER, role: 'TESTER' }, status: 'enabled' },
    ];
    const begun = beginRoleDeparture(withTester, 'CODER', DEPARTURE).roster;
    const handoffRef = { taskId: 'task-7-2', msgId: 'role-departure:remove-coder-1' };
    const recorded = recordRoleDepartureHandoff(
      begun,
      'CODER',
      DEPARTURE.actionId,
      handoffRef,
      false,
    );

    expect(recorded.roster[1]).toMatchObject({
      status: 'departing',
      departure: { stage: 'handoff_committed', handoffRef },
    });
    expect(
      recordRoleDepartureHandoff(recorded.roster, 'CODER', DEPARTURE.actionId, handoffRef, false)
        .changed,
    ).toBe(false);

    const completed = completeRoleDeparture(recorded.roster, 'CODER', DEPARTURE.actionId);
    expect(completed.roster[1]).toMatchObject({
      spec: CODER,
      status: 'departed',
      departure: { stage: 'completed', handoffRef },
    });
    expect(completeRoleDeparture(completed.roster, 'CODER', DEPARTURE.actionId).changed).toBe(
      false,
    );
  });

  it('keeps an orphaned responsibility awaiting replacement and refuses completion', () => {
    const withTester: readonly RosterEntry[] = [
      ...INITIAL,
      { spec: { ...CODER, role: 'TESTER' }, status: 'enabled' },
    ];
    const begun = beginRoleDeparture(withTester, 'CODER', {
      actionId: 'remove-coder-orphan',
      taskId: 'task-7-2',
      requestedTs: 2_000,
    }).roster;
    const waiting = recordRoleDepartureHandoff(
      begun,
      'CODER',
      'remove-coder-orphan',
      { taskId: 'task-7-2', msgId: 'role-departure:remove-coder-orphan' },
      true,
    );

    expect(waiting.roster[1]).toMatchObject({
      status: 'departing',
      departure: { stage: 'awaiting_replacement' },
    });
    expect(() => completeRoleDeparture(waiting.roster, 'CODER', 'remove-coder-orphan')).toThrow(
      /awaiting_replacement/i,
    );

    const assigned = assignRoleDepartureSuccessor(
      waiting.roster,
      'CODER',
      'remove-coder-orphan',
      'TESTER',
    );
    expect(assigned.roster[1]).toMatchObject({
      status: 'departing',
      departure: { stage: 'handoff_committed', successorRole: 'TESTER' },
    });
    expect(
      assignRoleDepartureSuccessor(assigned.roster, 'CODER', 'remove-coder-orphan', 'TESTER')
        .changed,
    ).toBe(false);
    expect(
      completeRoleDeparture(assigned.roster, 'CODER', 'remove-coder-orphan').roster[1],
    ).toMatchObject({ status: 'departed', departure: { stage: 'completed' } });
  });
});
