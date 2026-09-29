// Real APFS/Seatbelt fixture; the controller models external edits in owned roots.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectLocalRoot } from '../../../packages/runtime/sandbox/src/local-file-transaction';

export async function fileEffectsFixture(
  run: (input: {
    root: string;
    base: string;
    journalRoot: string;
    helper: string;
    binding: ReturnType<typeof inspectLocalRoot>;
    evidence: Record<string, unknown>;
  }) => Promise<void>,
) {
  const base = mkdtempSync('/private/tmp/agora-task124-file-effects-');
  const identity = lstatSync(base);
  const root = join(base, 'root'),
    journalRoot = join(base, 'journal'),
    helper = join(base, 'helper');
  const output = resolve('test-outputs/task124/file-effects');
  mkdirSync(output, { recursive: true });
  mkdirSync(root);
  mkdirSync(journalRoot, { mode: 0o700 });
  mkdirSync(join(root, '.agora-operations'), { mode: 0o700 });
  const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const evidence: Record<string, unknown> = {
    base,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    identity: { uid: identity.uid, dev: identity.dev, ino: identity.ino },
    sourceHashes: Object.fromEntries(
      [
        'packages/runtime/sandbox/native/local-file-transaction.c',
        'packages/runtime/sandbox/src/local-file-transaction.ts',
        'tests/integration/phase12/local-file-effects-fixture.ts',
        'tests/integration/phase12/phase12-4-file-effects.test.ts',
        'tests/integration/phase12/phase12-4-directory-effects.test.ts',
        'packages/core/domain/src/local-tree-comparison.ts',
        'packages/runtime/sandbox/src/local-tree-plan.ts',
        'tests/integration/phase12/phase12-4-tree-plan.test.ts',
        'packages/runtime/sandbox/src/local-delivery-comparison-record.ts',
        'tests/integration/phase12/phase12-4-delivery-comparison.test.ts',
        'packages/runtime/sandbox/src/local-delivery-repairs.ts',
        'tests/integration/phase12/phase12-4-delivery-repair-workspace.test.ts',
        'packages/runtime/sandbox/src/local-delivery-current.ts',
        'tests/integration/phase12/phase12-4-delivery-current.test.ts',
        'apps/web/src/server/local-direct-delivery-sources.ts',
        'tests/integration/phase12/phase12-4-delivery-sources.test.ts',
      ].map((p) => [p, hash(p)]),
    ),
  };
  const snapshots = join(output, 'sources');
  mkdirSync(snapshots, { recursive: true });
  for (const [path, digest] of Object.entries(evidence.sourceHashes as Record<string, string>)) {
    writeFileSync(join(snapshots, `${digest}.txt`), readFileSync(path));
  }
  let failure: unknown;
  try {
    execFileSync('/usr/bin/clang', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-mmacosx-version-min=15.0',
      resolve('packages/runtime/sandbox/native/local-file-transaction.c'),
      '-o',
      helper,
    ]);
    evidence.helperHash = hash(helper);
    await run({ root, base, journalRoot, helper, binding: inspectLocalRoot(root), evidence });
    evidence.passed = true;
  } catch (error) {
    failure = error;
    evidence.passed = false;
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  const path = join(output, `${base.split('/').at(-1)}.json`);
  evidence.journals = readdirSync(journalRoot).map((action) => ({
    action,
    files: readdirSync(join(journalRoot, action)).map((name) => {
      const content = readFileSync(join(journalRoot, action, name));
      return {
        name,
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.length,
        ...(name.endsWith('.json') ? { record: JSON.parse(content.toString('utf8')) } : {}),
      };
    }),
  }));
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
  const mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
  const current = lstatSync(base);
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.uid !== identity.uid ||
    handles.status !== 1 ||
    handles.stdout ||
    handles.stderr ||
    mounts.status !== 0 ||
    mounts.stderr ||
    mounts.stdout.includes(base)
  )
    throw Error('file_effects_cleanup_unproven');
  const before = statfsSync(base);
  rmSync(base, { recursive: true });
  const after = statfsSync('/private/tmp');
  evidence.cleanup = {
    removed: true,
    noHandles: true,
    noMounts: true,
    availableBytesDelta: after.bavail * after.bsize - before.bavail * before.bsize,
  };
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  if (failure) throw failure;
}
