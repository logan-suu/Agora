// The Next/Keychain fixtures deliberately hold startup promises for deterministic
// lifecycle unit coverage. They do not replace the separate real packaged G5 run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');

for (const stage of ['prepare', 'credentials']) {
  test(`stop during ${stage} prevents late readiness and exits`, { timeout: 10000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agora112-startup-unit-'));
    const web = path.join(root, 'apps/web');
    const next = path.join(web, 'node_modules/next');
    fs.mkdirSync(next, { recursive: true });
    fs.mkdirSync(path.join(web, '.next'));
    fs.writeFileSync(path.join(web, 'package.json'), '{}');
    fs.writeFileSync(path.join(web, '.next/required-server-files.json'), '{"config":{}}');
    fs.writeFileSync(path.join(next, 'package.json'), '{"main":"index.cjs"}');
    fs.writeFileSync(path.join(root, 'local-process.mjs'), 'export function keychainStore() { return {}; }');
    fs.writeFileSync(path.join(next, 'index.cjs'), `
      module.exports = () => ({
        async prepare() {
          if (process.env.FIXTURE_STAGE === 'prepare') {
            process.send({type:'held'});
            await new Promise(resolve => process.on('message', m => { if(m.type === 'release') resolve(); }));
            globalThis.__agoraLocalBootstrap.credentialStatus = 'ready';
            globalThis.__agoraLocalBootstrap.credentialsReady();
          } else {
            process.on('message', m => { if(m.type === 'release') {
              globalThis.__agoraLocalBootstrap.credentialStatus = 'ready';
              globalThis.__agoraLocalBootstrap.credentialsReady();
            }});
            process.send({type:'held'});
          }
        },
        getRequestHandler() { return (_req,res) => res.end('fixture'); },
        async close() { process.send({type:'closed'}); }
      });
    `);
    fs.copyFileSync(path.join(__dirname, '../desktop-spike.mjs'), path.join(root, 'desktop-spike.mjs'));
    const child = fork(path.join(root, 'desktop-spike.mjs'), [], {
      env: { FIXTURE_STAGE: stage }, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const messages = [];
    child.on('message', message => messages.push(message));
    const exited = once(child, 'exit');
    try {
      const held = new Promise(resolve => child.on('message', m => { if(m.type === 'held') resolve(); }));
      child.send({ type: 'start', token: 'unit-fixture', dataRoot: root, helper: '', keychain: '' });
      await held;
      child.send({ type: 'stop' });
      child.send({ type: 'stop' });
      child.send({ type: 'release' });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 1500);
      const [code, signal] = await exited;
      clearTimeout(timeout);
      assert.equal(signal, null, 'coordinated stop must not need the unit-test watchdog');
      assert.equal(code, 0);
      assert.equal(messages.filter(m => m.type === 'stopped').length, 1);
      assert.equal(messages.filter(m => m.type === 'closed').length, 1);
      assert.equal(messages.some(m => m.type === 'ready'), false, 'no late server may become ready');
      assert.equal(messages.some(m => m.type === 'error'), false, 'stop must not close an uninitialized server');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

const { stopChild } = require('../stop-child.cjs');
test('the owner terminates and reaps a probe that never handles stop', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agora112-stuck-unit-'));
  const entry = path.join(root, 'stuck.cjs');
  fs.writeFileSync(entry, "process.on('message',()=>{});process.send({type:'held'});setInterval(()=>{},1000);");
  const child = fork(entry, [], { env: {}, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    assert.deepEqual(await stopChild(child, { graceMs: 50, killMs: 1500 }), { forced: true });
    await exited;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally {
    if(child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
