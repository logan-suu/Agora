// Real trusted native helper and owned APFS roots. These records prove fixed
// candidate identity and exited native effects, not permission to undo any file.
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  applyLocalReplacement,
  inspectLocalFileBytes,
} from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { readNativeInstalledFile } from '../../../packages/runtime/sandbox/src/local-native-file-effect';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { localFileVersion } from '../../../packages/runtime/sandbox/src/local-version-store';
import { fileEffectsFixture } from './local-file-effects-fixture';

it.each(['normal', 'replacement-after-swap', 'revoke-completion'])(
  'retains the actual installed object identity through %s without guessing from the later path',
  async (scenario) =>
    fileEffectsFixture(async (f) => {
      const target = join(f.root, 'file');
      writeFileSync(target, 'B');
      const expected = inspectLocalFileBytes(f.binding, 'file', f.helper);
      const receipt = await applyLocalReplacement({
        ...f,
        actionId: 'installed',
        path: 'file',
        expected,
        content: Buffer.from('A'),
        authorize: async (checkpoint) => {
          if (scenario === 'replacement-after-swap' && checkpoint === 'after_swap') {
            renameSync(target, join(f.root, 'displaced-A'));
            writeFileSync(target, 'A');
          }
          return !(scenario === 'revoke-completion' && checkpoint === 'completion');
        },
      });
      const candidate = JSON.parse(
        readFileSync(join(receipt.journalPath, 'candidate-proof.json'), 'utf8'),
      );
      const outcome = JSON.parse(
        readFileSync(join(receipt.journalPath, 'native-outcome.json'), 'utf8'),
      );
      const actual = inspectLocalFileBytes(f.binding, 'file', f.helper);
      expect(candidate).toMatchObject({
        schemaVersion: 'local-file-candidate-proof-v1',
        inputHash: receipt.inputHash,
        path: 'file',
        size: 1,
      });
      expect(outcome).toMatchObject({
        schemaVersion: 'local-file-native-outcome-v1',
        inputHash: receipt.inputHash,
        closed: true,
      });
      expect(receipt.exchanged).toBe(true);
      if (scenario === 'replacement-after-swap') {
        expect(candidate.identity).not.toBe(actual.identity);
        expect(candidate.identity).toBe(
          inspectLocalFileBytes(f.binding, 'displaced-A', f.helper).identity,
        );
        expect(outcome.result.stage).toBe('recoveryRequired');
        expect(receipt.stage).toBe('recoveryRequired');
      } else {
        expect(candidate.identity).toBe(actual.identity);
        expect(candidate.metadata).toBe(actual.metadata);
        expect(outcome.result.stage).toBe('applied');
        expect(receipt.stage).toBe(scenario === 'normal' ? 'applied' : 'recoveryRequired');
      }
      const proven = await readNativeInstalledFile({
        native: receipt,
        journalRoot: f.journalRoot,
        bindingHash: localRecordHash(f.binding),
        path: 'file',
        expected: localFileVersion(expected),
        baselineMetadata: expected.metadata,
        baseline: expected.content,
        candidate: Buffer.from('A'),
        assertPrivateRoot: async () => {
          const root = await import('node:fs/promises');
          const st = await root.lstat(f.journalRoot);
          if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.())
            throw Error('changed');
        },
      });
      expect(proven.effect).toBe(true);
      if (scenario === 'replacement-after-swap') expect(proven.installedVersion).toBeNull();
      else
        expect(proven.installedVersion).toMatchObject({
          kind: 'regular',
          identity: candidate.identity,
          sha256: candidate.contentHash,
        });
      f.evidence.installed = { scenario, receipt, candidate, outcome, proven };
    }),
  30_000,
);

it.each(['candidate-tamper', 'missing-outcome', 'wrong-binding'])(
  'refuses %s instead of constructing an inverse from corrupted or incomplete evidence',
  async (scenario) =>
    fileEffectsFixture(async (f) => {
      writeFileSync(join(f.root, 'file'), 'B');
      const expected = inspectLocalFileBytes(f.binding, 'file', f.helper);
      const native = await applyLocalReplacement({
        ...f,
        actionId: 'proof-failure',
        path: 'file',
        expected,
        content: Buffer.from('A'),
        authorize: async () => true,
      });
      if (scenario === 'candidate-tamper') {
        const file = join(native.journalPath, 'candidate-proof.json');
        const proof = JSON.parse(readFileSync(file, 'utf8'));
        unlinkSync(file);
        writeFileSync(file, JSON.stringify({ ...proof, identity: '1:999999' }));
        chmodSync(file, 0o400);
      }
      if (scenario === 'missing-outcome')
        unlinkSync(join(native.journalPath, 'native-outcome.json'));
      await expect(
        readNativeInstalledFile({
          native,
          journalRoot: f.journalRoot,
          bindingHash: scenario === 'wrong-binding' ? 'f'.repeat(64) : localRecordHash(f.binding),
          path: 'file',
          expected: localFileVersion(expected),
          baselineMetadata: expected.metadata,
          baseline: expected.content,
          candidate: Buffer.from('A'),
          assertPrivateRoot: async () => {
            const io = await import('node:fs/promises');
            const st = await io.lstat(f.journalRoot);
            if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.())
              throw Error('changed');
          },
        }),
      ).rejects.toThrow('native_file_effect_unverified');
      expect(readFileSync(join(f.root, 'file'), 'utf8')).toBe('A');
    }),
  30_000,
);
