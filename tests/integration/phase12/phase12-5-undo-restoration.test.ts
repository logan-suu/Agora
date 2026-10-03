// Actual APFS pinned-root native operations. Unconditional authorize callbacks
// isolate the primitive contract; Leader/grant/proposal admission is separate G5.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as native from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { fileEffectsFixture } from './local-file-effects-fixture';

it.each(['file', 'directory', 'occupied', 'changed-preserved'] as const)(
  'restores only the proven original isolated object: %s',
  async (scenario) => {
    await fileEffectsFixture(async (f) => {
      const path = 'original',
        target = join(f.root, path);
      if (scenario === 'directory') mkdirSync(target, { mode: 0o750 });
      else writeFileSync(target, 'original bytes\n');
      chmodSync(target, 0o750);
      execFileSync('/usr/bin/xattr', ['-w', 'com.agora.fixture', 'retained', target]);
      const basis =
        scenario === 'directory'
          ? native.inspectLocalEmptyDirectoryBasis(f.binding, path, f.helper)
          : native.inspectLocalFileBytes(f.binding, path, f.helper);
      const removed =
        scenario === 'directory'
          ? await native.applyLocalDirectoryDeletion({
              ...f,
              path,
              actionId: 'original-delete',
              expected: basis,
              authorize: async () => true,
            })
          : await native.applyLocalDeletion({
              ...f,
              path,
              actionId: 'original-delete',
              expected: basis as native.ReplacementBytesBasis,
              authorize: async () => true,
            });
      expect(removed).toMatchObject({ stage: 'applied', removed: true });
      const preserved =
        scenario === 'directory'
          ? native.inspectLocalPreservedDirectory(f.binding, removed.candidateName, f.helper)
          : native.inspectLocalPreservedFile(f.binding, removed.candidateName, f.helper);
      expect(preserved.identity).toBe(basis.identity);
      expect(preserved.metadata).toBe(basis.metadata);
      const expected = native.inspectLocalCreationBasis(f.binding, path, f.helper);
      if (scenario === 'occupied') writeFileSync(target, 'later same-name user file\n');
      if (scenario === 'changed-preserved')
        writeFileSync(
          join(f.root, '.agora-operations', removed.candidateName),
          'later old-fd edit\n',
        );
      const restoreFrom = {
        candidateName: removed.candidateName,
        identity: basis.identity,
        metadata: basis.metadata,
      };
      const result =
        scenario === 'directory'
          ? await native.applyLocalDirectoryRestoration({
              ...f,
              path,
              actionId: 'inverse-delete',
              expected,
              restoreFrom,
              authorize: async () => true,
            })
          : await native.applyLocalRestoration({
              ...f,
              path,
              actionId: 'inverse-delete',
              expected,
              restoreFrom,
              content: (basis as native.ReplacementBytesBasis).content,
              authorize: async () => true,
            });
      f.evidence.inverse = { scenario, removed, result };
      if (scenario === 'occupied' || scenario === 'changed-preserved') {
        expect(result).toMatchObject({ stage: 'conflict', created: false });
        if (scenario === 'occupied')
          expect(readFileSync(target, 'utf8')).toBe('later same-name user file\n');
        else expect(existsSync(target)).toBe(false);
        expect(existsSync(join(f.root, '.agora-operations', removed.candidateName))).toBe(true);
      } else {
        expect(result).toMatchObject({ stage: 'applied', created: true });
        expect(`${statSync(target).dev}:${statSync(target).ino}`).toBe(basis.identity);
        expect(statSync(target).mode & 0o777).toBe(0o750);
        expect(
          execFileSync('/usr/bin/xattr', ['-p', 'com.agora.fixture', target], {
            encoding: 'utf8',
          }).trim(),
        ).toBe('retained');
        if (scenario === 'file') expect(readFileSync(target, 'utf8')).toBe('original bytes\n');
        expect(existsSync(join(f.root, '.agora-operations', removed.candidateName))).toBe(false);
      }
    });
  },
  30000,
);

it('reads metadata for a complete current directory without claiming it is empty', async () => {
  await fileEffectsFixture(async (f) => {
    mkdirSync(join(f.root, 'current'), { mode: 0o750 });
    writeFileSync(join(f.root, 'current/user'), 'retain');
    const basis = native.inspectLocalDirectoryMetadata(f.binding, 'current', f.helper);
    expect(basis.identity).toBe(
      `${statSync(join(f.root, 'current')).dev}:${statSync(join(f.root, 'current')).ino}`,
    );
    expect(Number(basis.metadata.split(':')[0]) & 0o777).toBe(0o750);
    expect(() => native.inspectLocalEmptyDirectoryBasis(f.binding, 'current', f.helper)).toThrow(
      'native_directory_read_failed',
    );
    const root = native.inspectLocalDirectoryMetadata(f.binding, '', f.helper);
    expect(root.identity).toBe(f.binding.chain.at(-1)?.identity);
    expect(readFileSync(join(f.root, 'current/user'), 'utf8')).toBe('retain');
  });
}, 30000);
