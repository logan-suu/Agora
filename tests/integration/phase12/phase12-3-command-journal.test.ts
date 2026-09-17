// Real private directories and durable JSON records; no test doubles.
import { expect, it } from 'vitest';
import { probeCommandJournal } from './local-command-journal-fixture';

it('persists interrupted reservations and forbids both path and renamed-inode reuse', () => {
  const result = probeCommandJournal('interrupted');
  expect(result.errors).toEqual(['command_resource_reused', 'command_resource_reused']);
  expect(result.record?.resourceState).toBe('reserved');
  expect(result.recovered?.blocked).toBe(true);
});

it('persists quarantine and never invents full cleanup', () => {
  const result = probeCommandJournal('quarantine');
  expect(result.record?.resourceState).toBe('quarantined');
  expect(result.record?.reason).toBe('discovery_incomplete');
  expect(result.recovered?.blocked).toBe(true);
  expect(result.errors).toEqual(['command_record_closed']);
});

it('rejects a changed replay and a stale revision without overwriting durable state', () => {
  const result = probeCommandJournal('replay');
  expect(result.errors).toEqual(['command_replay_conflict', 'command_revision_conflict']);
  expect(result.record?.revision).toBe(0);
});

it('fails closed after journal corruption or a surviving crash lock', () => {
  const result = probeCommandJournal('corrupt');
  expect(result.errors).toEqual(['invalid_command_journal', 'command_journal_locked']);
});

it('refuses replacement of the bound control directory', () => {
  const result = probeCommandJournal('root-replaced');
  expect(result.errors).toEqual(['command_journal_root_changed']);
});
