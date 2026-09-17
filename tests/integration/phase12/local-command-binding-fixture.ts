// Real Seatbelt/process/file primitives. The fixed JSON authority reader is a
// trusted registry seam fixture; the product Leader registry is not implemented here.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type BindingFailure,
  LocalCommandBinding,
} from '../../../packages/runtime/sandbox/src/local-command-binding';
import { LocalCommandJournal } from '../../../packages/runtime/sandbox/src/local-command-journal';
import { buildLocalCommandPolicy } from '../../../packages/runtime/sandbox/src/local-command-policy';
import { runHeldLocalCommand } from '../../../packages/runtime/sandbox/src/local-command-start';
import { stopRegisteredLocalProcesses } from '../../../packages/runtime/sandbox/src/local-command-stop';
import { fixedAuthority } from './local-command-start-fixture';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const available = () => {
  const s = statfsSync('/private/tmp');
  return s.bavail * s.bsize;
};
type Scenario =
  | 'grant-revision'
  | 'worker'
  | 'writer-epoch'
  | 'authority-error'
  | 'root-before-release'
  | 'ancestor'
  | 'tool-before-admission'
  | 'sticky'
  | 'arguments'
  | 'completion'
  | 'control-drift'
  | 'binding-journal';
export async function probeLocalCommandBinding(scenario: Scenario) {
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const identity = statSync(base);
  const folder = resolve('test-outputs/reviews/task123-binding-evidence');
  mkdirSync(folder, { recursive: true });
  const evidencePath = join(folder, `${scenario}-${base.split('-').at(-1)}.json`);
  const sources = [
    'packages/runtime/sandbox/native/local-process-control.c',
    'packages/runtime/sandbox/native/local-command-bootstrap.c',
    'packages/runtime/sandbox/native/local-command-binding-probe.c',
    'packages/runtime/sandbox/src/local-command-binding.ts',
    'packages/runtime/sandbox/src/local-command-start.ts',
    'packages/runtime/sandbox/src/local-command-supervisor.ts',
    'packages/runtime/sandbox/src/local-command-journal.ts',
    'packages/runtime/sandbox/src/local-command-stop.ts',
    'tests/integration/phase12/local-command-binding-fixture.ts',
    'tests/integration/phase12/phase12-3-command-binding.test.ts',
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
  let pending: ReturnType<typeof runHeldLocalCommand> | undefined;
  let fixtureStop: Awaited<ReturnType<typeof stopRegisteredLocalProcesses>> | null = null;
  const cancel = new AbortController();
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
    evidence.binaries = Object.fromEntries(
      [helper, bootstrap, payload].map((p) => [p, sha(readFileSync(p))]),
    );
    const cleanupHelper = join(base, 'cleanup-control');
    if (scenario === 'control-drift') {
      copyFileSync(helper, cleanupHelper);
      const trapSource = 'packages/runtime/sandbox/native/local-command-control-drift-probe.c';
      execFileSync('/usr/bin/clang', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-mmacosx-version-min=15.0',
        trapSource,
        '-o',
        join(base, 'control-trap'),
      ]);
      evidence.trap = {
        source: trapSource,
        sourceHash: sha(readFileSync(trapSource)),
        binaryHash: sha(readFileSync(join(base, 'control-trap'))),
        cleanupHelperHash: sha(readFileSync(cleanupHelper)),
      };
    }
    const parent = join(base, 'project-parent');
    mkdirSync(parent, { mode: 0o700 });
    for (const name of ['source', 'input', 'output'])
      mkdirSync(join(parent, name), { mode: 0o700 });
    const control = join(base, 'journal');
    mkdirSync(control, { mode: 0o700 });
    const journal = new LocalCommandJournal(control, true);
    const authorityPath = join(control, 'authority.json');
    const initial = fixedAuthority();
    const persist = (value: unknown) =>
      writeFileSync(authorityPath, JSON.stringify(value), { mode: 0o600 });
    persist(initial);
    const outputRoot = join(parent, 'output');
    const policy = buildLocalCommandPolicy({
      executable: payload,
      bootstrap,
      sourceRoot: join(parent, 'source'),
      inputRoot: join(parent, 'input'),
      outputRoot,
      deniedRoots: [control],
    });
    evidence.policy = policy;
    const commandId = `fixture-${scenario}`;
    const invocation = {
      commandId,
      helper,
      bootstrap,
      executable: payload,
      argv: ['completion', 'binding-journal'].includes(scenario) ? ['exit'] : [],
      policy,
      outputRoot,
    };
    const binding = new LocalCommandBinding(
      invocation,
      [join(parent, 'source'), join(parent, 'input'), outputRoot, control],
      initial,
      (stage) => {
        if (stage === 'completion' && scenario === 'completion')
          persist({ ...initial, grantRevision: 1 });
        return JSON.parse(readFileSync(authorityPath, 'utf8'));
      },
    );
    evidence.binding = binding.snapshot();
    const reservation = journal.reserve({
      commandId,
      workspaceId: initial.workspaceId,
      policyHash: sha(policy),
      inputHash: sha('fixed-binding-input'),
      roots: [outputRoot],
    });
    const stickyChecks: (BindingFailure | null)[] = [];
    if (scenario === 'tool-before-admission') writeFileSync(payload, 'fixed-invalid-tool');
    if (scenario === 'sticky') {
      persist({ ...initial, grantRevision: 1 });
      stickyChecks.push(binding.check('admission'));
      persist(initial);
      stickyChecks.push(binding.check('admission'));
    }
    pending = runHeldLocalCommand({
      ...invocation,
      argv: scenario === 'arguments' ? ['changed'] : invocation.argv,
      journal,
      revision: reservation.revision,
      binding,
      signal: cancel.signal,
      authorize(stage) {
        if (stage === 'release' && scenario === 'root-before-release') {
          renameSync(join(parent, 'source'), join(parent, 'old-source'));
          mkdirSync(join(parent, 'source'), { mode: 0o700 });
        }
        return true;
      },
    });
    const running = [
      'grant-revision',
      'worker',
      'writer-epoch',
      'authority-error',
      'ancestor',
      'control-drift',
    ].includes(scenario);
    if (running) {
      const deadline = Date.now() + 3000;
      while (!existsSync(join(outputRoot, 'running')) && Date.now() < deadline) await delay(10);
      if (!existsSync(join(outputRoot, 'running'))) throw new Error('fixture_not_running');
      if (scenario === 'grant-revision') persist({ ...initial, grantRevision: 1 });
      if (scenario === 'worker') persist({ ...initial, workerId: 'different-worker' });
      if (scenario === 'writer-epoch') persist({ ...initial, writerEpoch: 1 });
      if (scenario === 'authority-error') writeFileSync(authorityPath, 'invalid-json');
      if (scenario === 'control-drift') renameSync(join(base, 'control-trap'), helper);
      if (scenario === 'ancestor') {
        renameSync(parent, join(base, 'moved-parent'));
        mkdirSync(parent, { mode: 0o700 });
        for (const name of ['source', 'input', 'output'])
          mkdirSync(join(parent, name), { mode: 0o700 });
        writeFileSync(join(outputRoot, 'sentinel'), 'replacement-untouched');
      }
    }
    const result = await pending;
    const record = journal.snapshot().records[0];
    if (!record) throw new Error('fixture_record_missing');
    if (scenario === 'control-drift') {
      // Test-only cleanup uses a separately preserved trusted helper after the
      // product controller returned needsAttention; production has no fallback.
      fixtureStop = await stopRegisteredLocalProcesses(cleanupHelper, record.birthIdentities);
      evidence.fixtureStop = fixtureStop;
    }
    const journalErrors: string[] = [];
    if (scenario === 'binding-journal') {
      const path = join(control, 'commands.json');
      const original = readFileSync(path);
      for (const change of ['old', 'chain']) {
        const wrapper = JSON.parse(original.toString());
        if (change === 'old') wrapper.data.version = 2;
        else
          wrapper.data.records[0].binding.roots[0].chain.unshift(
            wrapper.data.records[0].binding.roots[0].chain[0],
          );
        wrapper.sha256 = sha(JSON.stringify(wrapper.data));
        writeFileSync(path, JSON.stringify(wrapper));
        try {
          new LocalCommandJournal(control);
          journalErrors.push('unexpected-acceptance');
        } catch (error) {
          journalErrors.push(error instanceof Error ? error.message : String(error));
        }
        writeFileSync(path, original);
      }
    }
    const value = {
      result,
      record,
      marker: existsSync(join(outputRoot, 'running')),
      bindingFailure: binding.check('completion'),
      stickyChecks,
      trapExecuted: existsSync(`${helper}.executed`),
      fixtureStop,
      journalErrors,
      replacementUnchanged:
        scenario !== 'ancestor' ||
        readFileSync(join(outputRoot, 'sentinel'), 'utf8') === 'replacement-untouched',
    };
    evidence.result = value;
    return value;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    cancel.abort();
    if (pending) await pending.catch(() => undefined);
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
