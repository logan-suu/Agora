// Real Seatbelt processes and filesystem objects; no test doubles.
import { expect, it } from 'vitest';
import { probeCommandIsolation } from './local-command-isolation-fixture';

it('confines native child and exec descendants to one private command write root', async () => {
  const result = await probeCommandIsolation();
  expect(result.exitCode).toBe(0);
  expect(result.events.length).toBe(28);
  for (const actor of ['child', 'grandchild']) {
    const outcome = (operation: string) =>
      result.events.find((event) => event.actor === actor && event.operation === operation);
    expect(outcome('read-input')?.ok).toBe(true);
    expect(outcome('write-output')?.ok).toBe(true);
    for (const operation of [
      'write-source',
      'write-input',
      'read-secret',
      'read-control',
      'read-neighbor',
      'write-neighbor',
      'symlink-write-source',
      'hardlink-source',
      'rename-source',
      'unlink-source',
      'read-source-env',
      'write-source-via-read-fd',
    ]) {
      expect(outcome(operation), `${actor}:${operation}`).toMatchObject({ ok: false });
      expect(outcome(operation)?.errno).toBeGreaterThan(0);
    }
  }
  expect(result.source).toBe('source-sentinel');
  expect(result.input).toBe('fixed-input');
  expect(result.neighbor).toBe('neighbor-sentinel');
  expect(result.secret).toBe('fake-secret-sentinel');
  expect(result.control).toBe('control-sentinel');
  expect(result.outputFiles).toEqual(['child', 'grandchild']);
  expect(result.admissionErrors).toEqual([
    'overlapping_command_scope',
    'overlapping_command_scope',
    'invalid_command_scope',
    'command_output_not_fresh',
  ]);
}, 30_000);

it('runs the pinned Node toolchain and preserves the boundary in its spawned child', async () => {
  const result = await probeCommandIsolation('node');
  expect(result.exitCode).toBe(0);
  expect(result.events).toHaveLength(8);
  for (const actor of ['child', 'grandchild']) {
    for (const operation of ['read-input', 'write-output'])
      expect(
        result.events.find((event) => event.actor === actor && event.operation === operation)?.ok,
      ).toBe(true);
    for (const operation of ['write-source', 'read-secret'])
      expect(
        result.events.find((event) => event.actor === actor && event.operation === operation)?.ok,
      ).toBe(false);
  }
  expect(result.source).toBe('source-sentinel');
  expect(result.outputFiles).toEqual(['child', 'grandchild']);
}, 30_000);
