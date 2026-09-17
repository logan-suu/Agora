// Remove only the recorded disposable probe after checking ownership and inactivity.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const prior = JSON.parse(readFileSync(join(directory, 'process-group-UiqBqr.json'), 'utf8'));
const base = prior.base;
if (base !== '/private/tmp/agora-task123-validation-UiqBqr') throw new Error('unexpected_path');
const record = { at: new Date().toISOString(), base, original: 'process-group-UiqBqr.json', removed: false };
const space = () => { const s = statfsSync('/private/tmp'); return s.bavail * s.bsize; };
const run = (file, args) => {
  const r = spawnSync(file, args, { cwd: directory, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
};
record.availableBefore = space();
const identity = lstatSync(base);
record.identity = { uid: identity.uid, dev: identity.dev, ino: identity.ino };
record.entries = readdirSync(base);
record.handles = run('/usr/sbin/lsof', ['-nP', '+D', base]);
const mounts = run('/sbin/mount', []);
record.mountsChecked = mounts.status === 0 && !mounts.stdout.includes(base);
record.allChildrenWaited = prior.cases.length === 10 && prior.cases.every(c => c.status === 0 && c.stdout.includes('"mode":"waited","result":0'));
const executable = join(base, 'process-group-probe');
record.binaryHash = createHash('sha256').update(readFileSync(executable)).digest('hex');
writeFileSync(join(directory, 'cleanup-retained-fixture.json'), `${JSON.stringify(record, null, 2)}\n`);
if (!identity.isDirectory() || identity.isSymbolicLink() || realpathSync(base) !== base ||
    Object.keys(record.identity).some(k => record.identity[k] !== prior.identity[k]) ||
    record.entries.length !== 1 || record.entries[0] !== 'process-group-probe' ||
    lstatSync(executable).isSymbolicLink() || record.binaryHash !== prior.binaryHash ||
    !record.allChildrenWaited || !record.mountsChecked || record.handles.status !== 1 ||
    record.handles.stdout || record.handles.stderr || record.handles.error) throw new Error('cleanup_not_proven');
rmSync(base, { recursive: true });
record.removed = true;
record.availableAfter = space();
record.spaceDelta = record.availableAfter - record.availableBefore;
writeFileSync(join(directory, 'cleanup-retained-fixture.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record));
