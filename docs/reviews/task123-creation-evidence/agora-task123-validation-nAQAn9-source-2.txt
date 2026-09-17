// Real APFS no-replace installation through the Seatbelt-confined trusted helper.
// Checkpoint callbacks perform fixed external-editor faults in owned test roots.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  applyLocalCreation,
  inspectLocalCreationBasis,
  inspectLocalRoot,
} from '../../../packages/runtime/sandbox/src/local-file-transaction';

const scenarios = [
  'normal',
  'race',
  'symlink-race',
  'existing',
  'symlink-existing',
  'revoke',
  'move-before',
  'move-after',
  'replay',
  'replay-corrupt',
  'replay-missing',
] as const;
for (const scenario of scenarios)
  it(`creates a file with a durable no-replace result: ${scenario}`, async () => {
    const base = mkdtempSync('/private/tmp/agora-task123-validation-'),
      identity = lstatSync(base);
    const root = join(base, 'project'),
      moved = join(base, 'moved-project'),
      journalRoot = join(base, 'journal'),
      helper = join(base, 'transaction');
    const folder = resolve('docs/reviews/task123-creation-evidence');
    mkdirSync(folder, { recursive: true });
    mkdirSync(root);
    mkdirSync(join(root, '.agora-operations'), { mode: 0o700 });
    mkdirSync(journalRoot, { mode: 0o700 });
    const sentinel = join(base, 'external');
    writeFileSync(sentinel, 'fixed external secret');
    const evidence: Record<string, unknown> = {
      scenario,
      base,
      identity: { dev: identity.dev, ino: identity.ino },
      startedAt: new Date().toISOString(),
    };
    let failure: unknown;
    try {
      const source = resolve('packages/runtime/sandbox/native/local-file-transaction.c');
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
      evidence.binaryHash = createHash('sha256').update(readFileSync(helper)).digest('hex');
      const binding = inspectLocalRoot(root);
      if (scenario === 'existing' || scenario === 'symlink-existing') {
        if (scenario === 'existing') writeFileSync(join(root, 'new.js'), 'user file');
        else symlinkSync(sentinel, join(root, 'new.js'));
        expect(() => inspectLocalCreationBasis(binding, 'new.js', helper)).toThrow(
          'native_read_failed',
        );
        unlinkSync(join(root, 'new.js'));
      }
      const expected = inspectLocalCreationBasis(binding, 'new.js', helper);
      expect(expected.parentIdentity).toBe(`${lstatSync(root).dev}:${lstatSync(root).ino}`);
      const request = {
        actionId: 'create-fixed',
        binding,
        path: 'new.js',
        expected,
        content: 'fixed candidate',
        journalRoot,
        helper,
        authorize: async (checkpoint: string) => {
          if (checkpoint === 'before_swap' && scenario === 'race')
            writeFileSync(join(root, 'new.js'), 'user file');
          if (checkpoint === 'before_swap' && scenario === 'symlink-race')
            symlinkSync(sentinel, join(root, 'new.js'));
          if (checkpoint === 'before_swap' && scenario === 'revoke') return false;
          if (checkpoint === 'before_swap' && scenario === 'move-before') renameSync(root, moved);
          if (checkpoint === 'after_swap' && scenario === 'move-after') renameSync(root, moved);
          return true;
        },
      };
      const receipt = await applyLocalCreation(request);
      evidence.receipt = receipt;
      expect(receipt.schemaVersion).toBe('local-creation-primitive-v1');
      expect(receipt.quiescent).toBe(true);
      expect(receipt).not.toHaveProperty('exchanged');
      const actual = existsSync(moved) ? moved : root,
        target = join(actual, 'new.js');
      if (
        [
          'normal',
          'replay',
          'replay-corrupt',
          'replay-missing',
          'existing',
          'symlink-existing',
        ].includes(scenario)
      ) {
        expect(receipt.stage).toBe('applied');
        expect(receipt.created).toBe(true);
        expect(readFileSync(target, 'utf8')).toBe('fixed candidate');
      } else if (scenario === 'symlink-race') {
        expect(receipt.stage).toBe('conflict');
        expect(receipt.created).toBe(false);
        expect(lstatSync(target).isSymbolicLink()).toBe(true);
      } else if (scenario === 'race') {
        expect(receipt.stage).toBe('conflict');
        expect(receipt.created).toBe(false);
        expect(readFileSync(target, 'utf8')).toBe('user file');
      } else if (scenario === 'move-after') {
        expect(receipt.stage).toBe('recoveryRequired');
        expect(receipt.created).toBe(true);
        expect(readFileSync(target, 'utf8')).toBe('fixed candidate');
      } else {
        expect(receipt.stage).toBe('recoveryRequired');
        expect(receipt.created).toBe(false);
        expect(existsSync(target)).toBe(false);
      }
      if (scenario === 'replay') {
        const first = lstatSync(target).ino;
        expect(await applyLocalCreation(request)).toEqual(receipt);
        expect(lstatSync(target).ino).toBe(first);
        await expect(applyLocalCreation({ ...request, content: 'different' })).rejects.toThrow(
          'operation_conflict',
        );
      }
      if (scenario === 'replay-corrupt' || scenario === 'replay-missing') {
        const resultPath = join(receipt.journalPath, 'result.json');
        evidence.originalResult = readFileSync(resultPath, 'utf8');
        unlinkSync(resultPath);
        if (scenario === 'replay-corrupt')
          writeFileSync(resultPath, JSON.stringify({ ...receipt, created: false }));
        await expect(applyLocalCreation(request)).rejects.toThrow('recovery_required');
        expect(readFileSync(target, 'utf8')).toBe('fixed candidate');
      }
      evidence.journal = Object.fromEntries(
        readdirSync(receipt.journalPath).map((name) => [
          name,
          readFileSync(join(receipt.journalPath, name), 'utf8'),
        ]),
      );
      expect(readFileSync(sentinel, 'utf8')).toBe('fixed external secret');
      evidence.passed = true;
    } catch (error) {
      failure = error;
      evidence.error = error instanceof Error ? error.message : String(error);
    }
    evidence.sources = Object.fromEntries(
      [
        'packages/runtime/sandbox/native/local-file-transaction.c',
        'packages/runtime/sandbox/src/local-file-transaction.ts',
        'tests/integration/phase12/phase12-3-creation.test.ts',
      ].map((path, i) => {
        const content = readFileSync(path),
          snapshot = join(folder, `${basename(base)}-source-${i}.txt`);
        writeFileSync(snapshot, content);
        return [path, { sha256: createHash('sha256').update(content).digest('hex'), snapshot }];
      }),
    );
    const output = join(folder, `${scenario}-${basename(base)}.json`);
    writeFileSync(output, JSON.stringify(evidence, null, 2));
    const info = lstatSync(base),
      handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' }),
      mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
    if (
      info.dev !== identity.dev ||
      info.ino !== identity.ino ||
      handles.status !== 1 ||
      handles.stdout ||
      handles.stderr ||
      mounts.status !== 0 ||
      mounts.stdout.includes(base)
    )
      throw new Error('creation_fixture_cleanup_unproven');
    const before = statfsSync(base);
    rmSync(base, { recursive: true });
    const after = statfsSync('/private/tmp');
    evidence.cleanup = {
      deleted: true,
      noOpenHandles: true,
      noMounts: true,
      availableBytesDelta: after.bavail * after.bsize - before.bavail * before.bsize,
    };
    writeFileSync(output, JSON.stringify(evidence, null, 2));
    if (failure) throw failure;
  }, 30000);
