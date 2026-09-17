// Trusted filesystem fixture. Journal records never authorize payload execution.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
import {
  type CommandJournalRecord,
  LocalCommandJournal,
} from '../../../packages/runtime/sandbox/src/local-command-journal';

type Scenario = 'interrupted' | 'quarantine' | 'replay' | 'corrupt' | 'root-replaced';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const available = () => {
  const stat = statfsSync('/private/tmp');
  return stat.bavail * stat.bsize;
};

export function probeCommandJournal(scenario: Scenario) {
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const identity = statSync(base);
  const control = join(base, 'control');
  const output = join(base, 'output');
  mkdirSync(control, { mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  const folder = resolve('test-outputs/reviews/task123-stop-evidence');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `journal-${scenario}-${base.split('-').at(-1)}.json`);
  const sources = [
    'packages/runtime/sandbox/src/local-command-journal.ts',
    'tests/integration/phase12/local-command-journal-fixture.ts',
    'tests/integration/phase12/phase12-3-command-journal.test.ts',
  ];
  const evidence: Record<string, unknown> = {
    base,
    scenario,
    startedAt: new Date().toISOString(),
    identity: { uid: identity.uid, dev: identity.dev, ino: identity.ino },
    sources: Object.fromEntries(sources.map((source) => [source, sha(readFileSync(source))])),
    availableBefore: available(),
  };
  const errors: string[] = [];
  const reject = (action: () => unknown) => {
    try {
      action();
      errors.push('unexpected-acceptance');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  };
  let record: CommandJournalRecord | undefined;
  let recovered: ReturnType<LocalCommandJournal['snapshot']> | undefined;
  try {
    const journal = new LocalCommandJournal(control, true);
    const request = {
      commandId: 'cmd-1',
      workspaceId: 'workspace-1',
      policyHash: sha('policy'),
      inputHash: sha('input'),
      roots: [output],
    };
    record = journal.reserve(request);
    if (scenario === 'interrupted') {
      const reopened = new LocalCommandJournal(control);
      recovered = reopened.snapshot();
      reject(() => reopened.reserve({ ...request, commandId: 'cmd-2' }));
      const moved = join(base, 'moved-output');
      renameSync(output, moved);
      reject(() => reopened.reserve({ ...request, commandId: 'cmd-2', roots: [moved] }));
    } else if (scenario === 'quarantine') {
      record = journal.quarantine('cmd-1', 0, 'discovery_incomplete');
      recovered = new LocalCommandJournal(control).snapshot();
      reject(() => journal.quarantine('cmd-1', 1, 'control_failure'));
    } else if (scenario === 'replay') {
      const replay = journal.reserve(request);
      if (JSON.stringify(record) !== JSON.stringify(replay)) throw new Error('replay_changed');
      reject(() => journal.reserve({ ...request, inputHash: sha('changed') }));
      reject(() => journal.quarantine('cmd-1', 1, 'control_failure'));
      record = journal.snapshot().records[0];
    } else if (scenario === 'corrupt') {
      const original = readFileSync(join(control, 'commands.json'));
      writeFileSync(join(control, 'commands.json'), '{}');
      reject(() => new LocalCommandJournal(control));
      writeFileSync(join(control, 'commands.json'), original);
      writeFileSync(join(control, 'commands.lock'), 'interrupted', { mode: 0o600 });
      reject(() => new LocalCommandJournal(control));
    } else {
      renameSync(control, join(base, 'old-control'));
      mkdirSync(control, { mode: 0o700 });
      reject(() => journal.snapshot());
    }
    const result = { errors, record, recovered };
    evidence.result = result;
    return result;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    evidence.completedAt = new Date().toISOString();
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    const now = statSync(base);
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
    const mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
    const removable =
      now.uid === identity.uid &&
      now.dev === identity.dev &&
      now.ino === identity.ino &&
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
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
