import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, session } from 'electron';
import { appId, desktopEnvironment, protocolVersion } from './protocol.js';
import { observeServiceNavigation, ServiceLifecycle } from './service-lifecycle.js';
import { statusAssets } from './status-assets.js';
import { verifyToolchain } from './toolchain-installation.js';
import { secureSession, secureWindow, trustedFrame } from './window-security.js';

export interface DesktopHostOptions {
  resourcesRoot?: string;
  applicationData?: string;
  spawnService?: (node: string, entry: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
}
export async function runDesktop(options: DesktopHostOptions = {}) {
  const resourcesRoot = options.resourcesRoot ?? process.resourcesPath;
  const ownRoot = dirname(fileURLToPath(import.meta.url));
  const assets = statusAssets(join(ownRoot, '../ui'));
  const dataDirectory = join(options.applicationData ?? app.getPath('appData'), appId);
  app.setPath('userData', dataDirectory);
  app.setPath('sessionData', join(dataDirectory, 'profiles'));
  app.commandLine.appendSwitch('disk-cache-dir', join(dataDirectory, 'cache'));
  let window: BrowserWindow | undefined;
  let lifecycle: ServiceLifecycle | undefined;
  let disposeSession: (() => Promise<void>) | undefined;
  let capability: string | undefined;
  let quitting = false;
  let quitComplete = false;
  let restarting = false;
  let startupOperation: Promise<void> | undefined;
  let restartOperation: Promise<void> | undefined;
  let startupFailure: string | undefined;
  let trustedUrls = new Set([assets.page]);
  let presentation = Promise.resolve();

  function status() {
    return {
      state: startupFailure ? 'failed' : (lifecycle?.state ?? 'starting'),
      code: startupFailure ?? lifecycle?.failure ?? null,
      canRestart:
        !quitting &&
        !restarting &&
        !restartOperation &&
        (!lifecycle || lifecycle.exited || lifecycle.state === 'ready'),
    };
  }

  function show(origin?: string) {
    presentation = presentation.catch(() => {}).then(() => present(origin));
    return presentation;
  }

  async function present(origin?: string) {
    const old = window;
    window = undefined;
    if (old && !old.isDestroyed()) old.destroy();
    await disposeSession?.();
    const partition = session.fromPartition(`agora-${randomUUID()}`, { cache: false });
    // Explicitly serve only packaged status assets with file privileges disabled.
    partition.protocol.handle('file', assets.handle);
    disposeSession = secureSession(partition, origin, capability, assets.urls);
    trustedUrls = new Set([assets.page, ...(origin ? [`${origin}/desktop`] : [])]);
    window = new BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 660,
      minHeight: 520,
      title: 'Agora',
      backgroundColor: '#090d14',
      show: false,
      webPreferences: {
        session: partition,
        preload: join(ownRoot, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: false,
        webviewTag: false,
      },
    });
    secureWindow(window, trustedUrls);
    window.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        window?.hide();
      }
    });
    window.once('ready-to-show', () => window?.show());
    if (origin) await window.loadURL(`${origin}/desktop`);
    else await window.loadURL(assets.page);
  }

  async function executable(path: string) {
    const resolved = await realpath(path);
    const resources = await realpath(resourcesRoot);
    const info = await lstat(path);
    if (
      !resolved.startsWith(`${resources}/`) ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      !(info.mode & 0o111)
    )
      throw new Error('invalid_installation');
    return resolved;
  }

  function start(): Promise<void> {
    startupOperation ??= startService().finally(() => {
      startupOperation = undefined;
    });
    return startupOperation;
  }

  function restart(): Promise<void> {
    if (quitting) return Promise.resolve();
    restartOperation ??= (async () => {
      await startupOperation;
      const previous = lifecycle;
      try {
        await previous?.stop();
      } catch (error) {
        if (!previous?.exited) throw error;
      }
      if (!quitting) await start();
    })()
      .catch(async () => {
        startupFailure = lifecycle?.failure ?? 'service_restart_failed';
        await show();
      })
      .finally(() => {
        restartOperation = undefined;
      });
    return restartOperation;
  }

  async function startService() {
    if (restarting || (lifecycle && !lifecycle.exited)) return;
    restarting = true;
    startupFailure = undefined;
    try {
      await show();
      if (quitting) return;
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const tools = join(resourcesRoot, 'toolchains', `darwin-${process.arch}`);
      await verifyToolchain(tools);
      const node = await executable(join(tools, 'node/bin/node'));
      const helper = await executable(join(tools, 'keychain'));
      if (quitting) return;
      capability = randomBytes(32).toString('hex');
      const webRoot = join(resourcesRoot, 'service/apps/web');
      const entry = join(resourcesRoot, 'service/apps/desktop/dist/service-entry.js');
      const child = options.spawnService
        ? options.spawnService(node, entry, webRoot, desktopEnvironment())
        : spawn(node, [entry], {
            cwd: webRoot,
            env: desktopEnvironment(),
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
      lifecycle = new ServiceLifecycle(child, {
        type: 'start',
        version: protocolVersion,
        config: {
          stateRoot: join(dataDirectory, 'state'),
          webRoot,
          helper,
          capability,
          toolchainRoot: tools,
        },
      });
      const active = lifecycle;
      active.on('ready', () => {
        void observeServiceNavigation(
          active,
          show(active.origin),
          () => lifecycle === active && !quitting,
          async () => {
            startupFailure = 'window_failed';
            await show().catch(() => {});
          },
        );
      });
      let failureShown = false;
      active.on('changed', () => {
        if (active === lifecycle && active.state === 'failed' && !failureShown) {
          failureShown = true;
          capability = undefined;
          void show().catch(() => {});
          if (!lifecycle.exited) void lifecycle.stop().catch(() => {});
        }
      });
    } catch (error) {
      startupFailure =
        error instanceof Error && /^toolchain_[a-z_]+$/.test(error.message)
          ? error.message
          : 'invalid_installation';
      await show();
    } finally {
      restarting = false;
    }
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    try {
      await lifecycle?.stop();
      await disposeSession?.();
      quitComplete = true;
      app.quit();
    } catch {
      if (lifecycle?.exited) {
        quitComplete = true;
        app.quit();
        return;
      }
      quitting = false;
      await show();
    }
  }

  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('second-instance', () => {
      window?.show();
      window?.focus();
    });
    app.on('activate', () => {
      if (window) window.show();
    });
    app.on('window-all-closed', () => {});
    app.on('before-quit', (event) => {
      if (!quitComplete) {
        event.preventDefault();
        void quit();
      }
    });
    await app.whenReady();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Agora',
          submenu: [
            { label: 'Show Agora', click: () => window?.show() },
            {
              label: 'Restart Local Service',
              click: () => {
                void restart();
              },
            },
            { type: 'separator' },
            {
              label: 'Quit Agora',
              accelerator: 'Cmd+Q',
              click: () => {
                void quit();
              },
            },
          ],
        },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    );
    for (const [channel, handler] of [
      ['agora:status', () => status()],
      [
        'agora:restart',
        () => {
          void restart();
          return null;
        },
      ],
      [
        'agora:quit',
        () => {
          void quit();
          return null;
        },
      ],
    ] as const)
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        if (args.length || !window || !trustedFrame(window, event, trustedUrls))
          throw new Error('invalid_ipc_sender');
        return handler();
      });
    await start();
  }

  return { status, getWindow: () => window, stop: () => lifecycle?.stop(), restart };
}
