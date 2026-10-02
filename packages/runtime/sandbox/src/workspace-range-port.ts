/** L3 selective lifecycle companion. It never grants or resolves a human gate. */
export type WorkspaceRangeWorkerRequest = {
  projectId: string;
  taskId: string;
  actionId: string;
  workerIds: readonly string[];
};
export type WorkspaceRangeWorkerReceipt = {
  projectId: string;
  taskId: string;
  actionId: string;
  workers: {
    workerId: string;
    sessionId: string;
    status: 'paused' | 'done' | 'failed';
    safePointRef: string;
    closed: true;
    leaseReleased: true;
  }[];
};
export interface WorkspaceRangeWorkerPort {
  holdRangeWorkers(request: WorkspaceRangeWorkerRequest): Promise<WorkspaceRangeWorkerReceipt>;
}
/** Rechecked before and after a queued global lease, before heavy initialization. */
export interface WorkspaceRangeAdmissionPort {
  /** Optional only for legacy executors. Native preparation and barrier
   * publication share the same host lane; this callback never runs a model step. */
  activate?<T>(
    scope: { projectId: string; taskId: string; workerId: string },
    prepare: () => Promise<T>,
  ): Promise<T | undefined>;
  /** Task scope has a durable physical/dependency barrier, even with no live cohort. */
  isBlocked?(scope: { projectId: string; taskId: string }): Promise<boolean>;
  canAcquire(scope: { projectId: string; taskId: string; workerId: string }): Promise<boolean>;
}

/** Live host view only; durable closure still needs native and session records. */
export type WorkspaceRangeActivity = {
  projectId: string;
  taskId: string;
  activeWorkerIds: string[];
  leasedWorkerIds: string[];
  queuedWorkerIds: string[];
};
export interface WorkspaceRangeActivityPort {
  rangeActivity(scope: { projectId: string; taskId: string }): WorkspaceRangeActivity;
}

/** Prepared official children have no tools until a new worker lease is live. */
export type WorkspaceRangeResumeRequest = {
  projectId: string;
  taskId: string;
  actionId: string;
  workers: {
    workerId: string;
    sourceSessionId: string;
    sourceSafePointRef: string;
    resumeSessionId: string;
  }[];
};
export interface WorkspaceRangeResumePort {
  registerRangeResumes(
    request: WorkspaceRangeResumeRequest,
    verify: (workerId: string, phase: 'register' | 'execute') => Promise<void>,
  ): Promise<void>;
}
