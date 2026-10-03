/** Real native close and official closed-session evidence for stopped workers.
 * Historical reads use the original canonical snapshot and never reopen it. */
import type { AppState } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { readLocalRangeBoundary } from './local-range-boundary';
import { type LocalRangeTargets, localRangeAssignmentHash } from './local-range-targets';
import { type LocalClaimRecord, localRecordHash } from './local-registry-records';

type Worker = LocalRangeTargets['workers'][number];
type Scope = {
  projectId: string;
  taskId: string;
  workerId: string;
  sessionId: string;
  safePointRef: string;
};
type Official = {
  sourceSessionId: string;
  projectId: string;
  taskId: string;
  role: string;
  cwd: string;
  boundary: number;
  sessionHash: string;
};
type Options = {
  objects: LocalControlObjects;
  native(scope: Scope): Promise<string>;
  official(scope: Scope, state: AppState): Promise<Official>;
  /** Actual current native capabilities for this exact old session. */
  isActive(scope: Scope): boolean;
};
type Record = {
  schemaVersion: 'local-quiescent-worker-v1';
  scope: Scope;
  workerHash: string;
  assignmentHash: string;
  nativeBoundaryId: string;
  nativeBoundaryHash: string;
  official: Official;
};
function fail(): never {
  throw Error('workspace_worker_closure_unverified');
}
export class LocalQuiescentWorkerEvidence {
  constructor(private readonly options: Options) {}
  private scope(worker: Worker, state: AppState): Scope {
    const current = state.workers.find((w) => w.workerId === worker.workerId);
    if (
      !current ||
      !['paused', 'done', 'failed'].includes(current.status) ||
      !current.sessionId ||
      !current.safePoint ||
      state.projectId !== worker.projectId ||
      state.taskId !== worker.taskId ||
      current.sessionId !== worker.sessionId ||
      current.status !== worker.status ||
      localRangeAssignmentHash(state, worker.workerId) !== worker.assignmentHash
    )
      fail();
    return {
      projectId: state.projectId,
      taskId: state.taskId,
      workerId: current.workerId,
      sessionId: current.sessionId,
      safePointRef: current.safePoint,
    };
  }
  async prove(worker: Worker, state: AppState) {
    const scope = this.scope(worker, state),
      nativeBoundaryId = await this.options.native(scope);
    if (!/^closure:[a-f0-9]{64}$/.test(nativeBoundaryId)) fail();
    const nativeBoundaryHash = await this.options.objects.getReference(nativeBoundaryId.slice(8));
    if (!nativeBoundaryHash) fail();
    const record: Record = {
      schemaVersion: 'local-quiescent-worker-v1',
      scope,
      workerHash: localRecordHash(state.workers.find((w) => w.workerId === worker.workerId)),
      assignmentHash: worker.assignmentHash,
      nativeBoundaryId,
      nativeBoundaryHash,
      official: await this.options.official(scope, state),
    };
    const ref = await this.options.objects.put(record);
    await this.read(worker, state, ref);
    return ref;
  }
  async read(worker: Worker, state: AppState, ref: string) {
    const record = (await this.options.objects.get(ref)) as Record,
      scope = this.scope(worker, state);
    if (
      !record ||
      Object.keys(record).sort().join(',') !==
        'assignmentHash,nativeBoundaryHash,nativeBoundaryId,official,schemaVersion,scope,workerHash' ||
      record.schemaVersion !== 'local-quiescent-worker-v1' ||
      localRecordHash(record.scope) !== localRecordHash(scope) ||
      record.workerHash !==
        localRecordHash(state.workers.find((w) => w.workerId === worker.workerId)) ||
      record.assignmentHash !== worker.assignmentHash ||
      !/^closure:[a-f0-9]{64}$/.test(record.nativeBoundaryId) ||
      (await this.options.objects.getReference(record.nativeBoundaryId.slice(8))) !==
        record.nativeBoundaryHash ||
      this.options.isActive(scope)
    )
      fail();
    await this.options.objects.get(record.nativeBoundaryHash);
    const native = await readLocalRangeBoundary(scope, {
      objects: this.options.objects,
      tasks: {
        load: async (input) =>
          input.projectId === state.projectId && input.taskId === state.taskId
            ? structuredClone(state)
            : undefined,
      },
      isActive: (input) => this.options.isActive(input),
    });
    if (
      native !== record.nativeBoundaryId ||
      record.official.sourceSessionId !== scope.sessionId ||
      record.official.projectId !== scope.projectId ||
      record.official.taskId !== scope.taskId ||
      record.official.role !== state.workers.find((w) => w.workerId === scope.workerId)?.role ||
      localRecordHash(await this.options.official(scope, state)) !==
        localRecordHash(record.official)
    )
      fail();
  }
  workerForClaim(claim: LocalClaimRecord, state: AppState): Worker {
    const worker = state.workers.find((w) => w.workerId === claim.workerId),
      binding = state.localExecution?.bindings.find((b) => b.workerId === claim.workerId);
    if (
      claim.kind !== undefined ||
      !worker ||
      !binding ||
      binding.workspaceId !== claim.workspaceId ||
      state.projectId !== claim.projectId ||
      state.taskId !== claim.taskId ||
      !worker.sessionId
    )
      fail();
    return {
      projectId: state.projectId,
      taskId: state.taskId,
      workerId: worker.workerId,
      sessionId: worker.sessionId,
      status: worker.status,
      assignmentHash: localRangeAssignmentHash(state, worker.workerId),
      dependencyWorkspaceIds: [],
    };
  }
  async proveClaim(claim: LocalClaimRecord, state: AppState) {
    const ref = await this.prove(this.workerForClaim(claim, state), state);
    await this.verifyClaim(claim, state, ref);
    return ref;
  }
  async verifyClaim(claim: LocalClaimRecord, state: AppState, ref: string) {
    await this.read(this.workerForClaim(claim, state), state, ref);
    const record = (await this.options.objects.get(ref)) as Record,
      native = (await this.options.objects.get(record.nativeBoundaryHash)) as {
        workspaceId?: string;
        writerEpoch?: number;
        canonicalSourceRef?: string;
      };
    if (
      native.workspaceId !== claim.workspaceId ||
      native.writerEpoch !== claim.writerEpoch ||
      native.canonicalSourceRef !==
        state.localExecution?.bindings.find((b) => b.workerId === claim.workerId)?.receiptId
    )
      fail();
  }
}
