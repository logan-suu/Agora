export interface SlotLease {
  readonly leaseId: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly grantedTs: number;
}

export interface GlobalSchedulerOptions {
  cap?: number;
  newId?: () => string;
  now?: () => number;
}

interface QueuedAcquire {
  readonly key: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly promise: Promise<SlotLease>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  resolve(lease: SlotLease): void;
  reject(error: unknown): void;
}

interface LeaseIdentity {
  readonly projectId: string;
  readonly workerId: string;
}

const DEFAULT_GLOBAL_CAP = 3;

export class GlobalScheduler {
  readonly cap: number;

  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #activeByWorker = new Map<string, SlotLease>();
  readonly #activeByLease = new Map<string, SlotLease>();
  readonly #released = new Map<string, LeaseIdentity>();
  readonly #queuedByWorker = new Map<string, QueuedAcquire>();
  readonly #queues = new Map<string, QueuedAcquire[]>();
  readonly #projectOrder: string[] = [];
  #lastGrantedProject: string | undefined;

  constructor(options: GlobalSchedulerOptions = {}) {
    const cap = options.cap ?? DEFAULT_GLOBAL_CAP;
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error('GlobalScheduler cap must be a positive integer');
    }
    this.cap = cap;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => Date.now());
  }

  get activeCount(): number {
    return this.#activeByLease.size;
  }

  acquire(projectId: string, workerId: string, signal?: AbortSignal): Promise<SlotLease> {
    assertIdentity('projectId', projectId);
    assertIdentity('workerId', workerId);
    const key = workerKey(projectId, workerId);
    const active = this.#activeByWorker.get(key);
    if (active !== undefined) return Promise.resolve(active);
    const queued = this.#queuedByWorker.get(key);
    if (queued !== undefined) return queued.promise;
    if (signal?.aborted === true) return Promise.reject(abortError(signal.reason));

    if (this.activeCount < this.cap && this.#queuedByWorker.size === 0) {
      return Promise.resolve(this.#grant(projectId, workerId));
    }

    let resolveAcquire = (_lease: SlotLease): void => {};
    let rejectAcquire = (_error: unknown): void => {};
    const promise = new Promise<SlotLease>((resolve, reject) => {
      resolveAcquire = resolve;
      rejectAcquire = reject;
    });
    const onAbort =
      signal === undefined
        ? undefined
        : (): void => {
            const current = this.#queuedByWorker.get(key);
            if (current === undefined) return;
            this.#removeQueued(current);
            current.reject(abortError(signal.reason));
            this.#drain();
          };
    const request: QueuedAcquire = {
      key,
      projectId,
      workerId,
      promise,
      ...(signal === undefined ? {} : { signal }),
      ...(onAbort === undefined ? {} : { onAbort }),
      resolve: resolveAcquire,
      reject: rejectAcquire,
    };
    this.#queuedByWorker.set(key, request);
    const projectQueue = this.#queues.get(projectId);
    if (projectQueue === undefined) {
      this.#queues.set(projectId, [request]);
      this.#projectOrder.push(projectId);
    } else {
      projectQueue.push(request);
    }
    signal?.addEventListener('abort', onAbort as () => void, { once: true });
    this.#drain();
    return promise;
  }

  async release(lease: SlotLease): Promise<void> {
    const active = this.#activeByLease.get(lease.leaseId);
    if (active !== undefined) {
      if (!sameLease(active, lease)) throw leaseMismatch(lease);
      this.#activeByLease.delete(lease.leaseId);
      this.#activeByWorker.delete(workerKey(lease.projectId, lease.workerId));
      this.#released.set(lease.leaseId, {
        projectId: lease.projectId,
        workerId: lease.workerId,
      });
      this.#drain();
      return;
    }

    const released = this.#released.get(lease.leaseId);
    if (
      released !== undefined &&
      released.projectId === lease.projectId &&
      released.workerId === lease.workerId
    ) {
      return;
    }
    throw leaseMismatch(lease);
  }

  #grant(projectId: string, workerId: string): SlotLease {
    const lease: SlotLease = {
      leaseId: this.#newId(),
      projectId,
      workerId,
      grantedTs: this.#now(),
    };
    if (this.#activeByLease.has(lease.leaseId) || this.#released.has(lease.leaseId)) {
      throw new Error(`GlobalScheduler leaseId "${lease.leaseId}" is not unique`);
    }
    this.#activeByWorker.set(workerKey(projectId, workerId), lease);
    this.#activeByLease.set(lease.leaseId, lease);
    this.#lastGrantedProject = projectId;
    return lease;
  }

  #drain(): void {
    while (this.activeCount < this.cap && this.#projectOrder.length > 0) {
      const projectId = this.#nextProject();
      if (projectId === undefined) return;
      const queue = this.#queues.get(projectId);
      const request = queue?.shift();
      if (queue === undefined || request === undefined) {
        this.#dropProject(projectId);
        continue;
      }
      if (queue.length === 0) this.#dropProject(projectId);
      this.#queuedByWorker.delete(request.key);
      if (request.onAbort !== undefined) {
        request.signal?.removeEventListener('abort', request.onAbort);
      }
      if (request.signal?.aborted === true) {
        request.reject(abortError(request.signal.reason));
        continue;
      }
      try {
        request.resolve(this.#grant(request.projectId, request.workerId));
      } catch (error) {
        request.reject(error);
      }
    }
  }

  #nextProject(): string | undefined {
    if (this.#projectOrder.length === 0) return undefined;
    if (this.#lastGrantedProject === undefined) return this.#projectOrder[0];
    const previous = this.#projectOrder.indexOf(this.#lastGrantedProject);
    if (previous < 0) return this.#projectOrder[0];
    return this.#projectOrder[(previous + 1) % this.#projectOrder.length];
  }

  #removeQueued(request: QueuedAcquire): void {
    this.#queuedByWorker.delete(request.key);
    request.signal?.removeEventListener('abort', request.onAbort as () => void);
    const queue = this.#queues.get(request.projectId);
    if (queue === undefined) return;
    const index = queue.indexOf(request);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#dropProject(request.projectId);
  }

  #dropProject(projectId: string): void {
    this.#queues.delete(projectId);
    const index = this.#projectOrder.indexOf(projectId);
    if (index >= 0) this.#projectOrder.splice(index, 1);
  }
}

function workerKey(projectId: string, workerId: string): string {
  return `${projectId}\u0000${workerId}`;
}

function assertIdentity(field: string, value: string): void {
  if (value.length === 0) throw new Error(`${field} must be non-empty`);
}

function sameLease(left: SlotLease, right: SlotLease): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.projectId === right.projectId &&
    left.workerId === right.workerId &&
    left.grantedTs === right.grantedTs
  );
}

function leaseMismatch(lease: SlotLease): Error {
  return new Error(
    `GlobalScheduler lease "${lease.leaseId}" does not match an active or released lease`,
  );
}

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === 'string' ? reason : 'queued acquire was aborted');
  error.name = 'AbortError';
  return error;
}
