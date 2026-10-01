// Real native effects and checkpoint races; no mocked filesystem or executor.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as transactions from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { fileEffectsFixture } from './local-file-effects-fixture';

it.each([
  'normal',
  'edit-before',
  'symlink-before',
  'new-after',
  'new-completion',
  'backup-edit',
  'backup-completion',
  'revoke-before',
  'revoke-after',
  'move-before',
  'move-after',
  'replay',
  'missing-receipt',
  'replay-forged',
  'missing-verification',
  'backup-collision',
  'revoke-completion',
])(
  'quarantines a fixed file with durable deletion evidence: %s',
  async (scenario) =>
    fileEffectsFixture(async (f) => {
      const target = join(f.root, 'file'),
        backup = join(f.root, '.agora-operations', 'delete-candidate');
      const original = Buffer.from([0xff, 0, 0x20, 0x0a]);
      writeFileSync(target, original);
      const inode = lstatSync(target).ino;
      const sentinel = join(f.base, 'outside');
      writeFileSync(sentinel, 'external');
      if (scenario === 'backup-collision') writeFileSync(backup, 'previous preserved object');
      const request = {
        ...f,
        actionId: 'delete',
        path: 'file',
        expected: transactions.inspectLocalFileBytes(f.binding, 'file', f.helper),
        authorize: async (checkpoint: string) => {
          if (checkpoint === 'before_swap') {
            if (scenario === 'edit-before') writeFileSync(target, 'user');
            if (scenario === 'symlink-before') {
              unlinkSync(target);
              symlinkSync(sentinel, target);
            }
            if (scenario === 'revoke-before') return false;
            if (scenario === 'move-before') renameSync(f.root, join(f.base, 'moved'));
          }
          if (checkpoint === 'after_swap') {
            if (scenario === 'new-after') writeFileSync(target, 'user');
            if (scenario === 'backup-edit') writeFileSync(backup, 'external edit of moved inode');
            if (scenario === 'revoke-after') return false;
            if (scenario === 'move-after') renameSync(f.root, join(f.base, 'moved'));
          }
          if (checkpoint === 'completion') {
            if (scenario === 'revoke-completion') return false;
            if (scenario === 'new-completion') writeFileSync(target, 'user');
            if (scenario === 'backup-completion')
              writeFileSync(backup, 'external edit of moved inode');
          }
          return true;
        },
      };
      const receipt = await transactions.applyLocalDeletion(request);
      f.evidence.receipt = receipt;
      expect(receipt.schemaVersion).toBe('local-deletion-primitive-v1');
      expect(receipt.quiescent).toBe(true);
      expect(receipt).not.toHaveProperty('exchanged');
      expect(receipt).not.toHaveProperty('created');
      const moved = existsSync(join(f.base, 'moved'));
      const actualRoot = moved ? join(f.base, 'moved') : f.root;
      const actualTarget = join(actualRoot, 'file'),
        actualBackup = join(actualRoot, '.agora-operations', 'delete-candidate');
      const removed = [
        'normal',
        'new-after',
        'new-completion',
        'backup-edit',
        'backup-completion',
        'revoke-after',
        'move-after',
        'replay',
        'missing-receipt',
        'replay-forged',
        'missing-verification',
        'revoke-completion',
      ].includes(scenario);
      expect(receipt.removed).toBe(removed);
      expect(receipt.stage).toBe(
        ['normal', 'replay', 'missing-receipt', 'replay-forged', 'missing-verification'].includes(
          scenario,
        )
          ? 'applied'
          : ['edit-before', 'symlink-before'].includes(scenario)
            ? 'conflict'
            : 'recoveryRequired',
      );
      if (removed) {
        expect(lstatSync(actualBackup).ino).toBe(inode);
        expect(readFileSync(actualBackup)).toEqual(
          ['backup-edit', 'backup-completion'].includes(scenario)
            ? Buffer.from('external edit of moved inode')
            : original,
        );
        expect(existsSync(actualTarget)).toBe(['new-after', 'new-completion'].includes(scenario));
      } else if (scenario === 'symlink-before')
        expect(lstatSync(actualTarget).isSymbolicLink()).toBe(true);
      else
        expect(readFileSync(actualTarget)).toEqual(
          scenario === 'edit-before' ? Buffer.from('user') : original,
        );
      if (scenario === 'new-after') expect(readFileSync(target, 'utf8')).toBe('user');
      if (scenario === 'replay-forged') {
        const { removed: _removed, ...forged } = receipt;
        unlinkSync(join(receipt.journalPath, 'result.json'));
        writeFileSync(
          join(receipt.journalPath, 'result.json'),
          JSON.stringify({ ...forged, created: true }),
        );
        await expect(transactions.applyLocalDeletion(request)).rejects.toThrow('recovery_required');
      }
      if (scenario === 'backup-collision')
        expect(readFileSync(backup, 'utf8')).toBe('previous preserved object');
      if (
        scenario === 'replay' ||
        scenario === 'missing-receipt' ||
        scenario === 'missing-verification'
      ) {
        writeFileSync(target, 'later user file');
        if (scenario !== 'replay') {
          unlinkSync(
            join(
              receipt.journalPath,
              scenario === 'missing-verification' ? 'verification.json' : 'result.json',
            ),
          );
          await expect(transactions.applyLocalDeletion(request)).rejects.toThrow(
            'recovery_required',
          );
        } else expect(await transactions.applyLocalDeletion(request)).toEqual(receipt);
        expect(readFileSync(target, 'utf8')).toBe('later user file');
        expect(lstatSync(backup).ino).toBe(inode);
      }
      expect(readFileSync(sentinel, 'utf8')).toBe('external');
    }),
  30_000,
);

it.each([true, false])(
  'prepares executable=%s before replacing source bytes',
  async (executable) =>
    fileEffectsFixture(async (f) => {
      const target = join(f.root, 'script');
      writeFileSync(target, 'old');
      chmodSync(target, executable ? 0o640 : 0o751);
      execFileSync('/usr/bin/xattr', ['-w', 'com.agora.fixture', 'retained', target]);
      const expected = transactions.inspectLocalFileBytes(f.binding, 'script', f.helper);
      const request = {
        ...f,
        actionId: 'mode',
        path: 'script',
        expected,
        content: Buffer.from('new\n'),
        executable,
        authorize: async () => true,
      };
      const receipt = await transactions.applyLocalReplacement(request);
      f.evidence.receipt = receipt;
      expect(receipt.stage).toBe('applied');
      expect(lstatSync(target).mode & 0o777).toBe(executable ? 0o751 : 0o640);
      expect(readFileSync(target, 'utf8')).toBe('new\n');
      const old = join(f.root, '.agora-operations', 'mode-candidate');
      expect(lstatSync(old).mode & 0o777).toBe(executable ? 0o640 : 0o751);
      expect(readFileSync(old, 'utf8')).toBe('old');
      for (const path of [target, old])
        expect(
          execFileSync('/usr/bin/xattr', ['-p', 'com.agora.fixture', path], {
            encoding: 'utf8',
          }).trim(),
        ).toBe('retained');
      await expect(
        transactions.applyLocalReplacement({ ...request, executable: !executable }),
      ).rejects.toThrow('operation_conflict');
    }),
  30_000,
);

it(
  'creates an executable file from a fixed absent basis',
  async () =>
    fileEffectsFixture(async (f) => {
      const receipt = await transactions.applyLocalCreation({
        ...f,
        actionId: 'create',
        path: 'script',
        executable: true,
        expected: transactions.inspectLocalCreationBasis(f.binding, 'script', f.helper),
        content: 'fixed\n',
        authorize: async () => true,
      });
      f.evidence.receipt = receipt;
      expect(receipt.stage).toBe('applied');
      expect(lstatSync(join(f.root, 'script')).mode & 0o777).toBe(0o755);
    }),
  30_000,
);
