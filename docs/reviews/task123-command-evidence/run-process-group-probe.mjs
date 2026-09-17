// Trusted controller for a fixed, read-only native feasibility probe.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync('/private/tmp/agora-task123-validation-');
const identity = statSync(base);
const available = () => { const s = statfsSync('/private/tmp'); return s.bavail * s.bsize; };
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const executable = join(base, 'process-group-probe');
const run = (file, args) => {
  const result = spawnSync(file, args, {
    cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: base, TMPDIR: base },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
};
const record = {
  startedAt: new Date().toISOString(), base, identity: { uid: identity.uid, dev: identity.dev, ino: identity.ino },
  availableBefore: available(), sourceHash: hash(join(directory, 'process-group-probe.c.txt')),
  controllerHash: hash(fileURLToPath(import.meta.url)),
  os: run('/usr/bin/sw_vers', ['-buildVersion']), compiler: run('/usr/bin/clang', ['--version']),
  cases: [],
};
const evidence = join(directory, `process-group-${base.split('-').at(-1)}.json`);
try {
  const build = run('/usr/bin/clang', ['-x', 'c', '-std=c11', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=15.0', join(directory, 'process-group-probe.c.txt'), '-o', executable]);
  record.build = build;
  if (build.status !== 0) throw new Error('probe_compile_failed');
  record.binaryHash = hash(executable);
  const policy = [
    '(version 1)', '(deny default)', '(allow process-fork)',
    `(allow process-exec (literal ${JSON.stringify(executable)}))`,
    '(allow sysctl-read)', '(allow file-read* (literal "/"))',
    '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS"))',
    `(allow file-read* file-map-executable (literal ${JSON.stringify(executable)}))`,
  ].join('\n');
  for (const restriction of ['deny-spawn-enosys']) {
    const active = policy + '\n(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))\n(deny syscall-unix (syscall-number SYS_posix_spawn) (with errno ENOSYS))';
    for (const mode of ['setsid', 'setpgid', 'spawn-setsid', 'spawn-setpgid', 'spawn-normal']) {
      const outcome = run('/usr/bin/sandbox-exec', ['-p', active, executable, mode]);
      record.cases.push({ restriction, mode, policy: active, ...outcome });
      console.log(JSON.stringify({ restriction, mode, ...outcome }));
      if (outcome.error || outcome.signal || outcome.status !== 0) throw new Error('probe_did_not_close_normally');
      const events = outcome.stdout.trim().split('\n').map(JSON.parse);
      if (!events.some((e) => e.mode === 'waited') && !events.some((e) => e.result === -1)) throw new Error('missing_wait_evidence');
    }
  }
} catch (error) {
  record.error = error.message;
  process.exitCode = 1;
} finally {
  record.completedAt = new Date().toISOString();
  writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);
  const current = statSync(base);
  const handles = run('/usr/sbin/lsof', ['-nP', '+D', base]);
  const mounts = run('/sbin/mount', []);
  record.cleanup = { removed: false, handles, mountsChecked: mounts.status === 0 };
  // Every fixed child is waitpid-reaped, or self-exits after five seconds.
  // An abnormal run is deliberately retained for separate verification.
  if (!record.error && current.uid === identity.uid && current.dev === identity.dev && current.ino === identity.ino && realpathSync(base) === base && handles.status === 1 && !handles.stdout && !handles.stderr && mounts.status === 0 && !mounts.stdout.includes(base)) {
    rmSync(base, { recursive: true });
    record.cleanup.removed = !existsSync(base);
  }
  record.availableAfter = available();
  record.spaceDelta = record.availableAfter - record.availableBefore;
  writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ evidence, cleanup: record.cleanup }));
}
