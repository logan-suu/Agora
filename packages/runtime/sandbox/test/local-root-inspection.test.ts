// Real read-only native inspection in approved disposable directories; no mocks.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { inspectSelectedLocalRoot } from '../src/local-root-inspection';

it('inspects APFS identity without creating a staging directory or granting access', () => {
  const base = mkdtempSync('/private/tmp/agora-task123-validation-'),
    identity = lstatSync(base);
  const directory = join(base, 'project'),
    helper = join(base, 'inspect-root');
  mkdirSync(directory);
  writeFileSync(join(directory, 'sentinel'), 'fixed source');
  writeFileSync(join(base, 'external-secret'), 'fixed external secret');
  const source = resolve('packages/runtime/sandbox/native/local-root-inspection.c');
  const folder = resolve('test-outputs/reviews/task123-root-evidence');
  mkdirSync(folder, { recursive: true });
  const evidence: Record<string, unknown> = {
    base,
    identity: { dev: identity.dev, ino: identity.ino },
    startedAt: new Date().toISOString(),
    sourceHash: createHash('sha256').update(readFileSync(source)).digest('hex'),
  };
  let error: unknown;
  try {
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
    const result = inspectSelectedLocalRoot(realpathSync(directory), helper);
    evidence.result = result;
    expect(result.filesystem).toBe('apfs');
    expect(result.volumeId).toMatch(/^[a-f0-9]{32}$/);
    expect(result.chain.at(-1)?.identity).toBe(
      `${lstatSync(directory).dev}:${lstatSync(directory).ino}`,
    );
    const probe = join(base, 'inspection-probe');
    execFileSync('/usr/bin/clang', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-mmacosx-version-min=15.0',
      resolve('packages/runtime/sandbox/native/local-root-inspection-probe.c'),
      '-o',
      probe,
    ]);
    evidence.probeHash = createHash('sha256').update(readFileSync(probe)).digest('hex');
    expect(inspectSelectedLocalRoot(realpathSync(directory), probe)).toEqual(result);
    expect(readFileSync(join(base, 'external-secret'), 'utf8')).toBe('fixed external secret');
    expect(readdirSync(directory)).toEqual(['sentinel']);
    expect(readFileSync(join(directory, 'sentinel'), 'utf8')).toBe('fixed source');
    symlinkSync(directory, join(base, 'alias'));
    expect(() => inspectSelectedLocalRoot(join(base, 'alias'), helper)).toThrow(
      'unsupported_workspace',
    );
    expect(() => inspectSelectedLocalRoot('/', helper)).toThrow('unsupported_workspace');
    evidence.passed = true;
  } catch (e) {
    error = e;
    evidence.error = e instanceof Error ? { message: e.message, cause: e.cause } : String(e);
  }
  evidence.sources = Object.fromEntries(
    [
      'packages/runtime/sandbox/native/local-root-inspection.c',
      'packages/runtime/sandbox/native/local-root-inspection-probe.c',
      'packages/runtime/sandbox/src/local-root-inspection.ts',
      'packages/runtime/sandbox/test/local-root-inspection.test.ts',
    ].map((path, index) => {
      const data = readFileSync(path);
      const snapshot = join(folder, `${basename(base)}-source-${index}.txt`);
      writeFileSync(snapshot, data);
      return [path, { sha256: createHash('sha256').update(data).digest('hex'), snapshot }];
    }),
  );
  const output = join(folder, `${basename(base)}.json`);
  writeFileSync(output, JSON.stringify(evidence, null, 2));
  const current = lstatSync(base),
    handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' }),
    mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    handles.status !== 1 ||
    handles.stdout ||
    handles.stderr ||
    mounts.status !== 0 ||
    mounts.stdout.includes(base)
  )
    throw new Error('root_fixture_cleanup_unproven');
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
  if (error) throw error;
}, 20000);
