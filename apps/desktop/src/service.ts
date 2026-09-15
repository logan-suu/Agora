import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createControlServer, type Server } from 'node:net';
import { join } from 'node:path';
import { controlPath, keychainStore } from '../../web/scripts/local-process.mjs';
import { createPreviewServer } from './preview-server.js';
import { credentialService } from './protocol.js';
import { acquireState, initializeFormat } from './storage.js';
import { verifyToolchain } from './toolchain-installation.js';

interface SystemStore {
  read(): Promise<string | undefined>;
  create(key: string): Promise<string>;
}
interface NextServer {
  prepare(): Promise<void>;
  close(): Promise<void>;
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}
export interface ServiceConfig {
  stateRoot: string;
  webRoot: string;
  helper: string;
  capability: string;
  toolchainRoot?: string;
}
interface Dependencies {
  system?: SystemStore;
  next?: () => NextServer;
}

export class DesktopService {
  stopped = false;
  #stopping = false;
  #signalStop!: () => void;
  #stopRequested = new Promise<void>((resolve) => {
    this.#signalStop = resolve;
  });
  #credentialOperations = new Set<Promise<unknown>>();
  #starting: Promise<{ origin: string; credentials: string } | undefined> | undefined;
  #closing: Promise<void> | undefined;
  #owner: Awaited<ReturnType<typeof acquireState>> | undefined;
  #app: NextServer | undefined;
  #preview: ReturnType<typeof createPreviewServer> | undefined;
  #control: Server | undefined;
  #boot:
    | {
        system: SystemStore;
        adopt: boolean;
        draining: boolean;
        drains: Set<() => Promise<void>>;
        credentialsReady: () => void;
        credentialStatus?: string;
      }
    | undefined;

  constructor(
    readonly config: ServiceConfig,
    readonly dependencies: Dependencies = {},
  ) {}

  start() {
    this.#starting ??= this.#start();
    return this.#starting;
  }

  #credentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => {
      if (this.#stopping) throw new Error('service_stopping');
      return operation();
    });
    this.#credentialOperations.add(pending);
    void pending.then(
      () => this.#credentialOperations.delete(pending),
      () => this.#credentialOperations.delete(pending),
    );
    return pending;
  }

  async #start() {
    const toolchain = this.config.toolchainRoot
      ? await verifyToolchain(this.config.toolchainRoot)
      : undefined;
    this.#owner = await acquireState(this.config.stateRoot);
    const control = createControlServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      control.once('error', () => reject(new Error('state_in_use')));
      control.listen(controlPath(this.#owner?.root ?? this.config.stateRoot), resolve);
    });
    this.#control = control;
    await initializeFormat(this.#owner.root);
    if (this.#stopping) return;
    process.env.AGORA_DATA_ROOT = this.#owner.root;
    process.env.AGORA_DESKTOP_PREVIEW = '1';
    let complete!: () => void;
    const credentialsReady = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const system =
      this.dependencies.system ?? keychainStore(this.config.helper, { service: credentialService });
    this.#boot = {
      system: {
        read: () => this.#credentialOperation(() => system.read()),
        create: (key) => this.#credentialOperation(() => system.create(key)),
      },
      adopt: false,
      draining: false,
      drains: new Set(),
      credentialsReady: complete,
    };
    Object.assign(globalThis, { __agoraLocalBootstrap: this.#boot });
    if (this.dependencies.next) this.#app = this.dependencies.next();
    else {
      const require = createRequire(join(this.config.webRoot, 'package.json'));
      const conf = JSON.parse(
        await readFile(join(this.config.webRoot, '.next/required-server-files.json'), 'utf8'),
      ).config;
      this.#app = require('next')({
        dev: false,
        dir: this.config.webRoot,
        hostname: '127.0.0.1',
        port: 0,
        conf,
      }) as NextServer;
    }
    await this.#app.prepare();
    if (this.#stopping) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        credentialsReady,
        this.#stopRequested,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('credentials_timeout')), 65000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (this.#stopping) return;
    const credentials = this.#boot.credentialStatus;
    if (!credentials) throw new Error('credentials_uninitialized');
    this.#preview = createPreviewServer(
      this.config.capability,
      () => ({ credentials, ...(toolchain ? { toolchain } : {}) }),
      this.#app.getRequestHandler(),
    );
    await new Promise<void>((resolve, reject) => {
      this.#preview?.server.once('error', reject);
      this.#preview?.server.listen(0, '127.0.0.1', resolve);
    });
    if (this.#stopping) return;
    return { origin: this.#preview.origin(), credentials };
  }

  stop(): Promise<void> {
    this.#stopping = true;
    this.#signalStop();
    if (this.#boot) this.#boot.draining = true;
    this.#closing ??= (async () => {
      await this.#starting?.catch(() => {});
      if (this.#boot) {
        this.#boot.draining = true;
        const drains = await Promise.allSettled([...this.#boot.drains].map((drain) => drain()));
        if (drains.some((result) => result.status === 'rejected'))
          throw new Error('service_cleanup_failed');
      }
      await this.#preview?.close();
      await this.#app?.close();
      this.#app = undefined;
      // Native operations already issued retain ownership until they have settled.
      await Promise.allSettled([...this.#credentialOperations]);
      if (this.#control)
        await new Promise<void>((resolve, reject) =>
          this.#control?.close((error) => (error ? reject(error) : resolve())),
        );
      this.#control = undefined;
      await this.#owner?.release();
      this.stopped = true;
    })().catch((error) => {
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
  }
}
