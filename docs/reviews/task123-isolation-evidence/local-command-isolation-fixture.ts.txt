// Trusted fixture controller. The fixed native payload always runs under Seatbelt.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { buildLocalCommandPolicy } from '../../../packages/runtime/sandbox/src/local-command-policy';

type Event = { actor: string; operation: string; ok: boolean; errno: number };
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const available = () => {
  const stat = statfsSync('/private/tmp');
  return stat.bavail * stat.bsize;
};

export async function probeCommandIsolation(mode: 'native' | 'node' = 'native') {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Apple Silicon Seatbelt validation required; no fallback.');
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const identity = statSync(base);
  const source = resolve('packages/runtime/sandbox/native/local-command-isolation-probe.c');
  let executable = join(base, 'isolation-probe');
  const directory = resolve('docs/reviews/task123-isolation-evidence');
  mkdirSync(directory, { recursive: true });
  const evidencePath = join(directory, `isolation-${base.split('-').at(-1)}.json`);
  const evidence: Record<string, unknown> = {
    base,
    mode,
    startedAt: new Date().toISOString(),
    sourceHash: digest(source),
    policySourceHash: digest(resolve('packages/runtime/sandbox/src/local-command-policy.ts')),
    controllerHash: digest(resolve('tests/integration/phase12/local-command-isolation-fixture.ts')),
    assertionsHash: digest(
      resolve('tests/integration/phase12/phase12-3-command-isolation.test.ts'),
    ),
    os: execFileSync('/usr/bin/sw_vers', [], { encoding: 'utf8' }),
    arch: process.arch,
    compiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }),
    node: process.version,
    identity: { uid: identity.uid, dev: identity.dev, ino: identity.ino },
    availableBefore: available(),
  };
  let reapedFixedTree = false;
  try {
    for (const name of ['source', 'input', 'output', 'neighbor', 'secrets', 'control'])
      mkdirSync(join(base, name), { mode: 0o700 });
    for (const [name, bytes] of [
      ['source/file', 'source-sentinel'],
      ['source/.env', 'fake-env-sentinel'],
      ['input/file', 'fixed-input'],
      ['neighbor/file', 'neighbor-sentinel'],
      ['secrets/file', 'fake-secret-sentinel'],
      ['control/file', 'control-sentinel'],
    ]) {
      if (name && bytes) writeFileSync(join(base, name), bytes);
    }
    execFileSync('/usr/bin/clang', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-mmacosx-version-min=15.0',
      source,
      '-o',
      executable,
    ]);
    if (mode === 'node') {
      const toolsRoot = '/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64';
      executable = realpathSync(join(toolsRoot, 'node/bin/node'));
      const manifestPath = join(toolsRoot, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (
        manifest.versions.node !== '24.20.0' ||
        manifest.files.find((file: { path: string }) => file.path === 'node/bin/node')?.sha256 !==
          digest(executable)
      )
        throw new Error('toolchain_identity_mismatch');
      evidence.manifestHash = digest(manifestPath);
    }
    evidence.binaryHash = digest(executable);
    const scope = {
      executable,
      sourceRoot: join(base, 'source'),
      inputRoot: join(base, 'input'),
      outputRoot: join(base, 'output'),
      deniedRoots: ['neighbor', 'secrets', 'control'].map((name) => join(base, name)),
    };
    const admissionErrors: string[] = [];
    const reject = (candidate: typeof scope) => {
      try {
        buildLocalCommandPolicy(candidate);
        admissionErrors.push('unexpected-acceptance');
      } catch (error) {
        admissionErrors.push(error instanceof Error ? error.message : String(error));
      }
    };
    reject({ ...scope, outputRoot: scope.sourceRoot });
    const nested = join(scope.sourceRoot, '..output');
    mkdirSync(nested);
    reject({ ...scope, outputRoot: nested });
    const alias = join(base, 'output-alias');
    symlinkSync(scope.outputRoot, alias);
    reject({ ...scope, outputRoot: alias });
    writeFileSync(join(scope.outputRoot, 'existing'), 'not-fresh');
    reject(scope);
    rmSync(join(scope.outputRoot, 'existing'));
    const policy = buildLocalCommandPolicy(scope);
    evidence.policy = policy;
    const nodePayload = `
const fs = require('node:fs');
const path = require('node:path');
const base = process.argv[1], actor = process.argv[2];
const report = (operation, fn) => {
  try { fn(); console.log(JSON.stringify({actor,operation,ok:true,errno:0})); }
  catch (error) { console.log(JSON.stringify({actor,operation,ok:false,errno:Math.abs(error.errno || 1)})); }
};
report('read-input', () => fs.readFileSync(path.join(base,'input/file')));
report('write-output', () => fs.writeFileSync(path.join(base,'output',actor),'changed'));
report('write-source', () => fs.writeFileSync(path.join(base,'source/file'),'changed',{flag:'r+'}));
report('read-secret', () => fs.readFileSync(path.join(base,'secrets/file')));
if (actor === 'child') {
  const result = require('node:child_process').spawnSync(process.execPath,
    ['-e',process.argv[3],base,'grandchild'],{encoding:'utf8',timeout:3000});
  process.stdout.write(result.stdout || '');
  if (result.error || result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(96); }
}
`;
    const args =
      mode === 'native' ? ['child', base] : ['-e', nodePayload, base, 'child', nodePayload];
    if (mode === 'node') evidence.payload = nodePayload;
    const child = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, executable, ...args], {
      cwd: base,
      env: {
        NODE_ENV: 'test',
        PATH: '/usr/bin:/bin',
        HOME: join(base, 'output'),
        TMPDIR: join(base, 'output'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    evidence.process = {
      pid: child.pid,
      exitCode: child.status,
      signal: child.signal,
      error: child.error?.message,
      stdout: child.stdout,
      stderr: child.stderr,
    };
    reapedFixedTree = child.status === 0;
    const read = (name: string) =>
      existsSync(join(base, name)) ? readFileSync(join(base, name), 'utf8') : null;
    const result = {
      exitCode: child.status,
      events: child.stdout.trim()
        ? (child.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)) as Event[])
        : [],
      admissionErrors,
      source: read('source/file'),
      input: read('input/file'),
      neighbor: read('neighbor/file'),
      secret: read('secrets/file'),
      control: read('control/file'),
      outputFiles: readdirSync(join(base, 'output')).sort(),
    };
    evidence.result = result;
    return result;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    evidence.completedAt = new Date().toISOString();
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const current = statSync(base);
    const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', base], { encoding: 'utf8' });
    const mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8' });
    const removable =
      reapedFixedTree &&
      current.uid === identity.uid &&
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      realpathSync(base) === base &&
      handles.status === 1 &&
      !handles.stdout &&
      !handles.stderr &&
      mounts.status === 0 &&
      !mounts.stdout.includes(base);
    evidence.cleanup = {
      removed: false,
      reapedFixedTree,
      handles: { status: handles.status, stdout: handles.stdout, stderr: handles.stderr },
      mountCheckPassed: mounts.status === 0 && !mounts.stdout.includes(base),
    };
    if (removable) {
      rmSync(base, { recursive: true });
      evidence.cleanup = { ...(evidence.cleanup as object), removed: !existsSync(base) };
    }
    evidence.availableAfter = available();
    evidence.spaceDelta =
      (evidence.availableAfter as number) - (evidence.availableBefore as number);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
