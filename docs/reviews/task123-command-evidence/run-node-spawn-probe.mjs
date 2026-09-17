// Fixed compatibility experiment. No project files, network, or inherited secrets.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync('/private/tmp/agora-task123-validation-');
const identity = statSync(base);
const available = () => { const s = statfsSync('/private/tmp'); return s.bavail * s.bsize; };
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const toolsRoot = '/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64';
const executable = realpathSync(join(toolsRoot, 'node/bin/node'));
const manifest = JSON.parse(readFileSync(join(toolsRoot, 'manifest.json'), 'utf8'));
const expected = manifest.files.find((file) => file.path === 'node/bin/node');
if (manifest.versions.node !== '24.20.0' || expected.sha256 !== hash(executable)) throw new Error('toolchain_identity_mismatch');
const run = (file, args) => {
  const result = spawnSync(file, args, {
    cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: base, TMPDIR: base },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
};
const record = { startedAt: new Date().toISOString(), base, identity: { uid: identity.uid, dev: identity.dev, ino: identity.ino }, availableBefore: available(), controllerHash: hash(fileURLToPath(import.meta.url)), nodePath: executable, nodeHash: hash(executable), manifestHash: hash(join(toolsRoot, 'manifest.json')), os: run('/usr/bin/sw_vers', ['-buildVersion']), cases: [] };
const evidence = join(directory, `node-spawn-${base.split('-').at(-1)}.json`);
try {
  const policy = [
    '(version 1)', '(deny default)', '(allow process-fork)',
    `(allow process-exec (literal ${JSON.stringify(executable)}) (literal "/bin/sh"))`,
    '(allow sysctl-read)', '(allow file-read* (literal "/"))',
    '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS"))',
    `(allow file-read* file-map-executable (literal ${JSON.stringify(executable)}) (literal "/bin/sh"))`,
    '(allow file-read* file-write-data (literal "/dev/null"))',
    '(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))',
  ].join('\n');
  for (const restriction of ['none']) {
    const active = policy + (restriction === 'none' ? '' : `\n(deny syscall-unix (syscall-number SYS_posix_spawn) (with errno ${restriction}))`);
    const script = String.raw`const {spawnSync}=require("node:child_process"); console.log(JSON.stringify({node:process.version,uv:process.versions.uv})); const c=spawnSync(process.execPath,["-e","process.stdout.write(\"child-ok\")"],{encoding:"utf8",timeout:3000}); console.log(JSON.stringify({status:c.status,signal:c.signal,stdout:c.stdout,stderr:c.stderr,error:c.error?.code}));`;
    const outcome = run('/usr/bin/sandbox-exec', ['-p', active, executable, '-e', script]);
    record.cases.push({ restriction, policy: active, script, ...outcome });
    console.log(JSON.stringify({ restriction, ...outcome }));
    if (outcome.error) throw new Error('probe_timeout_or_launch_error');
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
  if (!record.error && current.uid === identity.uid && current.dev === identity.dev && current.ino === identity.ino && realpathSync(base) === base && handles.status === 1 && !handles.stdout && !handles.stderr && mounts.status === 0 && !mounts.stdout.includes(base)) {
    rmSync(base, { recursive: true });
    record.cleanup.removed = !existsSync(base);
  }
  record.availableAfter = available();
  record.spaceDelta = record.availableAfter - record.availableBefore;
  writeFileSync(evidence, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ evidence, cleanup: record.cleanup }));
}
