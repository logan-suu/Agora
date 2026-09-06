export interface PauseScope {
  projectId: string;
  taskId: string;
}

export type PauseMode = 'reproject' | 'human_gate';

export interface PauseRequest {
  scope: PauseScope;
  actionId: string;
  reason: string;
  mode: PauseMode;
}

export interface WorkerPauseReceipt {
  workerId: string;
  status: 'paused' | 'done' | 'failed';
  safePointRef?: string;
}

export interface PauseReceipt extends PauseRequest {
  cohort: readonly string[];
  workers: readonly WorkerPauseReceipt[];
}

export interface PauseLifecyclePort {
  activeWorkerIds(scope: PauseScope): readonly string[];
  cancelQueued(scope: PauseScope, actionId: string, mode: PauseMode): Promise<void>;
  pauseWorker(
    scope: PauseScope,
    workerId: string,
    actionId: string,
    mode: PauseMode,
  ): Promise<WorkerPauseReceipt>;
  resumeReprojected(
    scope: PauseScope,
    workerIds: readonly string[],
    actionId: string,
  ): Promise<void>;
  suspendPaused(scope: PauseScope, workerIds: readonly string[], actionId: string): Promise<void>;
  abortPause(scope: PauseScope, workerIds: readonly string[], actionId: string): Promise<void>;
}

interface PauseRecord {
  fingerprint: string;
  promise: Promise<PauseReceipt>;
  completion?: Promise<void>;
  aborted?: Promise<void>;
}

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Task-scoped stable pause epochs; worker execution remains owned by WorkerRuntime. */
export class Preemptor {
  readonly #records = new Map<string, PauseRecord>();
  readonly #active = new Map<string, string>();

  constructor(private readonly lifecycle: PauseLifecyclePort) {}

  requestPause(request: PauseRequest): Promise<PauseReceipt> {
    assertRequest(request);
    const recordKey = actionKey(request.scope, request.actionId);
    const fingerprint = requestFingerprint(request);
    const existing = this.#records.get(recordKey);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.reject(new Error(`pause action "${request.actionId}" conflicts with its replay`));
    }
    const scope = scopeKey(request.scope);
    const activeAction = this.#active.get(scope);
    if (activeAction !== undefined && activeAction !== request.actionId) {
      return Promise.reject(new Error(`task already has active pause epoch "${activeAction}"`));
    }
    const cohort = [...new Set(this.lifecycle.activeWorkerIds(request.scope))].sort();
    this.#active.set(scope, request.actionId);
    const promise = this.#reachBarrier(request, cohort).catch(async (error: unknown) => {
      await this.lifecycle
        .abortPause(request.scope, cohort, request.actionId)
        .catch(() => undefined);
      if (this.#active.get(scope) === request.actionId) this.#active.delete(scope);
      throw error;
    });
    this.#records.set(recordKey, { fingerprint, promise });
    return promise;
  }

  async complete(receipt: PauseReceipt): Promise<void> {
    const record = await this.#requiredRecord(receipt);
    if (record.completion !== undefined) return record.completion;
    if (record.aborted !== undefined)
      throw new Error(`pause action "${receipt.actionId}" was aborted`);
    const pausedWorkerIds = receipt.workers
      .filter((worker) => worker.status === 'paused')
      .map((worker) => worker.workerId);
    record.completion = (
      receipt.mode === 'reproject'
        ? this.lifecycle.resumeReprojected(receipt.scope, pausedWorkerIds, receipt.actionId)
        : this.lifecycle.suspendPaused(receipt.scope, pausedWorkerIds, receipt.actionId)
    ).then(() => this.#close(receipt));
    return record.completion;
  }

  async abort(receipt: PauseReceipt): Promise<void> {
    const record = await this.#requiredRecord(receipt);
    if (record.completion !== undefined) {
      throw new Error(`pause action "${receipt.actionId}" is already complete`);
    }
    if (record.aborted !== undefined) return record.aborted;
    const workerIds = receipt.workers
      .filter((worker) => worker.status === 'paused')
      .map((worker) => worker.workerId);
    record.aborted = this.lifecycle
      .abortPause(receipt.scope, workerIds, receipt.actionId)
      .then(() => this.#close(receipt));
    return record.aborted;
  }

  async #reachBarrier(request: PauseRequest, cohort: readonly string[]): Promise<PauseReceipt> {
    const cancelled = this.lifecycle.cancelQueued(request.scope, request.actionId, request.mode);
    const pendingWorkers = cohort.map((workerId) =>
      this.lifecycle.pauseWorker(request.scope, workerId, request.actionId, request.mode),
    );
    await cancelled;
    const workers = await Promise.all(pendingWorkers);
    for (let index = 0; index < workers.length; index += 1) {
      if (workers[index]?.workerId !== cohort[index]) {
        throw new Error(`pause action "${request.actionId}" returned a mismatched worker receipt`);
      }
      if (workers[index]?.status === 'paused' && workers[index]?.safePointRef === undefined) {
        throw new Error(`paused worker "${String(workers[index]?.workerId)}" lacks a safe point`);
      }
    }
    return { ...request, scope: { ...request.scope }, cohort: [...cohort], workers };
  }

  async #requiredRecord(receipt: PauseReceipt): Promise<PauseRecord> {
    const record = this.#records.get(actionKey(receipt.scope, receipt.actionId));
    if (record === undefined || record.fingerprint !== requestFingerprint(requestOf(receipt))) {
      throw new Error(`pause receipt "${receipt.actionId}" does not match a known epoch`);
    }
    const canonical = await record.promise;
    if (!sameReceipt(canonical, receipt)) {
      throw new Error(
        `pause receipt "${receipt.actionId}" does not match its canonical barrier result`,
      );
    }
    return record;
  }

  #close(receipt: PauseReceipt): void {
    const key = scopeKey(receipt.scope);
    if (this.#active.get(key) === receipt.actionId) this.#active.delete(key);
  }
}

function requestOf(receipt: PauseReceipt): PauseRequest {
  return {
    scope: receipt.scope,
    actionId: receipt.actionId,
    reason: receipt.reason,
    mode: receipt.mode,
  };
}

function assertRequest(request: PauseRequest): void {
  if (!SAFE_TOKEN.test(request.scope.projectId) || !SAFE_TOKEN.test(request.scope.taskId)) {
    throw new Error('pause scope must use safe projectId/taskId tokens');
  }
  if (!SAFE_TOKEN.test(request.actionId)) throw new Error('pause actionId must be a safe token');
  if (request.reason.length === 0) throw new Error('pause reason must be non-empty');
  if (request.mode !== 'reproject' && request.mode !== 'human_gate') {
    throw new Error('pause mode must be reproject or human_gate');
  }
}

function scopeKey(scope: PauseScope): string {
  return JSON.stringify([scope.projectId, scope.taskId]);
}

function actionKey(scope: PauseScope, actionId: string): string {
  return JSON.stringify([scope.projectId, scope.taskId, actionId]);
}

function requestFingerprint(request: PauseRequest): string {
  return JSON.stringify([
    request.scope.projectId,
    request.scope.taskId,
    request.actionId,
    request.reason,
    request.mode,
  ]);
}

function sameReceipt(left: PauseReceipt, right: PauseReceipt): boolean {
  return (
    requestFingerprint(left) === requestFingerprint(right) &&
    sameStrings(left.cohort, right.cohort) &&
    left.workers.length === right.workers.length &&
    left.workers.every((worker, index) => {
      const candidate = right.workers[index];
      return (
        candidate?.workerId === worker.workerId &&
        candidate.status === worker.status &&
        candidate.safePointRef === worker.safePointRef
      );
    })
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
