/** Internal observer for an already authorized, live launcher-owned child. This
 * is not a launcher, recovery API, successful tool receipt or resource release. */
import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { BindingFailure, LocalCommandBinding } from './local-command-binding';
import type {
  CommandJournalRecord,
  LocalCommandJournal,
  StoredCommandObservation,
} from './local-command-journal';
import { captureLocalCommandOutput, type LocalCommandOutput } from './local-command-output';
import {
  checkDiscoveryClosure,
  discoverLocalProcessCohort,
  inspectLocalProcess,
  type LocalProcessIdentity,
  stopRegisteredLocalProcesses,
} from './local-command-stop';

type Options = {
  child: ChildProcess;
  identity: LocalProcessIdentity;
  /** Only the held launcher may identify its sole, already registered payload. */
  discoveryRoot?: LocalProcessIdentity;
  helper: string;
  journal: LocalCommandJournal;
  commandId: string;
  revision: number;
  startedAt: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Trusted launch gate only; called once after output observation is attached. */
  release?: () => boolean | Promise<boolean>;
  authorizeCurrent?: (stage: 'running' | 'completion') => Promise<boolean>;
  binding?: LocalCommandBinding;
};
const key = (identity: LocalProcessIdentity) => identity.join(':');

export async function superviseLocalCommand(options: Options) {
  const { child, helper, journal, commandId, signal, startedAt } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !(child instanceof ChildProcess) ||
    child.pid !== options.identity[5] ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isFinite(startedAt) ||
    startedAt < 0 ||
    startedAt > performance.now()
  )
    throw new Error('invalid_command_supervision');
  const record = journal.snapshot().records.find((entry) => entry.commandId === commandId);
  if (
    !record ||
    record.revision !== options.revision ||
    record.resourceState !== 'reserved' ||
    record.birthIdentities.length < 1 ||
    key(record.birthIdentities[0] as LocalProcessIdentity) !== key(options.identity) ||
    (options.binding &&
      (JSON.stringify(record.binding) !== JSON.stringify(options.binding.snapshot()) ||
        options.binding.snapshot().tools[2]?.path !== helper))
  )
    throw new Error('invalid_command_supervision');
  if (
    options.discoveryRoot &&
    (!options.binding ||
      record.birthIdentities.length !== 2 ||
      record.birthRelations.length !== 1 ||
      key(record.birthRelations[0]?.parent ?? []) !== key(options.identity) ||
      key(record.birthRelations[0]?.child ?? []) !== key(options.discoveryRoot) ||
      key(record.birthIdentities[1] ?? []) !== key(options.discoveryRoot))
  )
    throw Error('invalid_command_discovery_root');
  let current: CommandJournalRecord = record;
  const known = record.birthIdentities.map((identity) => [...identity]);
  const seen = new Set(known.map(key));
  let discoveryFailed = false;
  let journalFailed = false;
  let discoveryPasses = 0;
  const discoveryFailures: NonNullable<StoredCommandObservation['discoveryFailures']> = [];
  const closedDuringDiscovery: LocalProcessIdentity[] = [];
  let bindingFailure: BindingFailure | null = null;
  const controlAllowed = options.binding
    ? () => options.binding?.controlAllowed() === true
    : undefined;
  let mainExited = child.exitCode !== null || child.signalCode !== null;
  const onExit = () => {
    mainExited = true;
  };
  child.once('exit', onExit);
  child.once('error', onExit);
  const outputAbort = new AbortController();
  const outputPromise = captureLocalCommandOutput(child, outputAbort.signal);
  let output: LocalCommandOutput | undefined;
  const commandDeadline = startedAt + timeoutMs;
  let nextDiscovery = 0;
  function discover(deadline: number) {
    try {
      const active = journal.snapshot().records.find((entry) => entry.commandId === commandId);
      if (!active || active.revision !== current.revision || active.resourceState !== 'reserved')
        throw new Error('command_supervision_stale');
    } catch {
      journalFailed = true;
      discoveryFailed = true;
      return;
    }
    const live: LocalProcessIdentity[] = [];
    for (const identity of known) {
      // The pinned bootstrap has exactly one child, registered before release,
      // and never forks again. Observe the untrusted payload tree directly;
      // the bootstrap remains registered for identity checks and cleanup.
      if (options.discoveryRoot && key(identity) === key(options.identity)) continue;
      if (deadline - performance.now() < 250) {
        discoveryFailed = true;
        return;
      }
      const observed = inspectLocalProcess(helper, identity, undefined, 250, controlAllowed);
      if (observed.state === 'alive') live.push(identity);
      else if (observed.state !== 'exited') discoveryFailed = true;
    }
    if (!live.length || discoveryFailed) return;
    const discovered = discoverLocalProcessCohort(helper, live, deadline, controlAllowed);
    discoveryPasses++;
    if (discovered.observationState !== 'observed') {
      const closure = checkDiscoveryClosure(helper, discovered, deadline, controlAllowed);
      discoveryFailed = closure.failures.length > 0 || discovered.observations.length === 0;
      for (const item of closure.failures)
        if (discoveryFailures.length < 257) discoveryFailures.push(item);
      for (const identity of closure.closed)
        if (!closedDuringDiscovery.some((existing) => key(existing) === key(identity)))
          closedDuringDiscovery.push(identity);
    }
    for (const relation of discovered.relations) {
      if (seen.has(key(relation.child))) continue;
      if (known.length === 256) {
        discoveryFailed = true;
        break;
      }
      known.push([...relation.child]);
      seen.add(key(relation.child));
      if (journalFailed) continue;
      try {
        current = journal.registerBirth(
          commandId,
          current.revision,
          relation.child,
          relation.parent,
        );
      } catch {
        journalFailed = true;
        discoveryFailed = true;
      }
    }
  }
  const currentBinding = async (
    stage: 'running' | 'completion',
  ): Promise<BindingFailure | null> => {
    if (options.authorizeCurrent) {
      try {
        if (!(await options.authorizeCurrent(stage))) return 'authority_changed';
      } catch {
        return 'authority_changed';
      }
    }
    return options.binding?.check(stage) ?? null;
  };
  let cause: StoredCommandObservation['cause'];
  try {
    if (options.release) {
      try {
        if (!(await options.release())) discoveryFailed = true;
      } catch {
        discoveryFailed = true;
      }
    }
    for (;;) {
      bindingFailure ??= await currentBinding('running');
      if (bindingFailure || discoveryFailed || journalFailed) {
        cause = 'observation_failed';
        break;
      }
      if (signal?.aborted) {
        cause = 'cancelled';
        break;
      }
      if (mainExited) {
        cause = 'exit';
        break;
      }
      if (performance.now() >= commandDeadline) {
        cause = 'timeout';
        break;
      }
      if (performance.now() >= nextDiscovery && commandDeadline - performance.now() >= 1250) {
        discover(Math.min(performance.now() + 1000, commandDeadline));
        nextDiscovery = performance.now() + 200;
      }
      if (discoveryFailed || journalFailed) {
        cause = 'observation_failed';
        break;
      }
      await delay(Math.max(1, Math.min(25, commandDeadline - performance.now())));
    }
    const cleanupStarted = performance.now();
    const cleanupDeadline = cleanupStarted + 5000;
    if (!discoveryFailed && !journalFailed) discover(cleanupStarted + 1000);
    const stop = await stopRegisteredLocalProcesses(helper, known, cleanupDeadline, controlAllowed);
    // Pipe observation cannot turn an unknown main identity into an unbounded wait.
    const remaining = Math.max(0, cleanupDeadline - performance.now());
    const timer = setTimeout(() => outputAbort.abort(), remaining);
    if (stop.registeredState !== 'stopped' || journalFailed) outputAbort.abort();
    try {
      output = await outputPromise;
    } finally {
      clearTimeout(timer);
    }
    const summarize = (stream: LocalCommandOutput['stdout']) => ({
      retainedBytes: stream.bytes.length,
      observedBytes: stream.observedBytes,
      sha256: createHash('sha256').update(stream.bytes).digest('hex'),
      truncated: stream.truncated,
      error: stream.error,
    });
    bindingFailure ??= await currentBinding('completion');
    const receipt: StoredCommandObservation = {
      version: 2,
      bindingFailure,
      cause,
      executionMs: cleanupStarted - startedAt,
      cleanupMs: performance.now() - cleanupStarted,
      discoveryPasses,
      discoveryFailed,
      discoveryFailures,
      closedDuringDiscovery,
      mainResult: output.mainResult,
      stdout: summarize(output.stdout),
      stderr: summarize(output.stderr),
      stop,
    };
    if (!journalFailed) {
      try {
        current = journal.recordObservation(commandId, current.revision, receipt);
      } catch {
        journalFailed = true;
      }
    }
    return { ...receipt, output, durable: !journalFailed };
  } finally {
    outputAbort.abort();
    child.off('exit', onExit);
    child.off('error', onExit);
  }
}
