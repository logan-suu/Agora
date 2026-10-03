// The actual trusted native file transaction restores only the approved mode;
// no process/model doubles, grants or current-validation claims are used here.
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  applyLocalReplacement,
  inspectLocalFileBytes,
  inspectLocalRoot,
} from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { readNativeInstalledFile } from '../../../packages/runtime/sandbox/src/local-native-file-effect';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { localFileVersion } from '../../../packages/runtime/sandbox/src/local-version-store';
import { fileEffectsFixture } from './local-file-effects-fixture';

it('uses the fixed inverse mode with native expected identity and sealed candidate proof', async () => {
  await fileEffectsFixture(async (f) => {
    const helper = f.helper;
    const binding = inspectLocalRoot(f.root),
      path = 'file.txt';
    writeFileSync(join(f.root, path), 'agent bytes\n');
    chmodSync(join(f.root, path), 0o775);
    const expected = inspectLocalFileBytes(binding, path, helper);
    const content = Buffer.from('restored original bytes\n');
    const native = await applyLocalReplacement({
      actionId: 'inverse-mode',
      binding,
      path,
      expected,
      content,
      mode: 0o664,
      helper,
      journalRoot: f.journalRoot,
      authorize: async () => true,
    });
    expect(native.stage).toBe('applied');
    expect(statSync(join(f.root, path)).mode & 0o777).toBe(0o664);
    const proof = await readNativeInstalledFile({
      native,
      journalRoot: f.journalRoot,
      bindingHash: localRecordHash(binding),
      path,
      expected: localFileVersion(expected),
      baselineMetadata: expected.metadata,
      baseline: expected.content,
      candidate: content,
      mode: 0o664,
      assertPrivateRoot: async () => {},
    });
    expect(proof).toMatchObject({
      effect: true,
      installedVersion: { kind: 'regular', executable: false },
    });
    expect(proof.installedMetadata).toBe(inspectLocalFileBytes(binding, path, helper).metadata);
    await expect(
      readNativeInstalledFile({
        native,
        journalRoot: f.journalRoot,
        bindingHash: localRecordHash(binding),
        path,
        expected: localFileVersion(expected),
        baselineMetadata: expected.metadata,
        baseline: expected.content,
        candidate: content,
        mode: 0o644,
        assertPrivateRoot: async () => {},
      }),
    ).rejects.toThrow('native_file_effect_unverified');
  });
}, 60000);
