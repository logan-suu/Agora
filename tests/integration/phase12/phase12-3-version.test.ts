// Real private object store and Seatbelt file inspection on fixed APFS fixtures.
// The authorization callback models a trusted revoke or an independent editor.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { acquireState } from '../../../apps/desktop/src/storage';
import { LocalControlObjects } from '../../../packages/runtime/sandbox/src/local-control-objects';
import { inspectLocalRoot } from '../../../packages/runtime/sandbox/src/local-file-transaction';
import { LocalFixedInputs } from '../../../packages/runtime/sandbox/src/local-fixed-inputs';
import { LocalRegistryFile } from '../../../packages/runtime/sandbox/src/local-registry-file';
import { parseLocalRegistry } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalVersionStore } from '../../../packages/runtime/sandbox/src/local-version-store';

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
for (const scenario of ['normal', 'changed', 'revoke'] as const)
  it(`captures immutable file inputs and refuses incomplete evidence: ${scenario}`, async () => {
    const base = mkdtempSync('/private/tmp/agora-task123-validation-'),
      identity = lstatSync(base);
    const root = join(base, 'project'),
      helper = join(base, 'files');
    mkdirSync(root);
    mkdirSync(join(root, '.agora-operations'), { mode: 0o700 });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/main.js'), 'export const value = 42;\n');
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 255, 128, 42]));
    writeFileSync(join(root, '.env'), 'fixed secret excluded');
    const owner = await acquireState(join(base, 'state'));
    const evidence: Record<string, unknown> = {
      base,
      scenario,
      identity: { dev: identity.dev, ino: identity.ino },
    };
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
      await LocalRegistryFile.open(owner, parseLocalRegistry, true);
      const objects = await LocalControlObjects.open(owner),
        versions = new LocalVersionStore(objects, helper);
      const binding = inspectLocalRoot(root);
      const scope = {
        projectId: 'project',
        taskId: 'task',
        rootId: 'root',
        policyHash: 'a'.repeat(64),
      };
      const capture = versions.capture(scope, binding, async (stage) => {
        if (stage === 'verification' && scenario === 'changed')
          writeFileSync(join(root, 'src/main.js'), 'independent user edit');
        return !(stage === 'completion' && scenario === 'revoke');
      });
      if (scenario !== 'normal')
        await expect(capture).rejects.toThrow(
          scenario === 'changed' ? 'file_version_conflict' : 'authorization_closed',
        );
      else {
        const version = await capture;
        const manifest = await versions.read(version, scope);
        expect(manifest.files.map((file) => file.path)).toEqual(['image.bin', 'src/main.js']);
        expect(manifest.excludedPaths).toEqual(['.agora-operations', '.env']);
        expect(manifest.directories.map((entry) => entry.path)).toEqual(['', 'src']);
        const incompleteHash = await objects.put({ ...manifest, files: [] });
        await expect(
          versions.read(
            {
              kind: 'files',
              manifestId: `manifest:${incompleteHash}`,
              manifestHash: incompleteHash,
            },
            scope,
          ),
        ).rejects.toThrow('invalid_workspace_version');
        expect(await objects.getBytes(manifest.files[0]?.contentHash as string)).toEqual(
          Buffer.from([0, 255, 128, 42]),
        );
        writeFileSync(join(root, 'image.bin'), Buffer.from([1, 2, 3]));
        expect(await objects.getBytes(manifest.files[0]?.contentHash as string)).toEqual(
          Buffer.from([0, 255, 128, 42]),
        );
        await expect(versions.verify(version, scope, binding, async () => true)).rejects.toThrow(
          'file_version_conflict',
        );
        await expect(versions.read(version, { ...scope, taskId: 'other' })).rejects.toThrow(
          'workspace_version_scope_mismatch',
        );
        const inputs = await LocalFixedInputs.open(owner, objects, versions);
        const fixed = await inputs.materialize(scope, version, 'command-input', async () => true);
        expect(readFileSync(join(fixed.path, 'image.bin'))).toEqual(Buffer.from([0, 255, 128, 42]));
        expect(readFileSync(join(root, 'image.bin'))).toEqual(Buffer.from([1, 2, 3]));
        expect(readdirSync(fixed.path)).toEqual(['image.bin', 'src']);
        expect(await inputs.materialize(scope, version, 'command-input', async () => true)).toEqual(
          fixed,
        );
        await expect(
          inputs.materialize(scope, version, 'denied-input', async () => false),
        ).rejects.toThrow('authorization_closed');
        chmodSync(join(fixed.path, 'image.bin'), 0o600);
        writeFileSync(join(fixed.path, 'image.bin'), 'corrupted private input');
        await expect(inputs.verify(fixed, scope, version, async () => true)).rejects.toThrow(
          'fixed_input_changed',
        );
        await expect(
          inputs.materialize(scope, version, 'command-input', async () => true),
        ).rejects.toThrow('fixed_input_changed');
        evidence.fixedInput = fixed;
        evidence.version = version;
        evidence.manifest = manifest;
      }
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('fixed secret excluded');
      evidence.passed = true;
    } catch (error) {
      failure = error;
      evidence.failure = error instanceof Error ? error.message : String(error);
    }
    await owner.release();
    const files: { path: string; sha256: string }[] = [];
    const captureFiles = (folder: string, prefix = '') => {
      for (const name of readdirSync(folder)) {
        const file = join(folder, name),
          info = lstatSync(file);
        if (info.isDirectory() && !info.isSymbolicLink()) captureFiles(file, join(prefix, name));
        else if (info.isFile())
          files.push({ path: join(prefix, name), sha256: digest(readFileSync(file)) });
        else throw Error('unexpected version fixture object');
      }
    };
    captureFiles(base);
    evidence.files = files;
    evidence.sources = Object.fromEntries(
      [
        'packages/runtime/sandbox/native/local-file-transaction.c',
        'packages/runtime/sandbox/src/local-file-transaction.ts',
        'packages/runtime/sandbox/src/local-version-store.ts',
        'packages/runtime/sandbox/src/local-fixed-inputs.ts',
        'packages/runtime/sandbox/src/local-control-objects.ts',
        'tests/integration/phase12/phase12-3-version.test.ts',
      ].map((path) => [path, digest(readFileSync(path))]),
    );
    const folder = resolve('test-outputs/reviews/task123-version-evidence');
    mkdirSync(folder, { recursive: true });
    const target = join(folder, `${scenario}-${basename(base)}.json`);
    writeFileSync(target, JSON.stringify(evidence, null, 2));
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' }),
      mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' }),
      current = lstatSync(base),
      before = statfsSync(base);
    if (
      handles.status !== 1 ||
      handles.stdout ||
      handles.stderr ||
      mounts.status !== 0 ||
      mounts.stdout.includes(base) ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.isSymbolicLink()
    )
      throw Error('version_fixture_cleanup_unproven');
    rmSync(base, { recursive: true });
    const after = statfsSync('/private/tmp');
    evidence.cleanup = {
      deleted: true,
      ownerReleased: true,
      noHandles: true,
      noMounts: true,
      availableBytesDelta: after.bavail * after.bsize - before.bavail * before.bsize,
    };
    writeFileSync(target, JSON.stringify(evidence, null, 2));
    if (failure) throw failure;
  });
