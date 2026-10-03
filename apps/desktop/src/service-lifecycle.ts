import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseServiceEvent, protocolVersion } from './protocol.js';

export class ServiceLifecycle extends EventEmitter {
  state: 'starting' | 'ready' | 'draining' | 'stopped' | 'failed' = 'starting';
  failure: string | undefined;
  origin: string | undefined;
  exited = false;
  #interactiveDrain: boolean;
  #receipt = false;
  #stopSent = false;
  #stop: Promise<void> | undefined;
  #exit: Promise<void>;
  #startupTimer: ReturnType<typeof setTimeout>;

  constructor(
    readonly child: ChildProcess,
    start: object,
    readonly deadline = 70000,
  ) {
    super();
    const config = (start as { config?: { acceptanceRoots?: unknown } }).config;
    this.#interactiveDrain =
      Array.isArray(config?.acceptanceRoots) && config.acceptanceRoots.length > 0;
    this.#startupTimer = setTimeout(() => this.fail('startup_timeout'), deadline);
    this.#exit = new Promise((resolve) => {
      child.once('exit', (code) => {
        this.exited = true;
        clearTimeout(this.#startupTimer);
        if (this.failure === 'service_disconnected' && code !== 0) this.failure = 'service_exited';
        if (this.#receipt && code === 0 && !this.failure) this.state = 'stopped';
        else this.fail(this.failure ?? 'service_exited');
        this.emit('changed');
        this.emit('exited');
        resolve();
      });
      child.once('error', () => {
        this.fail('service_spawn_failed');
        // Failed spawn never emits exit.
        if (!child.pid) {
          this.exited = true;
          this.emit('exited');
          resolve();
        }
      });
    });
    child.on('message', (value) => {
      try {
        const event = parseServiceEvent(value);
        if (event.type === 'selected' || event.type === 'selection-failed') {
          this.emit('selection', event);
        } else if (event.type === 'ready') {
          if (this.state !== 'starting') throw new Error('invalid_protocol');
          clearTimeout(this.#startupTimer);
          this.origin = event.origin;
          this.state = 'ready';
          this.emit('ready', event);
          this.emit('changed');
        } else if (event.type === 'stopped') {
          if (!this.#stopSent || this.#receipt) throw new Error('invalid_protocol');
          this.#receipt = true;
          this.emit('receipt');
        } else if (
          this.#interactiveDrain &&
          this.#stopSent &&
          event.code === 'service_cleanup_failed'
        ) {
          this.#stopSent = false;
          this.emit('cleanupFailed');
        } else this.fail(event.code);
      } catch {
        this.fail('invalid_protocol');
      }
    });
    child.on('disconnect', () => {
      if (!this.#receipt && !this.exited) this.fail('service_disconnected');
    });
    child.send(start, (error) => {
      if (error) this.fail('service_ipc_failed');
    });
  }

  selectDirectory(scope: { projectId: string; taskId: string }, actionId: string, path: string) {
    if (this.state !== 'ready' || !this.child.connected)
      return Promise.reject(Error('service_not_ready'));
    const requestId = randomUUID();
    return new Promise<{ selectionRef: string; path: string }>((resolve, reject) => {
      const done = (error?: Error, result?: { selectionRef: string; path: string }) => {
        clearTimeout(timer);
        this.off('selection', receive);
        this.off('exited', exited);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const exited = () => done(Error('service_exited'));
      const receive = (event: import('./protocol.js').ServiceEvent) => {
        if (!('requestId' in event) || event.requestId !== requestId) return;
        if (event.type === 'selected')
          done(undefined, { selectionRef: event.selectionRef, path: event.path });
        else if (event.type === 'selection-failed') done(Error(event.code));
      };
      const timer = setTimeout(() => done(Error('selection_timeout')), 15000);
      this.on('selection', receive);
      this.once('exited', exited);
      this.child.send(
        { type: 'select-directory', version: protocolVersion, requestId, scope, actionId, path },
        (error) => {
          if (error) done(Error('service_ipc_failed'));
        },
      );
    });
  }

  fail(code: string) {
    clearTimeout(this.#startupTimer);
    this.failure ??= code;
    this.state = 'failed';
    this.origin = undefined;
    this.emit('changed');
  }

  stop(): Promise<void> {
    if (this.#stop) return this.#stop;
    if (this.exited)
      return this.failure ? Promise.reject(new Error(this.failure)) : Promise.resolve();
    clearTimeout(this.#startupTimer);
    if (!this.failure) this.state = 'draining';
    this.#stop = new Promise<void>((resolve, reject) => {
      const cleanupFailed = () => {
        clearTimeout(timer);
        this.#stop = undefined;
        reject(new Error('service_cleanup_failed'));
      };
      this.once('cleanupFailed', cleanupFailed);
      const timer = setTimeout(() => {
        if (this.#interactiveDrain && this.origin) {
          this.emit('changed');
          return;
        }
        this.off('cleanupFailed', cleanupFailed);
        this.fail('shutdown_timeout');
        reject(new Error('shutdown_timeout'));
      }, this.deadline);
      this.#exit.then(() => {
        this.off('cleanupFailed', cleanupFailed);
        clearTimeout(timer);
        if (this.failure) reject(new Error(this.failure));
        else resolve();
      });
    });
    this.emit('changed');
    if (!this.#stopSent && this.child.connected) {
      this.#stopSent = true;
      this.child.send({ type: 'stop', version: protocolVersion }, (error) => {
        if (error && !this.#receipt) this.fail('service_ipc_failed');
      });
    }
    return this.#stop;
  }
}

// Navigation can reject after a deliberate drain or after a newer service takes over.
// Only the current ready service may turn that rejection into a visible failure.
export async function observeServiceNavigation(
  lifecycle: ServiceLifecycle,
  navigation: Promise<unknown>,
  isCurrent: () => boolean,
  onFailure: () => Promise<void>,
) {
  try {
    await navigation;
  } catch {
    if (lifecycle.state === 'ready' && isCurrent()) await onFailure();
  }
}
