// Real APFS/Seatbelt directory transactions and external edits; no mocked I/O.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as transactions from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { fileEffectsFixture } from './local-file-effects-fixture';

it.each(['file', 'excluded', 'directory', 'symlink'])(
  'refuses to inspect a nonempty directory: %s',
  async (kind) =>
    fileEffectsFixture(async (f) => {
      const target = join(f.root, 'folder');
      mkdirSync(target);
      if (kind === 'directory') mkdirSync(join(target, 'child'));
      else if (kind === 'symlink') symlinkSync(f.base, join(target, 'link'));
      else writeFileSync(join(target, kind === 'excluded' ? '.env' : 'file'), 'preserved');
      expect(() =>
        transactions.inspectLocalEmptyDirectoryBasis(f.binding, 'folder', f.helper),
      ).toThrow('native_directory_read_failed');
      expect(readdirSync(target)).toHaveLength(1);
    }),
  30_000,
);

it.each([
  'normal',
  'occupied-before',
  'nonempty-after',
  'nonempty-completion',
  'replaced-completion',
  'revoke-before',
  'revoke-after',
  'move-before',
  'move-after',
  'replay',
  'missing-verification',
  'backup-collision',
])(
  'creates only a fixed absent empty directory: %s',
  async (scenario) =>
    fileEffectsFixture(async (f) => {
      mkdirSync(join(f.root, 'parent'));
      const target = join(f.root, 'parent', 'folder');
      if (scenario === 'backup-collision')
        mkdirSync(join(f.root, '.agora-operations', 'mkdir-candidate'));
      const request = {
        ...f,
        actionId: 'mkdir',
        path: 'parent/folder',
        expected: transactions.inspectLocalCreationBasis(f.binding, 'parent/folder', f.helper),
        authorize: async (checkpoint: string) => {
          if (checkpoint === 'before_swap') {
            if (scenario === 'occupied-before') writeFileSync(target, 'user');
            if (scenario === 'revoke-before') return false;
            if (scenario === 'move-before')
              renameSync(join(f.root, 'parent'), join(f.root, 'moved'));
          }
          if (checkpoint === 'after_swap') {
            if (scenario === 'nonempty-after') writeFileSync(join(target, 'user'), 'retained');
            if (scenario === 'revoke-after') return false;
            if (scenario === 'move-after')
              renameSync(join(f.root, 'parent'), join(f.root, 'moved'));
          }
          if (checkpoint === 'completion') {
            if (scenario === 'nonempty-completion') writeFileSync(join(target, '.env'), 'retained');
            if (scenario === 'replaced-completion') {
              renameSync(target, join(f.root, 'original'));
              mkdirSync(target);
            }
          }
          return true;
        },
      };
      const receipt = await transactions.applyLocalDirectoryCreation(request);
      f.evidence.receipt = receipt;
      const changed = ![
        'occupied-before',
        'revoke-before',
        'move-before',
        'backup-collision',
      ].includes(scenario);
      expect(receipt.schemaVersion).toBe('local-directory-creation-primitive-v1');
      expect(receipt.quiescent).toBe(true);
      expect(receipt.created).toBe(changed);
      expect(receipt.stage).toBe(
        ['normal', 'replay', 'missing-verification'].includes(scenario)
          ? 'applied'
          : scenario === 'occupied-before'
            ? 'conflict'
            : 'recoveryRequired',
      );
      if (receipt.stage === 'applied') {
        expect(readdirSync(target)).toEqual([]);
        expect(lstatSync(target).mode & 0o777).toBe(0o755);
        expect(receipt.directory?.identity).toBe(
          `${lstatSync(target).dev}:${lstatSync(target).ino}`,
        );
      }
      if (scenario === 'occupied-before') expect(readFileSync(target, 'utf8')).toBe('user');
      if (scenario.startsWith('nonempty'))
        expect(
          readFileSync(join(target, scenario === 'nonempty-after' ? 'user' : '.env'), 'utf8'),
        ).toBe('retained');
      if (scenario === 'replaced-completion') {
        expect(receipt.directory?.identity).not.toBe(
          `${lstatSync(target).dev}:${lstatSync(target).ino}`,
        );
        expect(existsSync(join(f.root, 'original'))).toBe(true);
      }
      if (scenario === 'replay' || scenario === 'missing-verification') {
        rmdirSync(target);
        writeFileSync(target, 'later user file');
        if (scenario === 'missing-verification') {
          unlinkSync(join(receipt.journalPath, 'verification.json'));
          await expect(transactions.applyLocalDirectoryCreation(request)).rejects.toThrow(
            'recovery_required',
          );
        } else expect(await transactions.applyLocalDirectoryCreation(request)).toEqual(receipt);
        expect(readFileSync(target, 'utf8')).toBe('later user file');
      }
    }),
  30_000,
);

it.each([
  'normal',
  'nonempty-before',
  'metadata-before',
  'symlink-before',
  'nonempty-after',
  'nonempty-completion',
  'metadata-completion',
  'new-completion',
  'revoke-before',
  'revoke-after',
  'move-before',
  'move-after',
  'replay',
  'missing-receipt',
  'forged-receipt',
  'backup-collision',
])(
  'quarantines only a fixed empty directory: %s',
  async (scenario) =>
    fileEffectsFixture(async (f) => {
      const target = join(f.root, 'folder');
      const backup = join(f.root, '.agora-operations', 'rmdir-candidate');
      mkdirSync(target, { mode: 0o750 });
      execFileSync('/usr/bin/xattr', ['-w', 'com.agora.fixture', 'retained', target]);
      const original = lstatSync(target);
      const outside = join(f.base, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'sentinel'), 'untouched');
      if (scenario === 'backup-collision') mkdirSync(backup);
      const request = {
        ...f,
        actionId: 'rmdir',
        path: 'folder',
        expected: transactions.inspectLocalEmptyDirectoryBasis(f.binding, 'folder', f.helper),
        authorize: async (checkpoint: string) => {
          if (checkpoint === 'before_swap') {
            if (scenario === 'nonempty-before') writeFileSync(join(target, '.env'), 'user');
            if (scenario === 'metadata-before') chmodSync(target, 0o700);
            if (scenario === 'symlink-before') {
              renameSync(target, join(f.root, 'saved'));
              symlinkSync(outside, target);
            }
            if (scenario === 'revoke-before') return false;
            if (scenario === 'move-before') renameSync(f.root, join(f.base, 'moved'));
          }
          if (checkpoint === 'after_swap') {
            if (scenario === 'nonempty-after') writeFileSync(join(backup, 'user'), 'retained');
            if (scenario === 'revoke-after') return false;
            if (scenario === 'move-after') renameSync(f.root, join(f.base, 'moved'));
          }
          if (checkpoint === 'completion') {
            if (scenario === 'nonempty-completion') writeFileSync(join(backup, '.env'), 'retained');
            if (scenario === 'metadata-completion')
              execFileSync('/usr/bin/xattr', ['-w', 'com.agora.fixture', 'changed', backup]);
            if (scenario === 'new-completion') mkdirSync(target);
          }
          return true;
        },
      };
      const receipt = await transactions.applyLocalDirectoryDeletion(request);
      f.evidence.receipt = receipt;
      const changed = ![
        'nonempty-before',
        'metadata-before',
        'symlink-before',
        'revoke-before',
        'move-before',
        'backup-collision',
      ].includes(scenario);
      expect(receipt.schemaVersion).toBe('local-directory-deletion-primitive-v1');
      expect(receipt.quiescent).toBe(true);
      expect(receipt.removed).toBe(changed);
      expect(receipt.stage).toBe(
        ['normal', 'replay', 'missing-receipt', 'forged-receipt'].includes(scenario)
          ? 'applied'
          : ['nonempty-before', 'metadata-before', 'symlink-before'].includes(scenario)
            ? 'conflict'
            : 'recoveryRequired',
      );
      if (changed) {
        const actualBackup =
          scenario === 'move-after'
            ? join(f.base, 'moved', '.agora-operations', 'rmdir-candidate')
            : backup;
        expect(lstatSync(actualBackup).ino).toBe(original.ino);
        expect(lstatSync(actualBackup).mode).toBe(original.mode);
        expect(
          execFileSync('/usr/bin/xattr', ['-p', 'com.agora.fixture', actualBackup], {
            encoding: 'utf8',
          }),
        ).toBe(scenario === 'metadata-completion' ? 'changed\n' : 'retained\n');
        if (scenario.startsWith('nonempty'))
          expect(
            readFileSync(
              join(actualBackup, scenario === 'nonempty-after' ? 'user' : '.env'),
              'utf8',
            ),
          ).toBe('retained');
      }
      if (
        scenario === 'replay' ||
        scenario === 'missing-receipt' ||
        scenario === 'forged-receipt'
      ) {
        mkdirSync(target);
        writeFileSync(join(target, 'user'), 'later');
        if (scenario !== 'replay') {
          unlinkSync(join(receipt.journalPath, 'result.json'));
          if (scenario === 'forged-receipt')
            writeFileSync(
              join(receipt.journalPath, 'result.json'),
              JSON.stringify({ ...receipt, directory: { ...receipt.directory, identity: '1:2' } }),
            );
          await expect(transactions.applyLocalDirectoryDeletion(request)).rejects.toThrow(
            'recovery_required',
          );
        } else expect(await transactions.applyLocalDirectoryDeletion(request)).toEqual(receipt);
        expect(readFileSync(join(target, 'user'), 'utf8')).toBe('later');
      }
      expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
    }),
  30_000,
);
