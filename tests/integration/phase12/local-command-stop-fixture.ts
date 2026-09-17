// Trusted controller; only fixed payloads receive Seatbelt execution rights.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalCommandJournal } from '../../../packages/runtime/sandbox/src/local-command-journal';
import { captureLocalCommandOutput } from '../../../packages/runtime/sandbox/src/local-command-output';
import { buildLocalCommandPolicy } from '../../../packages/runtime/sandbox/src/local-command-policy';
import {
  captureLocalProcess,
  inspectLocalProcess,
  type LocalProcessIdentity,
  prepareLocalProcessControl,
  type RegisteredStopReceipt,
  stopRegisteredLocalProcesses,
} from '../../../packages/runtime/sandbox/src/local-command-stop';

type Scenario =
  | 'ignore-term'
  | 'delayed-control'
  | 'flood'
  | 'inherited-pipe'
  | 'normal-term'
  | 'wrong-birth';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const available = () => {
  const stat = statfsSync('/private/tmp');
  return stat.bavail * stat.bsize;
};

export async function probeLocalCommandStop(scenario: Scenario) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Apple Silicon Seatbelt validation required; no fallback.');
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const root = statSync(base);
  const directory = resolve('docs/reviews/task123-stop-evidence');
  mkdirSync(directory, { recursive: true });
  const evidencePath = join(directory, `${scenario}-${base.split('-').at(-1)}.json`);
  const paths = [
    'packages/runtime/sandbox/native/local-process-control.c',
    'packages/runtime/sandbox/native/local-command-stop-probe.c',
    'packages/runtime/sandbox/src/local-command-stop.ts',
    'packages/runtime/sandbox/src/local-command-output.ts',
    'packages/runtime/sandbox/src/local-command-policy.ts',
    'tests/integration/phase12/local-command-stop-fixture.ts',
    'tests/integration/phase12/phase12-3-command-stop.test.ts',
    'packages/runtime/sandbox/src/local-command-journal.ts',
  ];
  const evidence: Record<string, unknown> = {
    scenario,
    base,
    startedAt: new Date().toISOString(),
    identity: { uid: root.uid, dev: root.dev, ino: root.ino },
    sources: Object.fromEntries(paths.map((path) => [path, hash(path)])),
    os: execFileSync('/usr/bin/sw_vers', [], { encoding: 'utf8' }),
    compiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }),
    node: process.version,
    availableBefore: available(),
  };
  const helper = join(base, 'control');
  const nativeHelper = scenario === 'delayed-control' ? join(base, 'control-native') : helper;
  const payload = join(base, 'payload');
  let identity: LocalProcessIdentity | undefined;
  let lastLaunchAt = 0;
  let closed = false;
  try {
    for (const [source, target] of [
      [paths[0], nativeHelper],
      [paths[1], payload],
    ]) {
      execFileSync('/usr/bin/clang', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-mmacosx-version-min=15.0',
        source as string,
        '-o',
        target as string,
      ]);
    }
    if (scenario === 'delayed-control') {
      // Add real launch latency without replacing kernel inspection or signaling.
      const wrapper = `#define _DARWIN_C_SOURCE
#include <limits.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char target[PATH_MAX];
  if (argc < 2 || snprintf(target, sizeof(target), "%s-native", argv[0]) >= PATH_MAX) return 64;
  usleep(130000);
  execv(target, argv);
  return 65;
}
`;
      execFileSync(
        '/usr/bin/clang',
        ['-std=c11', '-Wall', '-Wextra', '-Werror', '-x', 'c', '-', '-o', helper],
        { input: wrapper },
      );
      evidence.controlWrapper = wrapper;
    }
    evidence.binaries = {
      helper: hash(helper),
      nativeHelper: hash(nativeHelper),
      payload: hash(payload),
    };
    const controlHash = hash(nativeHelper);
    const controlStarted = performance.now();
    prepareLocalProcessControl(
      nativeHelper,
      controlStarted + 5000,
      () => hash(nativeHelper) === controlHash,
    );
    evidence.controlReadinessMs = performance.now() - controlStarted;
    for (const name of ['source', 'input', 'output', 'secrets', 'journal'])
      mkdirSync(join(base, name), { mode: 0o700 });
    const policy = buildLocalCommandPolicy({
      executable: payload,
      sourceRoot: join(base, 'source'),
      inputRoot: join(base, 'input'),
      outputRoot: join(base, 'output'),
      deniedRoots: [join(base, 'secrets'), join(base, 'journal')],
    });
    evidence.policy = policy;
    const journal = new LocalCommandJournal(join(base, 'journal'), true);
    const reservation = journal.reserve({
      commandId: `fixture-${scenario}`,
      workspaceId: 'fixed-fixture',
      policyHash: createHash('sha256').update(policy).digest('hex'),
      inputHash: createHash('sha256').update('empty-fixed-input').digest('hex'),
      roots: [join(base, 'output')],
    });
    lastLaunchAt = Date.now();
    const child = spawn(
      '/usr/bin/sandbox-exec',
      ['-p', policy, payload, scenario === 'delayed-control' ? 'ignore-term' : scenario],
      {
        cwd: base,
        env: { NODE_ENV: 'test', HOME: join(base, 'output'), TMPDIR: join(base, 'output') },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const outputPromise = captureLocalCommandOutput(child);
    const closedPromise = new Promise<void>((resolve) =>
      child.once('close', () => {
        closed = true;
        resolve();
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('payload_not_ready')), 2000);
      child.stdout.once('data', (data: Buffer) => {
        clearTimeout(timer);
        if (data.toString() !== 'ready\n') reject(new Error('unexpected_payload_handshake'));
        else resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('payload_exited_before_ready'));
      });
    });
    identity = captureLocalProcess(nativeHelper, child.pid as number);
    evidence.birthIdentity = identity;
    const registered = journal.registerBirth(reservation.commandId, reservation.revision, identity);
    const forged = [...identity];
    forged[7] = ((forged[7] ?? 0) + 1) >>> 0;
    const wrong = inspectLocalProcess(nativeHelper, forged, 'TERM');
    const aliveAfterForgedSignal = inspectLocalProcess(nativeHelper, identity).state === 'alive';
    if (scenario === 'delayed-control') {
      // Launch the newly compiled delay executable once before measuring the
      // stop phases; first-launch OS validation is a separate failure boundary.
      const started = performance.now();
      evidence.delayProbeWarmup = JSON.parse(
        execFileSync(helper, ['inspect', ...identity.map(String)], {
          encoding: 'utf8',
          timeout: 2000,
          env: { NODE_ENV: 'test' },
        }),
      );
      evidence.delayProbeWarmupMs = performance.now() - started;
    }
    child.stdin.end('x');
    let stop: RegisteredStopReceipt | undefined;
    if (scenario === 'ignore-term' || scenario === 'delayed-control' || scenario === 'normal-term')
      stop = await stopRegisteredLocalProcesses(helper, [identity]);
    if (scenario === 'wrong-birth') {
      stop = await stopRegisteredLocalProcesses(helper, [forged]);
      evidence.aliveAfterRejectedCohort = inspectLocalProcess(helper, identity).state === 'alive';
      evidence.ownedProcessCleanup = await stopRegisteredLocalProcesses(helper, [identity]);
    }
    const output = await outputPromise;
    await closedPromise;
    evidence.resourceRecord = journal.quarantine(
      registered.commandId,
      registered.revision,
      'discovery_incomplete',
    );
    evidence.reopenedResourceState = new LocalCommandJournal(join(base, 'journal')).snapshot();
    const result = { forgedIdentityState: wrong.state, aliveAfterForgedSignal, stop, output };
    const summarize = (value: typeof output.stdout) => ({
      retainedBytes: value.bytes.length,
      sha256: createHash('sha256').update(value.bytes).digest('hex'),
      observedBytes: value.observedBytes,
      truncated: value.truncated,
      error: value.error,
    });
    evidence.result = {
      ...result,
      output: { ...output, stdout: summarize(output.stdout), stderr: summarize(output.stderr) },
    };
    return result;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (identity)
      evidence.finalRegisteredStop = await stopRegisteredLocalProcesses(helper, [identity]);
    // Only this fixed source has a six-second alarm and a four-second pipe holder.
    // This delay is fixture cleanup support, never a production cessation receipt.
    if (lastLaunchAt && (!closed || scenario === 'inherited-pipe'))
      await delay(Math.max(0, lastLaunchAt + 7500 - Date.now()));
    evidence.completedAt = new Date().toISOString();
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const current = statSync(base);
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
    const mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
    const removable =
      current.uid === root.uid &&
      current.dev === root.dev &&
      current.ino === root.ino &&
      realpathSync(base) === base &&
      handles.status === 1 &&
      !handles.stdout &&
      !handles.stderr &&
      mounts.status === 0 &&
      !mounts.stdout.includes(base);
    evidence.cleanup = {
      removed: false,
      handles,
      mountCheckPassed: mounts.status === 0 && !mounts.stdout.includes(base),
    };
    if (removable) {
      rmSync(base, { recursive: true });
      evidence.cleanup = { ...(evidence.cleanup as object), removed: !existsSync(base) };
    }
    evidence.availableAfter = available();
    evidence.spaceDelta =
      (evidence.availableAfter as number) - (evidence.availableBefore as number);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
