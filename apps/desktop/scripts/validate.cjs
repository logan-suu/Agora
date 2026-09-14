// Run with Electron against a formal package; no model requests or production credentials.
const { app, BrowserWindow, ipcMain, session } = require('electron');
app.on('window-all-closed', () => {});
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const bundle = process.env.AGORA_VALIDATION_APP;
const root = fs.mkdtempSync('/private/tmp/agora113-validation-');
console.log(root);
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'cache'));
const resources = path.join(bundle, 'Contents/Resources');
const serviceModule = pathToFileURL(
  path.join(resources, 'service/apps/desktop/dist/service.js'),
).href;
const storeModule = pathToFileURL(
  path.join(resources, 'service/apps/web/scripts/local-process.mjs'),
).href;
const helper = path.join(resources, 'toolchains/darwin-arm64/keychain');
const node = path.join(resources, 'toolchains/darwin-arm64/node/bin/node');
const report = { checks: [], status: 'running', package: bundle };
const keychain = path.join(root, 'isolated.keychain-db');
let child,
  window,
  cleanupSession,
  keychainCreated = false;
const env = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  NODE_ENV: 'production',
  NEXT_MANUAL_SIG_HANDLE: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
  AGORA_LOCAL_LAUNCH: '1',
};
function check(name, value) {
  assert(value, name);
  report.checks.push(name);
  fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(report, null, 2));
}
function waitMessage(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', receive);
      reject(new Error(`${type}_timeout`));
    }, 70000);
    function receive(event) {
      if (event.type === 'failed' || event.type === type) {
        clearTimeout(timer);
        child.off('message', receive);
        if (event.type === 'failed') reject(new Error(event.code));
        else resolve(event);
      }
    }
    child.on('message', receive);
  });
}
const command = (file, args) => execFileSync(file, args, { env, timeout: 20000 });
app.whenReady().then(async () => {
  try {
    const security = await import(
      pathToFileURL(path.join(resources, 'app.asar/dist/window-security.js')).href
    );
    const password = randomBytes(24).toString('hex');
    command('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
    keychainCreated = true;
    command('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
    const capability = randomBytes(32).toString('hex');
    const log = fs.openSync(path.join(root, 'service.log'), 'w', 0o600);
    child = fork(path.join(__dirname, '../test/fixtures/packaged-service.mjs'), [], {
      execPath: node,
      cwd: path.join(resources, 'service/apps/web'),
      env,
      stdio: ['ignore', log, log, 'ipc'],
    });
    fs.closeSync(log);
    const ready = waitMessage('ready');
    child.send({
      type: 'start',
      module: serviceModule,
      storeModule,
      keychain,
      config: {
        stateRoot: path.join(root, 'state'),
        webRoot: path.join(resources, 'service/apps/web'),
        helper,
        capability,
      },
    });
    const started = await ready;
    check(
      'production Next instrumentation and isolated native Keychain',
      started.credentials === 'ready',
    );
    const origin = started.origin;
    const headers = { 'x-agora-desktop': capability };
    report.csp = (await fetch(`${origin}/desktop`, { headers })).headers.get(
      'content-security-policy',
    );
    check('reject unauthenticated HTTP', (await fetch(`${origin}/desktop`)).status === 403);
    check(
      'reject cross-origin HTTP',
      (
        await fetch(`${origin}/desktop`, {
          headers: { ...headers, origin: 'https://example.invalid' },
        })
      ).status === 403,
    );
    for (const endpoint of [
      'tasks',
      'messages',
      'commands',
      'channels',
      'traces',
      'model-settings',
      'stream',
    ]) {
      check(
        `block product endpoint ${endpoint}`,
        (await fetch(`${origin}/api/${endpoint}`, { headers })).status === 403,
      );
    }
    const partition = session.fromPartition(`validation-${randomBytes(8).toString('hex')}`);
    cleanupSession = security.secureSession(partition, origin, capability, new Set());
    window = new BrowserWindow({
      show: false,
      width: 1080,
      height: 760,
      webPreferences: {
        session: partition,
        preload: path.join(resources, 'app.asar/dist/preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const trusted = new Set([`${origin}/desktop`]);
    security.secureWindow(window, trusted);
    ipcMain.handle('agora:status', (event) => {
      assert(security.trustedFrame(window, event, trusted));
      return { state: 'ready', code: null, canRestart: false };
    });
    const consoleErrors = [];
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') consoleErrors.push(event.message);
    });
    await window.loadURL(`${origin}/desktop`);
    let rendered;
    for (let attempt = 0; attempt < 100; attempt++) {
      rendered = await window.webContents.executeJavaScript(
        '({text:document.body.innerText,node:typeof process,require:typeof require,bridge:typeof window.agoraDesktop})',
      );
      if (rendered.text.includes('Connected · running on this Mac')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(
      'React hydration and authenticated EventSource',
      rendered.text.includes('Connected · running on this Mac'),
    );
    check(
      'preview content and no project controls',
      rendered.text.includes('Available in a later desktop release.') &&
        !rendered.text.includes('Start task'),
    );
    check(
      'isolated renderer and limited preload',
      rendered.node === 'undefined' &&
        rendered.require === 'undefined' &&
        rendered.bridge === 'object',
    );
    const ipc = await window.webContents.executeJavaScript('window.agoraDesktop.status()');
    check('validated top-frame IPC', ipc.state === 'ready');
    check(
      'external windows denied',
      await window.webContents.executeJavaScript("window.open('https://example.invalid') === null"),
    );
    await window.webContents.executeJavaScript("location.href = 'https://example.invalid'");
    await new Promise((resolve) => setTimeout(resolve, 100));
    check('external navigation denied', window.webContents.getURL() === `${origin}/desktop`);
    const unrelated = new BrowserWindow({
      show: false,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(resources, 'app.asar/dist/preload.cjs'),
      },
    });
    try {
      await unrelated.loadURL(`${origin}/desktop`);
      check(
        'untrusted window IPC rejected',
        await unrelated.webContents.executeJavaScript(
          'window.agoraDesktop.status().then(() => false, () => true)',
        ),
      );
    } finally {
      unrelated.destroy();
    }
    // strict-dynamic permits scripts created by trusted scripts (CSP #426/#787).
    // An injected event-handler attribute has no nonce and must remain blocked.
    const violation = await window.webContents.executeJavaScript(`new Promise(resolve => {
      let blocked = false;
      document.addEventListener('securitypolicyviolation', event => {
        if (event.violatedDirective === 'script-src-attr') blocked = true;
      });
      setTimeout(() => {
        const button = document.createElement('button');
        button.setAttribute('onclick', 'window.injected = true');
        document.body.append(button); button.click(); button.remove();
        setTimeout(() => resolve(window.injected !== true && blocked), 100);
      }, 0);
    })`);
    check('CSP blocks inline handler and emits violation', violation);
    fs.writeFileSync(
      path.join(root, 'window.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    window.destroy();
    window = undefined;
    await cleanupSession();
    cleanupSession = undefined;
    check(
      'retired session denies new connections',
      await partition.fetch(`${origin}/desktop`).then(
        () => false,
        () => true,
      ),
    );
    const before = command(helper, [
      'read',
      'com.agora.desktop.credentials',
      process.env.USER,
      keychain,
    ]);
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    const stopped = waitMessage('stopped');
    child.send({ type: 'stop', version: 1 });
    await stopped;
    check('graceful stop and actual process exit', (await exited) === 0);
    const after = command(helper, [
      'read',
      'com.agora.desktop.credentials',
      process.env.USER,
      keychain,
    ]);
    check('Keychain identity retained after stop', before.equals(after));
    before.fill(0);
    after.fill(0);
    check(
      'state format persisted',
      JSON.parse(fs.readFileSync(path.join(root, 'state/desktop-format.json'))).version === 1,
    );
    const future = path.join(root, 'future');
    fs.mkdirSync(future, { mode: 0o700 });
    fs.writeFileSync(path.join(future, 'desktop-format.json'), '{"version":2}\n');
    child = fork(path.join(resources, 'service/apps/desktop/dist/service-entry.js'), [], {
      execPath: node,
      cwd: path.join(resources, 'service/apps/web'),
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const events = [];
    child.on('message', (event) => events.push(event));
    const futureExit = new Promise((resolve) => child.once('exit', resolve));
    child.send({
      type: 'start',
      version: 1,
      config: {
        stateRoot: future,
        webRoot: path.join(resources, 'service/apps/web'),
        helper,
        capability,
      },
    });
    check(
      'production service entry refuses future format before credential initialization',
      (await futureExit) === 1 &&
        events.some((event) => event.code === 'unsupported_state_version') &&
        !events.some((event) => event.type === 'ready') &&
        fs.readFileSync(path.join(future, 'desktop-format.json'), 'utf8') === '{"version":2}\n' &&
        !fs.existsSync(path.join(future, '.desktop-owner')),
    );
    report.consoleErrors = consoleErrors;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
  } finally {
    window?.destroy();
    await cleanupSession?.();
    if (child?.exitCode === null) {
      if (child.connected) child.send({ type: 'stop', version: 1 }, () => {});
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
      if (child.exitCode === null) {
        report.forcedCleanup = true;
        report.status = 'failed';
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    if (keychainCreated) {
      command('/usr/bin/security', ['delete-keychain', keychain]);
      report.keychainRemoved = true;
    }
    fs.writeFileSync(path.join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`VALIDATION_RESULT=${path.join(root, 'result.json')}`);
    app.exit(report.status === 'passed' ? 0 : 1);
  }
});
