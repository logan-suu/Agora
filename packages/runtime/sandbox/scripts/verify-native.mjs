// Portable native boundary audit; all contents are synthetic sentinels.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = process.argv[2];
assert(helper, 'pass the trusted native binary path');
const base = fs.mkdtempSync(join(tmpdir(), 'agora-native-audit-'));
const root = join(base, 'root');
const outside = join(base, 'outside');
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(join(outside, 'sentinel'), 'outside sentinel');
const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const call = (operation, path, input) =>
  spawnSync(helper, [operation, root, path, root], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe', fd],
    timeout: 2000,
  });
try {
  assert.equal(call('write', 'nested/file', 'inside').status, 0);
  fs.symlinkSync('nested/file', join(root, 'internal'));
  assert.equal(call('read', 'internal').stdout, 'inside');
  fs.symlinkSync('nested/new', join(root, 'dangling'));
  assert.equal(call('write', 'dangling', 'created').status, 0);
  for (const path of ['sentinel', 'missing']) {
    fs.symlinkSync(join(outside, path), join(root, path));
    assert.notEqual(call('read', path).status, 0);
    assert.notEqual(call('write', path, 'bad').status, 0);
  }
  fs.symlinkSync('loop', join(root, 'loop'));
  assert.match(call('read', 'loop').stderr, /link limit/);
  fs.linkSync(join(outside, 'sentinel'), join(root, 'hard'));
  assert.match(call('write', 'hard', 'bad').stderr, /hard link/);
  fs.unlinkSync(join(root, 'hard'));
  execFileSync('mkfifo', [join(root, 'fifo')]);
  assert.match(call('read', 'fifo').stderr, /special file/);
  fs.unlinkSync(join(root, 'fifo'));
  for (const component of ['ancestor', 'final']) {
    fs.mkdirSync(join(root, 'moving'));
    fs.writeFileSync(join(root, 'moving/sentinel'), 'inside');
    const path = component === 'ancestor' ? join(root, 'moving') : join(root, 'moving/sentinel');
    const target = component === 'ancestor' ? outside : join(outside, 'sentinel');
    const code = `const fs=require('node:fs');const [p,t]=process.argv.slice(1);process.stdout.write('ready');for(;;){try{fs.renameSync(p,p+'-parked');fs.symlinkSync(t,p);fs.unlinkSync(p);fs.renameSync(p+'-parked',p);}catch{}}`;
    const child = spawn(process.execPath, ['-e', code, path, target], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', resolve);
    });
    try {
      for (let index = 0; index < 100; index++) {
        const read = call('read', 'moving/sentinel');
        if (read.status === 0) assert(!read.stdout.includes('outside'));
        const write = call('write', 'moving/sentinel', 'inside');
        assert.equal(write.signal, null, 'write must fail closed without hanging');
        const list = call('list', '');
        assert.equal(list.signal, null, 'list must not follow a special file');
      }
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      fs.rmSync(join(root, 'moving'), { recursive: true, force: true });
      fs.rmSync(join(root, 'moving-parked'), { recursive: true, force: true });
    }
  }
  assert.equal(fs.readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside sentinel');
  assert.equal(fs.existsSync(join(outside, 'missing')), false);
  console.info(
    JSON.stringify({
      platform: process.platform,
      architecture: process.arch,
      passed: [
        'read/write/list',
        'internal/dangling links',
        'escape',
        'hard link',
        'link cycle',
        'FIFO',
        'independent ancestor and final races',
      ],
    }),
  );
} finally {
  fs.closeSync(fd);
  fs.rmSync(base, { recursive: true, force: true });
}
