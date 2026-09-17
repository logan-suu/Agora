// Trusted test controller. The native file operation always runs under Seatbelt.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

type Scenario = 'stationary' | 'move-parent' | 'move-root';
function hash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function probeLocalFileBoundary(
  scenario: Scenario,
  operation: 'exchange' | 'write-open-file' = 'exchange',
) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This feasibility gate requires an Apple Silicon Mac; no fallback.');
  const base = mkdtempSync('/private/tmp/agora-task123-validation-');
  const ownership = statSync(base);
  const availableBefore = statfsSync(base).bavail * statfsSync(base).bsize;
  const root = join(base, 'project');
  const moved = join(base, 'outside');
  mkdirSync(join(root, 'moving'), { recursive: true });
  mkdirSync(join(root, '.agora-operations'));
  writeFileSync(join(root, 'moving/target'), 'original');
  writeFileSync(join(root, '.agora-operations/candidate'), 'candidate');
  const source = resolve('packages/runtime/sandbox/native/local-boundary-probe.c');
  const executable = join(base, 'boundary-probe');
  const evidenceDirectory = resolve('docs/reviews/task123-boundary-evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  const evidencePath = join(evidenceDirectory, `${scenario}-${base.split('-').at(-1)}.json`);
  const evidence: Record<string, unknown> = {
    scenario,
    operation,
    base,
    sourceHash: hash(source),
    source,
    os: execFileSync('/usr/bin/sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim(),
    arch: process.arch,
    controllerNode: process.version,
    fixtureHash: hash(resolve('tests/integration/phase12/local-boundary-fixture.ts')),
    assertionsHash: hash(resolve('tests/integration/phase12/phase12-3.test.ts')),
    compiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }).trim(),
    dyldSupportHash: hash('/System/Library/Sandbox/Profiles/dyld-support.sb'),
    ownership: { uid: ownership.uid, dev: ownership.dev, ino: ownership.ino },
    availableBefore,
  };
  let quiescent = true;
  try {
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
    evidence.binaryHash = hash(executable);
    const literal = (value: string) => JSON.stringify(value);
    const policy = [
      '(version 1)',
      '(deny default)',
      `(allow process-exec (literal ${literal(executable)}))`,
      '(allow sysctl-read)',
      // dyld's libignition opens / and resolves the OS Cryptex shared cache.
      // Source: this OS build's /System/Library/Sandbox/Profiles/dyld-support.sb.
      '(allow file-read* (literal "/"))',
      '(allow file-read* (subpath "/usr/lib") (subpath "/System/Library"))',
      '(allow file-read* file-map-executable (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS"))',
      `(allow file-map-executable (literal ${literal(executable)}) (subpath "/usr/lib") (subpath "/System/Library"))`,
      `(allow file-read* (literal ${literal(executable)}) (subpath ${literal(root)}))`,
      `(allow file-write* (subpath ${literal(root)}))`,
    ].join('\n');
    evidence.policy = policy;
    const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, executable, root, operation], {
      cwd: base,
      env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: base, TMPDIR: base },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    quiescent = false;
    evidence.pid = child.pid;
    let stdout = '';
    let stderr = '';
    let ready = false;
    let controllerError: unknown;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const outcome = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolveOutcome, reject) => {
        child.on('error', reject);
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (ready || !stdout.includes('\n')) return;
          try {
            const first = JSON.parse(stdout.split('\n')[0] ?? '');
            if (first.ready !== true || first.filesystem !== 'apfs')
              throw new Error('Unexpected barrier response');
            ready = true;
            if (scenario === 'move-parent') renameSync(join(root, 'moving'), moved);
            if (scenario === 'move-root') renameSync(root, moved);
            child.stdin.end('x');
          } catch (error) {
            controllerError = error;
            child.kill('SIGKILL');
          }
        });
        child.once('close', (exitCode, signal) => {
          clearTimeout(timer);
          quiescent = true;
          resolveOutcome({ exitCode, signal });
        });
      },
    );
    const actualRoot = scenario === 'move-root' && ready ? moved : root;
    const actualParent = scenario === 'move-parent' && ready ? moved : join(actualRoot, 'moving');
    const result = {
      ...outcome,
      ready,
      filesystem: ready ? 'apfs' : null,
      stdout,
      stderr,
      target: readFileSync(join(actualParent, 'target'), 'utf8'),
      backup: readFileSync(join(actualRoot, '.agora-operations/candidate'), 'utf8'),
    };
    evidence.result = result;
    if (controllerError) throw controllerError;
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
