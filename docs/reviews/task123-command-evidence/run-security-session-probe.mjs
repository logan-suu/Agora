// Trusted prelude only: creates a session for this disposable helper, never for the app.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync('/private/tmp/agora-task123-validation-');
const identity = statSync(base);
const executable = join(base, 'session-probe');
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const space = () => { const s = statfsSync('/private/tmp'); return s.bavail * s.bsize; };
const run = (file, args) => {
  const r = spawnSync(file, args, { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: base, TMPDIR: base }, encoding: 'utf8', timeout: 10000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
};
const record = { base, startedAt: new Date().toISOString(), sourceHash: hash(join(directory, 'security-session-probe.c.txt')), controllerHash: hash(fileURLToPath(import.meta.url)), identity: { uid: identity.uid, dev: identity.dev, ino: identity.ino }, availableBefore: space(), os: run('/usr/bin/sw_vers', ['-buildVersion']), compiler: run('/usr/bin/clang', ['--version']) };
const evidence = join(directory, `security-session-${base.split('-').at(-1)}.json`);
try {
  record.build = run('/usr/bin/clang', ['-x', 'c', '-std=c11', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=15.0', '-framework', 'Security', '-lbsm', join(directory, 'security-session-probe.c.txt'), '-o', executable]);
  if (record.build.status !== 0) throw new Error('compile_failed');
  record.binaryHash = hash(executable);
  record.result = run(executable, []);
  if (record.result.status !== 0 || record.result.error) throw new Error('helper_failed');
} catch (error) {
  record.error = error.message;
  process.exitCode = 1;
} finally {
  record.completedAt = new Date().toISOString();
  writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);
  const current = statSync(base);
  const handles = run('/usr/sbin/lsof', ['-nP', '+D', base]);
  const mounts = run('/sbin/mount', []);
  record.cleanup = { removed: false, handles };
  if (current.uid === identity.uid && current.dev === identity.dev && current.ino === identity.ino && realpathSync(base) === base && handles.status === 1 && !handles.stdout && !handles.stderr && mounts.status === 0 && !mounts.stdout.includes(base) && !record.result?.error) {
    rmSync(base, { recursive: true });
    record.cleanup.removed = true;
  }
  record.availableAfter = space();
  record.spaceDelta = record.availableAfter - record.availableBefore;
  writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ evidence, ...record }));
}
