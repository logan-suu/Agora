/** Host-owned bridge of actual L3 range closure, native boundaries and official
 * session prefixes. Private records preserve the close-time canonical snapshot. */
import type { AppState } from '@agora/core-domain';
import type { LocalControlObjects } from './local-control-objects';
import { readLocalRangeBoundary } from './local-range-boundary';
import type { LocalRangeSourceProof, LocalRangeWorkerProof } from './local-range-evidence';
import type { LocalRangeHold, LocalRangePlan } from './local-range-records';
import { type LocalRangeTargets, localRangeAssignmentHash } from './local-range-targets';
import { localRecordHash } from './local-registry-records';
import type { WorkspaceRangeWorkerPort, WorkspaceRangeWorkerReceipt } from './workspace-range-port';

type Scope = { projectId: string; taskId: string };
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
  objects: Pick<LocalControlObjects, 'get' | 'put' | 'getReference' | 'bindReference'>;
  tasks: { load(scope: Scope): Promise<AppState | undefined> };
  runtime(scope: Scope): WorkspaceRangeWorkerPort | undefined;
  native(
    scope: Scope & { workerId: string; sessionId: string; safePointRef: string },
  ): Promise<string>;
  official(
    scope: Scope & { workerId: string; sessionId: string; safePointRef: string },
  ): Promise<Official>;
};
type Closed = {
  schemaVersion: 'local-range-worker-boundary-v1';
  planHash: string;
  sourceRef: string;
  assignmentHash: string;
  runtimeReceipt: WorkspaceRangeWorkerReceipt['workers'][number];
  canonicalStateHash: string;
  nativeBoundaryId: string;
  nativeBoundaryHash: string;
  official: Official;
};
const key = (scope: Scope & { workerId: string }) =>
  `${scope.projectId}/${scope.taskId}/${scope.workerId}`;
export class LocalRangeWorkerEvidence {
  constructor(private readonly options: Options) {}
  async closeWorkers(hold: LocalRangeHold, sourceRef: string): Promise<LocalRangeWorkerProof[]> {
    const source = (await this.options.objects.get(sourceRef)) as LocalRangeSourceProof;
    if (
      source.schemaVersion !== 'local-range-source-v1' ||
      source.planHash !== hold.planHash ||
      localRecordHash(source) !== sourceRef
    )
      throw Error('range_worker_proof_invalid');
    const targets = (await this.options.objects.get(source.targetFactsHash)) as LocalRangeTargets;
    if (
      targets.schemaVersion !== 'local-range-targets-v1' ||
      localRecordHash(targets) !== source.targetFactsHash ||
      localRecordHash(targets.physical) !== localRecordHash(hold.plan.physical) ||
      localRecordHash(targets.cohort) !== localRecordHash(hold.plan.cohort)
    )
      throw Error('range_worker_proof_invalid');
    // A pending worker is not part of the running checkpoint cohort, but its
    // queued lease must settle before the native writer inventory can close.
    for (const scope of targets.tasks) {
      const runtime = this.options.runtime(scope);
      if (runtime) await runtime.settleRangeQueue(scope);
    }
    const groups = new Map<string, LocalRangePlan['cohort']>();
    for (const worker of hold.plan.cohort) {
      const k = `${worker.projectId}/${worker.taskId}`;
      groups.set(k, [...(groups.get(k) ?? []), worker]);
    }
    const proofs: LocalRangeWorkerProof[] = [];
    for (const workers of groups.values()) {
      const scope = workers[0];
      if (!scope) throw Error('range_worker_proof_invalid');
      const runtime = this.options.runtime(scope);
      if (!runtime) throw Error('range_worker_runtime_unavailable');
      const receipt = await runtime.holdRangeWorkers({
        projectId: scope.projectId,
        taskId: scope.taskId,
        actionId: hold.plan.sourceMessage.msgId,
        workerIds: workers.map((w) => w.workerId),
      });
      if (
        receipt.projectId !== scope.projectId ||
        receipt.taskId !== scope.taskId ||
        receipt.actionId !== hold.plan.sourceMessage.msgId ||
        receipt.workers.length !== workers.length ||
        new Set(receipt.workers.map((w) => w.workerId)).size !== workers.length
      )
        throw Error('range_worker_proof_invalid');
      for (const assignment of workers) {
        const worker = receipt.workers.find((w) => w.workerId === assignment.workerId);
        if (
          !worker ||
          worker.sessionId !== assignment.sessionId ||
          !worker.closed ||
          !worker.leaseReleased ||
          !['paused', 'done', 'failed'].includes(worker.status)
        )
          throw Error('range_worker_proof_invalid');
        const input = {
          projectId: scope.projectId,
          taskId: scope.taskId,
          workerId: worker.workerId,
          sessionId: worker.sessionId,
          safePointRef: worker.safePointRef,
        };
        const nativeBoundaryId = await this.options.native(input),
          official = await this.options.official(input);
        const state = await this.options.tasks.load(scope),
          canonical = state?.workers.find((w) => w.workerId === worker.workerId);
        if (
          !state ||
          !canonical ||
          canonical.sessionId !== worker.sessionId ||
          canonical.status !== worker.status ||
          canonical.safePoint !== worker.safePointRef ||
          localRangeAssignmentHash(state, worker.workerId) !== assignment.assignmentHash ||
          official.sourceSessionId !== worker.sessionId ||
          official.projectId !== scope.projectId ||
          official.taskId !== scope.taskId ||
          official.role !== canonical.role ||
          !/^closure:[a-f0-9]{64}$/.test(nativeBoundaryId)
        )
          throw Error('range_worker_proof_invalid');
        const nativeBoundaryHash = await this.options.objects.getReference(
          nativeBoundaryId.slice(8),
        );
        if (!nativeBoundaryHash) throw Error('range_worker_proof_invalid');
        const record: Closed = {
          schemaVersion: 'local-range-worker-boundary-v1',
          planHash: hold.planHash,
          sourceRef,
          assignmentHash: assignment.assignmentHash,
          runtimeReceipt: worker,
          canonicalStateHash: await this.options.objects.put(state),
          nativeBoundaryId,
          nativeBoundaryHash,
          official,
        };
        const h = await this.options.objects.put(record),
          ref = localRecordHash({
            kind: 'range-worker-boundary',
            planHash: hold.planHash,
            worker: key(assignment),
          });
        await this.options.objects.bindReference(ref, h);
        proofs.push({
          schemaVersion: 'local-range-worker-closed-v1',
          planHash: hold.planHash,
          sourceRef,
          projectId: scope.projectId,
          taskId: scope.taskId,
          workerId: worker.workerId,
          sessionId: worker.sessionId,
          status: worker.status,
          safePointRef: worker.safePointRef,
          boundaryReceiptId: `range-boundary:${ref}`,
          closed: true,
          leaseReleased: true,
        });
      }
    }
    return proofs;
  }
  async verify(plan: LocalRangePlan, proof: LocalRangeWorkerProof) {
    const assignment = plan.cohort.find((w) => key(w) === key(proof));
    const ref = localRecordHash({
      kind: 'range-worker-boundary',
      planHash: localRecordHash(plan),
      worker: key(proof),
    });
    const hash = await this.options.objects.getReference(ref);
    if (!hash || !assignment || proof.boundaryReceiptId !== `range-boundary:${ref}`)
      throw Error('range_worker_proof_invalid');
    const record = (await this.options.objects.get(hash)) as Closed;
    if (
      !record ||
      Object.keys(record).sort().join(',') !==
        'assignmentHash,canonicalStateHash,nativeBoundaryHash,nativeBoundaryId,official,planHash,runtimeReceipt,schemaVersion,sourceRef' ||
      record.schemaVersion !== 'local-range-worker-boundary-v1' ||
      record.planHash !== proof.planHash ||
      record.sourceRef !== proof.sourceRef ||
      record.assignmentHash !== assignment.assignmentHash ||
      localRecordHash(record.runtimeReceipt) !==
        localRecordHash({
          workerId: proof.workerId,
          sessionId: proof.sessionId,
          status: proof.status,
          safePointRef: proof.safePointRef,
          closed: true,
          leaseReleased: true,
        }) ||
      !/^closure:[a-f0-9]{64}$/.test(record.nativeBoundaryId) ||
      (await this.options.objects.getReference(record.nativeBoundaryId.slice(8))) !==
        record.nativeBoundaryHash
    )
      throw Error('range_worker_proof_invalid');
    const state = (await this.options.objects.get(record.canonicalStateHash)) as AppState;
    const worker = state.workers.find((w) => w.workerId === proof.workerId);
    if (
      !worker ||
      state.projectId !== proof.projectId ||
      state.taskId !== proof.taskId ||
      worker.sessionId !== proof.sessionId ||
      worker.status !== proof.status ||
      worker.safePoint !== proof.safePointRef ||
      localRangeAssignmentHash(state, worker.workerId) !== record.assignmentHash
    )
      throw Error('range_worker_proof_invalid');
    const native = await readLocalRangeBoundary(
      {
        projectId: proof.projectId,
        taskId: proof.taskId,
        workerId: proof.workerId,
        sessionId: proof.sessionId,
        safePointRef: proof.safePointRef,
      },
      {
        objects: {
          get: this.options.objects.get.bind(this.options.objects),
          references: async () => [
            { key: record.nativeBoundaryId.slice(8), valueHash: record.nativeBoundaryHash },
          ],
        },
        tasks: { load: async () => structuredClone(state) },
        isActive: () => false,
      },
    );
    // isActive=false only checks the immutable close-time snapshot here; actual
    // capability closure was required by native() before the record was published.
    if (
      native !== record.nativeBoundaryId ||
      localRecordHash(
        await this.options.official({
          projectId: proof.projectId,
          taskId: proof.taskId,
          workerId: proof.workerId,
          sessionId: proof.sessionId,
          safePointRef: proof.safePointRef,
        }),
      ) !== localRecordHash(record.official)
    )
      throw Error('range_worker_proof_invalid');
  }
}
