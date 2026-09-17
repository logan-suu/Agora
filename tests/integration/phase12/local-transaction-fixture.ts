// Trusted fault controller; mutations model an independent editor, not a mocked port.
// All source changes run in the approved disposable task123 validation directory.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyLocalReplacement,
  inspectLocalDirectory,
  inspectLocalFileBytes,
  inspectLocalReplacementBasis,
  inspectLocalRoot,
  type LocalReplacementReceipt,
} from '../../../packages/runtime/sandbox/src/local-file-transaction';

type Scenario =
  | 'directory-list'
  | 'binary'
  | 'binary-replay'
  | 'binary-input-mutation'
  | 'normal'
  | 'move-root-before-write'
  | 'move-parent-before-swap'
  | 'replace-root'
  | 'move-root-after-swap'
  | 'edit-before-swap'
  | 'symlink-target'
  | 'hardlink-target'
  | 'replay'
  | 'move-root-completion'
  | 'move-parent-completion'
  | 'metadata-before-swap'
  | 'revoke-before-write'
  | 'revoke-before-swap'
  | 'replay-different-input'
  | 'replay-corrupt-receipt'
  | 'replay-missing-receipt';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function exerciseLocalTransaction(scenario: Scenario) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This native transaction gate requires Apple Silicon macOS.');
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const ownership = lstatSync(base);
  const availableBefore = statfsSync(base).bavail * statfsSync(base).bsize;
  const root = join(base, 'project');
  const journalRoot = join(base, 'state');
  const external = join(base, 'external');
  const sentinel = join(external, 'sentinel');
  const moved = join(base, 'moved-project');
  const movedParent = join(base, 'moved-parent');
  const source = resolve('packages/runtime/sandbox/native/local-file-transaction.c');
  const helper = join(base, 'local-file-transaction');
  const evidenceDirectory = resolve('test-outputs/reviews/task123-transaction-evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  const evidencePath = join(evidenceDirectory, `${scenario}-${base.split('-').at(-1)}.json`);
  const evidence: Record<string, unknown> = {
    scenario,
    base,
    availableBefore,
    ownership: { uid: ownership.uid, dev: ownership.dev, ino: ownership.ino },
    os: execFileSync('/usr/bin/sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim(),
    arch: process.arch,
    controllerNode: process.version,
    compiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(
      [
        source,
        resolve('packages/runtime/sandbox/src/local-file-transaction.ts'),
        resolve('tests/integration/phase12/local-transaction-fixture.ts'),
        resolve('tests/integration/phase12/phase12-3-transaction.test.ts'),
      ].map((file) => [file, hash(file)]),
    ),
  };
  let quiescent = true;
  try {
    mkdirSync(join(root, 'moving'), { recursive: true });
    mkdirSync(join(root, '.agora-operations'), { mode: 0o700 });
    mkdirSync(journalRoot, { mode: 0o700 });
    mkdirSync(external);
    writeFileSync(sentinel, 'external-secret');
    const target = join(root, 'moving/target');
    const binary = scenario.startsWith('binary');
    writeFileSync(target, binary ? Buffer.from([0, 255, 128, 10, 0, 42]) : 'original');
    chmodSync(target, 0o755);
    execFileSync('/usr/bin/xattr', [
      '-w',
      'com.agora.transaction-test',
      'fixture-metadata',
      target,
    ]);
    const binding = inspectLocalRoot(root);
    execFileSync('/usr/bin/clang', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-mmacosx-version-min=15.0',
      source,
      '-o',
      helper,
    ]);
    evidence.binaryHash = hash(helper);
    let directoryEntries: unknown;
    let directoryLinkError: string | undefined;
    if (scenario === 'directory-list') {
      writeFileSync(join(root, '.env'), 'fixed project secret');
      symlinkSync(external, join(root, 'external-link'));
      directoryEntries = inspectLocalDirectory(binding, '', helper);
      try {
        inspectLocalDirectory(binding, 'external-link', helper);
      } catch (error) {
        directoryLinkError = error instanceof Error ? error.message : String(error);
      }
    }
    const expected = binary
      ? inspectLocalFileBytes(binding, 'moving/target', helper)
      : inspectLocalReplacementBasis(binding, 'moving/target', helper);
    if (scenario === 'symlink-target' || scenario === 'hardlink-target') {
      unlinkSync(target);
      if (scenario === 'symlink-target') symlinkSync(sentinel, target);
      else linkSync(sentinel, target);
    }
    const checkpoints: string[] = [];
    const request = {
      actionId: 'replace-one',
      binding,
      path: 'moving/target',
      expected,
      content: binary ? Buffer.from([255, 0, 129, 42, 10]) : 'replacement',
      journalRoot,
      helper,
      authorize: async (checkpoint: string) => {
        checkpoints.push(checkpoint);
        if (scenario === 'binary-input-mutation' && checkpoint === 'admission') {
          if (Buffer.isBuffer(request.content)) request.content.fill(7);
          if (Buffer.isBuffer(expected.content)) expected.content.fill(8);
        }
        if (
          checkpoint === 'before_prepare' &&
          (scenario === 'move-root-before-write' || scenario === 'replace-root')
        ) {
          renameSync(root, moved);
          if (scenario === 'replace-root') {
            mkdirSync(join(root, 'moving'), { recursive: true });
            symlinkSync(sentinel, join(root, 'moving/target'));
          }
        }
        if (checkpoint === 'before_swap' && scenario === 'move-parent-before-swap')
          renameSync(join(root, 'moving'), movedParent);
        if (checkpoint === 'before_swap' && scenario === 'edit-before-swap')
          writeFileSync(target, 'user-edit');
        if (checkpoint === 'after_swap' && scenario === 'move-root-after-swap')
          renameSync(root, moved);
        if (checkpoint === 'completion' && scenario === 'move-root-completion')
          renameSync(root, moved);
        if (checkpoint === 'completion' && scenario === 'move-parent-completion')
          renameSync(join(root, 'moving'), movedParent);
        if (checkpoint === 'before_swap' && scenario === 'metadata-before-swap')
          execFileSync('/usr/bin/xattr', [
            '-w',
            'com.agora.transaction-test',
            'user-metadata',
            target,
          ]);
        if (
          (checkpoint === 'before_prepare' && scenario === 'revoke-before-write') ||
          (checkpoint === 'before_swap' && scenario === 'revoke-before-swap')
        )
          return false;
        return true;
      },
    };
    quiescent = false;
    const receipt = await applyLocalReplacement(request);
    quiescent = receipt.quiescent;
    let replayedReceipt: LocalReplacementReceipt | undefined;
    if (scenario === 'replay' || scenario === 'binary-replay')
      replayedReceipt = await applyLocalReplacement(request);
    let replayError: string | undefined;
    if (scenario.startsWith('replay-')) {
      if (scenario === 'replay-corrupt-receipt') {
        const file = join(receipt.journalPath, 'result.json');
        chmodSync(file, 0o600);
        writeFileSync(file, JSON.stringify({ ...receipt, exchanged: false }));
      }
      if (scenario === 'replay-missing-receipt')
        unlinkSync(join(receipt.journalPath, 'result.json'));
      try {
        await applyLocalReplacement({
          ...request,
          content: scenario === 'replay-different-input' ? 'other' : request.content,
        });
      } catch (error) {
        replayError = error instanceof Error ? error.message : String(error);
      }
    }
    const actualRoot = existsSync(moved) ? moved : root;
    const actualParent = existsSync(movedParent) ? movedParent : join(actualRoot, 'moving');
    const candidate = join(actualRoot, '.agora-operations', receipt.candidateName);
    const journal = join(journalRoot, 'replace-one');
    const journals = Object.fromEntries(
      readdirSync(journal).map((name) => [name, readFileSync(join(journal, name), 'utf8')]),
    );
    const result = {
      receipt,
      replayedReceipt,
      replayError,
      directoryEntries,
      directoryLinkError,
      metadataPreserved:
        scenario === 'normal'
          ? inspectLocalReplacementBasis(binding, 'moving/target', helper).metadata ===
            expected.metadata
          : undefined,
      target: readFileSync(join(actualParent, 'target'), 'utf8'),
      ...(binary
        ? {
            targetHex: readFileSync(join(actualParent, 'target')).toString('hex'),
            preservedHex: readFileSync(candidate).toString('hex'),
            baselineHex: readFileSync(join(journal, 'expected')).toString('hex'),
            candidateHex: readFileSync(join(journal, 'replacement')).toString('hex'),
          }
        : {}),
      preserved: existsSync(candidate) ? readFileSync(candidate, 'utf8') : null,
      sentinel: readFileSync(sentinel, 'utf8'),
      journalStages: [JSON.parse(journals['prepared.json'] ?? '{}').stage, receipt.stage],
    };
    evidence.checkpoints = checkpoints;
    evidence.journals = journals;
    evidence.result = result;
    return result;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    evidence.quiescent = quiescent;
    evidence.completedAt = new Date().toISOString();
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const current = statSync(base);
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
    const mounts = execFileSync('/sbin/mount', { encoding: 'utf8' });
    if (
      !quiescent ||
      current.uid !== ownership.uid ||
      current.dev !== ownership.dev ||
      current.ino !== ownership.ino ||
      realpathSync(base) !== base ||
      handles.status !== 1 ||
      handles.stdout.trim() ||
      handles.stderr.trim() ||
      mounts.includes(base)
    ) {
      evidence.cleanup = { removed: false, reason: 'Ownership, handles or quiescence not proven' };
    } else {
      rmSync(base, { recursive: true });
      const fs = statfsSync('/private/tmp');
      evidence.cleanup = {
        removed: !existsSync(base),
        availableAfter: fs.bavail * fs.bsize,
        spaceDelta: fs.bavail * fs.bsize - availableBefore,
      };
    }
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
