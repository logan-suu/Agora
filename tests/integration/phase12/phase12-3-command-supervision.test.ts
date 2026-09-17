// Real Seatbelt processes, kernel identities and durable records; no test doubles.
import { expect, it } from 'vitest';
import { probeLocalCommandSupervision } from './local-command-supervision-fixture';

it('persists observed parent relations and stops descendants after the main process exits', async () => {
  const result = await probeLocalCommandSupervision('exit');
  expect(result.receipt.cause).toBe('exit');
  expect(result.receipt.output.mainResult.exitCode).toBe(0);
  expect(result.receipt.stop.registeredState).toBe('stopped');
  expect(result.record.birthRelations).toHaveLength(2);
  expect(result.record.birthIdentities).toHaveLength(3);
  expect(result.record.observationReceipt).not.toBeNull();
  expect(result.blocked).toBe(true);
}, 20_000);

it('uses the default thirty-second execution limit and closes durable observation after timeout', async () => {
  const result = await probeLocalCommandSupervision('timeout');
  expect(result.receipt.cause).toBe('timeout');
  expect(result.receipt.executionMs).toBeGreaterThanOrEqual(29_500);
  expect(result.receipt.executionMs).toBeLessThan(31_000);
  expect(result.receipt.cleanupMs).toBeLessThan(5000);
  expect(result.receipt.stop.registeredState).toBe('stopped');
  expect(result.blocked).toBe(true);
}, 45_000);

it('cancels a running process tree without extending the cleanup deadline', async () => {
  const result = await probeLocalCommandSupervision('cancel');
  expect(result.receipt.cause).toBe('cancelled');
  expect(result.receipt.stop.registeredState).toBe('stopped');
  expect(result.receipt.cleanupMs).toBeLessThan(5000);
  expect(result.record.birthRelations).toHaveLength(2);
  expect(result.receipt.durable).toBe(true);
}, 20_000);

it('bounds observation when the registered identity is wrong without signaling the live process', async () => {
  const result = await probeLocalCommandSupervision('wrong-birth');
  expect(result.receipt.cause).toBe('observation_failed');
  expect(result.receipt.stop.registeredState).toBe('needsAttention');
  expect(result.receipt.stop.signals).toEqual([]);
  expect(result.aliveAfterSupervision).toBe(true);
  expect(result.receipt.output.mainResult.error).toBe('command_observation_incomplete');
  expect(result.record.resourceState).toBe('quarantined');
}, 20_000);

it('rejects invalid parent relations atomically and refuses corrupted or old-version records', async () => {
  const result = await probeLocalCommandSupervision('journal');
  expect(result.errors).toEqual([
    'unknown_process_parent',
    'process_identity_reused',
    'command_revision_conflict',
    'invalid_command_journal',
    'invalid_command_journal',
  ]);
  expect(result.record.birthRelations).toHaveLength(2);
  expect(result.receipt.stop.registeredState).toBe('stopped');
  expect(result.blocked).toBe(true);
}, 20_000);

it('preserves blocking state when the final observation cannot be durably committed', async () => {
  const result = await probeLocalCommandSupervision('journal-failure');
  expect(result.receipt.cause).toBe('cancelled');
  expect(result.receipt.stop.registeredState).toBe('stopped');
  expect(result.receipt.durable).toBe(false);
  expect(result.errors).toEqual(['command_journal_locked']);
  expect(result.record.observationReceipt).toBeNull();
  expect(result.record.resourceState).toBe('reserved');
  expect(result.blocked).toBe(true);
}, 20_000);

it('stops observing execution when the durable command is quarantined by the control plane', async () => {
  const result = await probeLocalCommandSupervision('journal-revoked');
  expect(result.receipt.cause).toBe('observation_failed');
  expect(result.receipt.stop.registeredState).toBe('stopped');
  expect(result.receipt.durable).toBe(false);
  expect(result.record.resourceState).toBe('quarantined');
  expect(result.record.observationReceipt).toBeNull();
  expect(result.blocked).toBe(true);
}, 20_000);
