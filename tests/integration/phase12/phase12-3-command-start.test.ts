// Real native bootstrap, Seatbelt and kernel identities; no test doubles.
import { expect, it } from 'vitest';
import { probeLocalCommandStart } from './local-command-start-fixture';

it('initializes a cold helper before applying the shorter process-query deadline', async () => {
  const value = await probeLocalCommandStart('control-ready-delayed');
  expect(value.result.controlReady?.outcome).toBe('ready');
  expect(value.result.controlReady?.durationMs).toBeGreaterThanOrEqual(350);
  expect(value.result.captureAttempts.map((a) => a.outcome)).toEqual(['captured']);
  expect(value.captureInvocations).toBe(1);
  expect(value.result.released).toBe(true);
  expect(value.result.payloadResult).toEqual({ exitCode: 7, signal: null });
}, 20_000);

it('fails closed before bootstrap creation if helper initialization consumes the launch window', async () => {
  const value = await probeLocalCommandStart('control-ready-timeout');
  expect(value.result.controlReady?.outcome).toBe('failed');
  expect(value.result.error).toBe('command_control_unavailable');
  expect(value.result.captureAttempts).toEqual([]);
  expect(value.captureInvocations).toBe(0);
  expect(value.record?.birthIdentities).toHaveLength(0);
  expect(value.afterRelease).toBe(false);
}, 20_000);

it('rejects malformed helper readiness without attempting PID capture', async () => {
  const value = await probeLocalCommandStart('control-ready-invalid');
  expect(value.result.error).toBe('command_control_unavailable');
  expect(value.result.captureAttempts).toEqual([]);
  expect(value.captureInvocations).toBe(0);
  expect(value.afterRelease).toBe(false);
}, 20_000);

it('recovers a transient read-only capture timeout without changing launch or call deadlines', async () => {
  const value = await probeLocalCommandStart('capture-once');
  expect(value.captureInvocations).toBe(2);
  expect(value.result.captureAttempts.map((a) => a.outcome)).toEqual(['timed_out', 'captured']);
  expect(value.result.released).toBe(true);
  expect(value.result.payloadResult).toEqual({ exitCode: 7, signal: null });
  expect(value.registeredAtRelease).toBe(2);
  expect(value.beforeRelease).toBe(false);
}, 20_000);

it('still rejects release authorization after a transient capture timeout', async () => {
  const value = await probeLocalCommandStart('capture-revoked');
  expect(value.captureInvocations).toBe(2);
  expect(value.result.error).toBe('command_start_denied');
  expect(value.result.released).toBe(false);
  expect(value.afterRelease).toBe(false);
  expect(value.result.launchDurable).toBe(true);
}, 20_000);

it('bounds persistent capture timeouts to three attempts and keeps resources quarantined', async () => {
  const value = await probeLocalCommandStart('capture-always');
  expect(value.captureInvocations).toBe(3);
  expect(value.result.captureAttempts.map((a) => a.outcome)).toEqual([
    'timed_out',
    'timed_out',
    'timed_out',
  ]);
  expect(value.result.error).toBe('command_capture_timeout');
  expect(value.result.released).toBe(false);
  expect(value.afterRelease).toBe(false);
  expect(value.record?.birthIdentities).toHaveLength(0);
  expect(value.record?.resourceState).toBe('quarantined');
}, 20_000);

it('does not retry a failed kernel query that did not time out', async () => {
  const value = await probeLocalCommandStart('capture-error');
  expect(value.captureInvocations).toBe(1);
  expect(value.result.captureAttempts.map((a) => a.outcome)).toEqual(['failed']);
  expect(value.result.error).toBe('command_capture_failed');
  expect(value.afterRelease).toBe(false);
}, 20_000);

it('rechecks authority before retrying capture', async () => {
  const value = await probeLocalCommandStart('capture-authority');
  expect(value.captureInvocations).toBe(1);
  expect(value.result.error).toBe('command_binding_invalidated');
  expect(value.afterRelease).toBe(false);
  expect(value.record?.birthIdentities).toHaveLength(0);
}, 20_000);

it('does not execute a replacement helper on a capture retry', async () => {
  const value = await probeLocalCommandStart('capture-tool');
  expect(value.captureInvocations).toBe(1);
  expect(value.result.error).toBe('command_binding_invalidated');
  expect(value.afterRelease).toBe(false);
  expect(value.record?.birthIdentities).toHaveLength(0);
}, 20_000);

it('honors cancellation between capture attempts', async () => {
  const value = await probeLocalCommandStart('capture-cancel');
  expect(value.captureInvocations).toBe(1);
  expect(value.result.error).toBe('command_start_denied');
  expect(value.afterRelease).toBe(false);
  expect(value.record?.birthIdentities).toHaveLength(0);
}, 20_000);

it('observes bootstrap exit before another PID capture can be attempted', async () => {
  const value = await probeLocalCommandStart('capture-exited');
  expect(value.captureInvocations).toBe(1);
  expect(value.result.error).toBe('command_bootstrap_failed');
  expect(value.afterRelease).toBe(false);
  expect(value.record?.birthIdentities).toHaveLength(0);
}, 20_000);

it('refuses a capture when a control-plane check exhausts the original startup window', async () => {
  const value = await probeLocalCommandStart('capture-deadline');
  expect(value.captureInvocations).toBe(0);
  expect(value.result.error).toBe('command_capture_deadline');
  expect(value.afterRelease).toBe(false);
}, 20_000);

it('registers the suspended executable before any constructor or project code runs', async () => {
  const result = await probeLocalCommandStart('run');
  expect(result.beforeRelease).toBe(false);
  expect(result.registeredAtRelease).toBe(2);
  expect(result.result.released).toBe(true);
  expect(result.result.payloadResult).toEqual({ exitCode: 7, signal: null });
  expect(result.result.observation?.stop.registeredState).toBe('stopped');
  expect(result.afterRelease).toBe(true);
  expect(result.blocked).toBe(true);
}, 20_000);

it('keeps project code suspended when the release authorization is revoked', async () => {
  const result = await probeLocalCommandStart('revoked');
  expect(result.result.released).toBe(false);
  expect(result.result.error).toBe('command_start_denied');
  expect(result.result.launchDurable).toBe(true);
  expect(result.record?.launchReceipt?.payloadResult).toBeNull();
  expect(result.afterRelease).toBe(false);
  expect(result.blocked).toBe(true);
}, 20_000);

it('does not release the executable when durable registration fails', async () => {
  const result = await probeLocalCommandStart('journal-failure');
  expect(result.result.released).toBe(false);
  expect(result.afterRelease).toBe(false);
  expect(result.result.error).toBe('command_journal_locked');
  expect(result.result.launchDurable).toBe(false);
  expect(result.record?.launchReceipt).toBeNull();
  expect(result.result.startupStop?.registeredState).toBe('stopped');
  expect(result.blocked).toBe(true);
}, 20_000);

it('closes the bootstrap control channel and inherited extra descriptors before project code', async () => {
  const result = await probeLocalCommandStart('descriptors');
  expect(result.result.released).toBe(true);
  expect(result.payloadReport).toMatchObject({ extraFds: 0, inheritedSecret: false });
  expect(result.sentinelUnchanged).toBe(true);
}, 20_000);

it('records a failed exec without releasing any project code', async () => {
  const result = await probeLocalCommandStart('bad-executable');
  expect(result.result.released).toBe(false);
  expect(result.afterRelease).toBe(false);
  expect(result.result.error).toBe('command_bootstrap_failed');
  expect(result.blocked).toBe(true);
}, 20_000);

it('rejects policy drift at admission without creating a bootstrap process', async () => {
  const result = await probeLocalCommandStart('policy-drift');
  expect(result.result.released).toBe(false);
  expect(result.result.error).toBe('invalid_command_start');
  expect(result.record?.birthIdentities).toHaveLength(0);
  expect(result.afterRelease).toBe(false);
}, 20_000);

it('rechecks durable state after the authorization callback before releasing the executable', async () => {
  const result = await probeLocalCommandStart('durable-revocation');
  expect(result.result.released).toBe(false);
  expect(result.result.error).toBe('command_start_denied');
  expect(result.result.launchDurable).toBe(true);
  expect(result.record?.launchReceipt?.payloadResult).toBeNull();
  expect(result.afterRelease).toBe(false);
  expect(result.record?.resourceState).toBe('quarantined');
}, 20_000);

it('keeps the real executable signal separate from the successful bootstrap exit', async () => {
  const result = await probeLocalCommandStart('signal');
  expect(result.result.payloadResult).toEqual({ exitCode: null, signal: 30 });
  expect(result.result.observation?.mainResult.exitCode).toBe(0);
  expect(result.result.launchDurable).toBe(true);
  expect(result.record?.launchReceipt?.payloadResult).toEqual({ exitCode: null, signal: 30 });
}, 20_000);

it('persists the executable result independently of the bootstrap and survives reopening', async () => {
  const result = await probeLocalCommandStart('run');
  expect(result.result.launchDurable).toBe(true);
  expect(result.reopenedRecord).toEqual(result.record);
  expect(result.record?.launchReceipt).toMatchObject({
    version: 1,
    released: true,
    payloadResult: { exitCode: 7, signal: null },
    error: null,
  });
  expect(result.record?.observationReceipt?.mainResult.exitCode).toBe(0);
  expect(result.record?.resourceState).toBe('quarantined');
}, 20_000);

it('never overwrites a terminal launch fact and rejects stale revisions', async () => {
  const result = await probeLocalCommandStart('receipt-replay');
  expect(result.receiptChecks).toEqual([
    'command_launch_already_recorded',
    'command_revision_conflict',
  ]);
  expect(result.receiptBytesUnchanged).toBe(true);
  expect(result.record?.launchReceipt?.payloadResult?.exitCode).toBe(7);
}, 20_000);

it('rejects persisted launch facts that contradict identities or release state', async () => {
  const result = await probeLocalCommandStart('receipt-corrupt');
  expect(result.receiptChecks).toEqual([
    'invalid_command_journal',
    'invalid_command_journal',
    'invalid_command_journal',
    'invalid_command_journal',
  ]);
  expect(result.reopenedRecord).toEqual(result.record);
}, 20_000);

it('preserves observed process facts without claiming a launch receipt when final persistence is blocked', async () => {
  const result = await probeLocalCommandStart('receipt-lock');
  expect(result.result.payloadResult).toEqual({ exitCode: 7, signal: null });
  expect(result.result.observation?.durable).toBe(true);
  expect(result.result.launchDurable).toBe(false);
  expect(result.result.error).toBe('command_journal_unavailable');
  expect(result.record?.observationReceipt).not.toBeNull();
  expect(result.record?.launchReceipt).toBeNull();
  expect(result.reopenedRecord).toEqual(result.record);
  expect(result.blocked).toBe(true);
}, 20_000);

for (const scenario of ['async-release-revoked', 'async-authority-rejected'] as const)
  it(`waits for current asynchronous authority before releasing project code: ${scenario}`, async () => {
    const result = await probeLocalCommandStart(scenario);
    expect(result.result.released).toBe(false);
    expect(result.result.error).toBe('command_start_denied');
    expect(result.afterRelease).toBe(false);
    expect(result.result.launchDurable).toBe(true);
  }, 20_000);
