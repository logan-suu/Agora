// Trusted fixed-fixture controller; all payloads run inside Seatbelt.
// Fault wrappers inject real durable locks after production commits, never fake results.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type LocalCommandAuthority,
  LocalCommandBinding,
} from '../../../packages/runtime/sandbox/src/local-command-binding';
import { LocalCommandJournal } from '../../../packages/runtime/sandbox/src/local-command-journal';
import { buildLocalCommandPolicy } from '../../../packages/runtime/sandbox/src/local-command-policy';
import { runHeldLocalCommand } from '../../../packages/runtime/sandbox/src/local-command-start';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const available = () => {
  const stat = statfsSync('/private/tmp');
  return stat.bavail * stat.bsize;
};
type Scenario =
  | 'run'
  | 'async-release-revoked'
  | 'async-authority-rejected'
  | 'revoked'
  | 'journal-failure'
  | 'descriptors'
  | 'bad-executable'
  | 'policy-drift'
  | 'durable-revocation'
  | 'signal'
  | 'receipt-replay'
  | 'receipt-corrupt'
  | 'receipt-lock'
  | 'capture-once'
  | 'capture-revoked'
  | 'capture-always'
  | 'capture-error'
  | 'capture-exited'
  | 'capture-authority'
  | 'capture-tool'
  | 'capture-cancel'
  | 'capture-deadline'
  | 'control-ready-delayed'
  | 'control-ready-timeout'
  | 'control-ready-invalid';
export async function probeLocalCommandStart(scenario: Scenario) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Apple Silicon validation required; no fallback.');
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const identity = statSync(base);
  const folder = resolve('docs/reviews/task123-start-evidence');
  mkdirSync(folder, { recursive: true });
  const evidencePath = join(folder, `${scenario}-${base.split('-').at(-1)}.json`);
  const sources = [
    'packages/runtime/sandbox/native/local-process-control.c',
    'packages/runtime/sandbox/native/local-command-bootstrap.c',
    'packages/runtime/sandbox/native/local-command-start-probe.c',
    'packages/runtime/sandbox/src/local-command-start.ts',
    'packages/runtime/sandbox/src/local-command-supervisor.ts',
    'packages/runtime/sandbox/src/local-command-stop.ts',
    'packages/runtime/sandbox/src/local-command-policy.ts',
    'tests/integration/phase12/local-command-start-fixture.ts',
    'tests/integration/phase12/phase12-3-command-start.test.ts',
    'packages/runtime/sandbox/src/local-command-journal.ts',
    'packages/runtime/sandbox/src/local-command-binding.ts',
    'packages/runtime/sandbox/native/local-command-capture-probe.c',
  ];
  const evidence: Record<string, unknown> = {
    scenario,
    base,
    startedAt: new Date().toISOString(),
    identity: { uid: identity.uid, dev: identity.dev, ino: identity.ino },
    sources: Object.fromEntries(sources.map((p) => [p, sha(readFileSync(p))])),
    os: execFileSync('/usr/bin/sw_vers', [], { encoding: 'utf8' }),
    compiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }),
    node: process.version,
    availableBefore: available(),
  };
  let extra: number | undefined;
  const cancel = new AbortController();
  const previousSecret = process.env.AGORA_FIXED_FAKE_SECRET;
  try {
    const [helper, bootstrap, payload] = ['control', 'bootstrap', 'payload'].map((name) =>
      join(base, name),
    ) as [string, string, string];
    for (const [i, target] of [helper, bootstrap, payload].entries())
      execFileSync('/usr/bin/clang', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-mmacosx-version-min=15.0',
        sources[i] as string,
        '-o',
        target,
      ]);
    if (scenario.startsWith('capture-') || scenario.startsWith('control-ready-')) {
      const mode =
        scenario === 'control-ready-delayed'
          ? 6
          : scenario === 'control-ready-timeout'
            ? 7
            : scenario === 'control-ready-invalid'
              ? 8
              : scenario === 'capture-always'
                ? 2
                : scenario === 'capture-error'
                  ? 3
                  : scenario === 'capture-exited'
                    ? 4
                    : 1;
      execFileSync('/usr/bin/clang', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-mmacosx-version-min=15.0',
        `-DAGORA_CAPTURE_PROBE_MODE=${mode}`,
        sources.at(-1) as string,
        '-o',
        helper,
      ]);
    }
    evidence.binaries = Object.fromEntries(
      [helper, bootstrap, payload].map((p) => [p, sha(readFileSync(p))]),
    );
    for (const name of ['source', 'input', 'output', 'journal'])
      mkdirSync(join(base, name), { mode: 0o700 });
    const outputRoot = join(base, 'output');
    const marker = join(outputRoot, 'constructor-ran');
    const sentinel = join(base, 'fake-secret');
    writeFileSync(sentinel, 'fixed-sentinel', { mode: 0o600 });
    extra = openSync(sentinel, 'r+');
    process.env.AGORA_FIXED_FAKE_SECRET = 'fixed-fake-value';
    if (scenario === 'bad-executable') writeFileSync(payload, 'invalid-fixed-binary');
    const policy = buildLocalCommandPolicy({
      executable: payload,
      bootstrap,
      sourceRoot: join(base, 'source'),
      inputRoot: join(base, 'input'),
      outputRoot,
      deniedRoots: [join(base, 'journal')],
    });
    evidence.policy = policy;
    const journal = new LocalCommandJournal(join(base, 'journal'), true);
    if (scenario === 'receipt-lock') {
      // Inject a real lock after the actual durable observation commit. Do not
      // couple this fault boundary to a particular number of microtask turns.
      const recordObservation = journal.recordObservation.bind(journal);
      journal.recordObservation = (...args) => {
        const recorded = recordObservation(...args);
        writeFileSync(join(base, 'journal', 'commands.lock'), 'fixed-lock', {
          flag: 'wx',
          mode: 0o600,
        });
        return recorded;
      };
    }
    const reservation = journal.reserve({
      commandId: `fixture-${scenario}`,
      workspaceId: 'fixed-fixture',
      policyHash: sha(policy),
      inputHash: sha('fixed-start-payload'),
      roots: [outputRoot],
    });
    let beforeRelease = false;
    let registeredAtRelease = 0;
    const checkpoints: string[] = [];
    const result = await runHeldLocalCommand({
      bootstrap,
      executable: payload,
      argv: scenario === 'signal' ? ['signal'] : [],
      policy: scenario === 'policy-drift' ? `${policy}\n` : policy,
      outputRoot,
      helper,
      journal,
      commandId: reservation.commandId,
      revision: reservation.revision,
      binding: new LocalCommandBinding(
        {
          commandId: reservation.commandId,
          bootstrap,
          executable: payload,
          helper,
          argv: scenario === 'signal' ? ['signal'] : [],
          policy,
          outputRoot,
        },
        ['source', 'input', 'output', 'journal'].map((name) => join(base, name)),
        fixedAuthority(),
        () => {
          if (scenario === 'capture-tool' && existsSync(`${helper}.attempts`))
            writeFileSync(helper, 'fixed-invalid-replacement');
          if (scenario === 'capture-cancel' && existsSync(`${helper}.attempts`)) cancel.abort();
          if (scenario === 'capture-authority' && existsSync(`${helper}.attempts`))
            return { ...fixedAuthority(), grantRevision: 1 };
          return fixedAuthority();
        },
      ),
      signal: cancel.signal,
      async authorizeCurrent(stage) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (scenario === 'async-authority-rejected' && stage === 'spawn')
          throw Error('fixed authority unavailable');
        return !(scenario === 'async-release-revoked' && stage === 'release');
      },
      authorize(stage) {
        checkpoints.push(stage);
        if (scenario === 'capture-deadline' && stage === 'spawn')
          execFileSync('/bin/sleep', ['5.1']);
        if (stage === 'register' && scenario === 'journal-failure')
          writeFileSync(join(base, 'journal', 'commands.lock'), 'fixed-lock', {
            flag: 'wx',
            mode: 0o600,
          });
        if (stage === 'release') {
          beforeRelease = existsSync(marker);
          registeredAtRelease = journal.snapshot().records[0]?.birthIdentities.length ?? 0;
          if (scenario === 'revoked' || scenario === 'capture-revoked') return false;
          if (scenario === 'durable-revocation') {
            const active = journal.snapshot().records[0];
            if (!active) throw new Error('fixture_record_missing');
            journal.quarantine(active.commandId, active.revision, 'control_failure');
          }
        }
        return true;
      },
    });
    if (scenario === 'journal-failure' || scenario === 'receipt-lock') {
      const lock = join(base, 'journal', 'commands.lock');
      if (readFileSync(lock, 'utf8') !== 'fixed-lock') throw new Error('fixture_lock_changed');
      // Restore only this fixture's lock after the controller has returned.
      unlinkSync(lock);
      evidence.fixtureLockRestored = true;
    }
    const snapshot = journal.snapshot();
    const record = snapshot.records[0];
    const receiptChecks: string[] = [];
    let receiptBytesUnchanged = false;
    const file = join(base, 'journal', 'commands.json');
    const original = readFileSync(file);
    if (scenario === 'receipt-replay' && record?.launchReceipt) {
      for (const revision of [record.revision, record.revision - 1]) {
        try {
          journal.recordLaunch(record.commandId, revision, {
            ...record.launchReceipt,
            payloadResult: { exitCode: 0, signal: null },
          });
          receiptChecks.push('accepted');
        } catch (error) {
          receiptChecks.push((error as Error).message);
        }
      }
      receiptBytesUnchanged = readFileSync(file).equals(original);
    }
    if (scenario === 'receipt-corrupt') {
      for (const fault of ['unreleased', 'identity', 'both-results', 'old-format']) {
        const wrapper = JSON.parse(original.toString());
        const receipt = wrapper.data.records[0].launchReceipt;
        if (fault === 'unreleased') receipt.released = false;
        if (fault === 'identity') receipt.targetIdentity[7] += 1;
        if (fault === 'both-results') receipt.payloadResult.signal = 15;
        if (fault === 'old-format') wrapper.data.version = 3;
        wrapper.sha256 = sha(JSON.stringify(wrapper.data));
        writeFileSync(file, JSON.stringify(wrapper));
        try {
          new LocalCommandJournal(join(base, 'journal'));
          receiptChecks.push('accepted');
        } catch (error) {
          receiptChecks.push((error as Error).message);
        } finally {
          // Restore only this test's exact original record after exercising read refusal.
          writeFileSync(file, original);
        }
      }
    }
    const reopenedRecord = new LocalCommandJournal(join(base, 'journal')).snapshot().records[0];
    const payloadReport = result.observation?.output.stdout.bytes.length
      ? JSON.parse(result.observation.output.stdout.bytes.toString())
      : null;
    const value = {
      captureInvocations: existsSync(`${helper}.attempts`)
        ? readFileSync(`${helper}.attempts`, 'utf8').length
        : 0,
      result,
      beforeRelease,
      afterRelease: existsSync(marker),
      registeredAtRelease,
      record,
      reopenedRecord,
      receiptChecks,
      receiptBytesUnchanged,
      blocked: snapshot.blocked,
      payloadReport,
      sentinelUnchanged: readFileSync(sentinel, 'utf8') === 'fixed-sentinel',
    };
    evidence.result = { ...value, checkpoints };
    return value;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (extra !== undefined) closeSync(extra);
    if (previousSecret === undefined) delete process.env.AGORA_FIXED_FAKE_SECRET;
    else process.env.AGORA_FIXED_FAKE_SECRET = previousSecret;
    evidence.completedAt = new Date().toISOString();
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const current = statSync(base);
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
    const mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
    const removable =
      current.uid === identity.uid &&
      current.dev === identity.dev &&
      current.ino === identity.ino &&
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

/** Fixed trusted registry seam for internal launch tests, not a Leader grant store. */
export function fixedAuthority(): LocalCommandAuthority {
  return {
    projectId: 'fixed-project',
    taskId: 'fixed-task',
    workspaceId: 'fixed-fixture',
    rootId: 'fixed-root',
    grantId: 'fixed-grant',
    workerId: 'fixed-worker',
    policyVersion: 'fixed-v1',
    grantRevision: 0,
    writerEpoch: 0,
    grantHash: sha('fixed-grant'),
    toolchainHash: sha('fixed-toolchain'),
    networkHash: sha('deny-network'),
  };
}
