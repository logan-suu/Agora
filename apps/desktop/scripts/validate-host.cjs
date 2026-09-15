// Exercise the production Electron composition with a real isolated Keychain service bootstrap.
const { app } = require('electron');
const assert = require('node:assert/strict');
const { fork, spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync('/private/tmp/agora113-host-');
console.log(root);
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'cache'));
const resources = path.join(process.env.AGORA_VALIDATION_APP, 'Contents/Resources');
const keychain = path.join(root, 'isolated.keychain-db');
let host,
  keychainCreated = false,
  child;
const checks = [];
const report = { status: 'running', checks };
function check(name, value) {
  assert(value, name);
  checks.push(name);
}
async function until(condition) {
  for (let i = 0; i < 700; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('host_timeout');
}
app.whenReady().then(async () => {
  try {
    const password = randomBytes(24).toString('hex');
    execFileSync('/usr/bin/security', ['create-keychain', '-p', password, keychain], {
      stdio: 'pipe',
    });
    keychainCreated = true;
    execFileSync('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], {
      stdio: 'pipe',
    });
    const { runDesktop } = await import(
      pathToFileURL(path.join(resources, 'app.asar/dist/desktop-app.js')).href
    );
    host = await runDesktop({
      resourcesRoot: resources,
      applicationData: root,
      spawnService(node, _entry, cwd, env) {
        const fd = fs.openSync(path.join(root, 'service.log'), 'a', 0o600);
        child = fork(path.join(__dirname, '../test/fixtures/packaged-service.mjs'), [], {
          execPath: node,
          cwd,
          env: {
            ...env,
            AGORA_VALIDATION_MODULE: pathToFileURL(
              path.join(resources, 'service/apps/desktop/dist/service.js'),
            ).href,
            AGORA_VALIDATION_STORE_MODULE: pathToFileURL(
              path.join(resources, 'service/apps/web/scripts/local-process.mjs'),
            ).href,
            AGORA_VALIDATION_KEYCHAIN: keychain,
          },
          stdio: ['ignore', fd, fd, 'ipc'],
        });
        fs.closeSync(fd);
        return child;
      },
    });
    await until(() => host.status().state === 'ready' || host.status().state === 'failed');
    check('production host readiness', host.status().state === 'ready');
    await until(
      async () =>
        host.getWindow()?.webContents.getURL().endsWith('/desktop') &&
        (await host.getWindow().webContents.executeJavaScript('document.body.innerText')).includes(
          'Connected · running on this Mac',
        ),
    );
    const window = host.getWindow();
    check(
      'production preload status',
      (await window.webContents.executeJavaScript('window.agoraDesktop.status()')).state ===
        'ready',
    );
    const settings = window.webContents.getLastWebPreferences();
    check(
      'production renderer isolation',
      settings.sandbox &&
        settings.contextIsolation &&
        !settings.nodeIntegration &&
        !settings.devTools,
    );
    window.close();
    check(
      'closing window preserves background service',
      !window.isDestroyed() && host.status().state === 'ready',
    );
    const competing = spawn(
      process.execPath,
      [path.join(__dirname, '../test/fixtures/second-instance.cjs'), root, resources],
      { stdio: 'ignore' },
    );
    const competitorExit = await new Promise((resolve) => competing.once('exit', resolve));
    const second = JSON.parse(fs.readFileSync(path.join(root, 'second-instance.json')));
    check(
      'native duplicate launch cannot spawn service',
      competitorExit === 0 && !second.spawned && !second.ownsLock,
    );
    await until(() => window.isVisible());
    check('native second launch focuses current window', window.isVisible());
    fs.writeFileSync(
      path.join(root, 'window.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    const previousChild = child;
    const oldSession = window.webContents.session;
    const oldUrl = window.webContents.getURL();
    const restart = host.restart();
    check('concurrent restarts share one operation', host.restart() === restart);
    await restart;
    await until(() => host.status().state === 'ready' || host.status().state === 'failed');
    check(
      'restart replaces a running process after its exit',
      child.pid !== previousChild.pid &&
        previousChild.exitCode === 0 &&
        host.status().state === 'ready',
    );
    await until(() => host.getWindow()?.webContents.getURL().endsWith('/desktop'));
    check(
      'restart replaces and revokes the old session',
      host.getWindow().webContents.session !== oldSession &&
        (await oldSession.fetch(oldUrl).then(
          () => false,
          () => true,
        )),
    );
    await host.stop();
    report.afterStop = { ...host.status(), exitCode: child.exitCode, signalCode: child.signalCode };
    check(
      'production host waits for process exit',
      host.status().state === 'stopped' && child.exitCode === 0,
    );
    await host.restart();
    await until(() => host.status().state === 'ready' || host.status().state === 'failed');
    check('fresh session after explicit restart', host.status().state === 'ready');
    // This preview has no model work; a crash injection must fail visibly and retain the owner record.
    child.kill('SIGKILL');
    await until(() => host.status().state === 'failed');
    await until(() => host.getWindow()?.webContents.getURL().endsWith('status.html'));
    check(
      'crash replaces project surface with failure UI',
      (await host.getWindow().webContents.executeJavaScript('document.body.innerText')).includes(
        'Agora',
      ),
    );
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
  } finally {
    await host?.stop()?.catch(() => {});
    host?.getWindow()?.destroy();
    try {
      const { cleanupChild } = await import('./validation-cleanup.mjs');
      if (await cleanupChild(child)) {
        report.status = 'failed';
        report.forcedCleanup = true;
      }
    } catch (error) {
      report.status = 'failed';
      report.cleanupError = error.message;
    }
    if (keychainCreated) {
      execFileSync('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'pipe' });
      report.keychainRemoved = true;
    }
    fs.writeFileSync(path.join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`HOST_RESULT=${path.join(root, 'result.json')}`);
    app.exit(report.status === 'passed' ? 0 : 1);
  }
});
