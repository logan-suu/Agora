/** Read actual host activity and retained native closure before preparing a
 * control writer. Idle canonical labels alone never establish quiescence. */
import type { AppState } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalRangePhysical } from './local-range-records';
import { deriveLocalRangeTargets, type LocalRangeTargets } from './local-range-targets';
import {
  type LocalClaimRecord,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';
import { localWorkspaceOperationActivity } from './local-workspace-operation';
import type { WorkspaceRangeActivity } from './workspace-range-port';

type Scope = { projectId: string; taskId: string };
type Options = {
  control: Pick<LocalBindingCoordinator, 'snapshot' | 'assertClosed'>;
  objects: LocalControlObjects;
  /** Combines the actual global scheduler and every live task runtime. */
  activity(scope: Scope): WorkspaceRangeActivity;
  capabilities(scope: Scope): { workerId: string }[];
  operations(scope: Scope & { workspaceId: string }): Promise<unknown>;
  /** Requires native close and official Harness closure for started workers. */
  workerClosure(claim: LocalClaimRecord, state: AppState): Promise<string>;
  controlClosure(claim: LocalClaimRecord): Promise<string>;
  /** Historical private evidence reader; no source, grant or process reopening. */
  verifyClosure(claim: LocalClaimRecord, state: AppState, ref: string): Promise<void>;
  runtimeClosure?(worker: LocalRangeTargets['workers'][number], state: AppState): Promise<string>;
  verifyRuntimeClosure?(
    worker: LocalRangeTargets['workers'][number],
    state: AppState,
    ref: string,
  ): Promise<void>;
};
type ClaimProof = { claimId: string; kind: 'unopened' | 'closed'; ref: string };
export type LocalQuiescentWriterRecord = {
  schemaVersion: 'local-quiescent-writers-v1';
  registryHash: string;
  stateHashes: { projectId: string; taskId: string; hash: string }[];
  targetsHash: string;
  operationProofs: { projectId: string; taskId: string; workspaceId: string; ref: string }[];
  claimProofs: ClaimProof[];
  workerProofs: { projectId: string; taskId: string; workerId: string; ref: string }[];
};
const key = (scope: Scope) => `${scope.projectId}/${scope.taskId}`;
function fail(): never {
  throw Error('workspace_writer_proof_invalid');
}
export class LocalQuiescentWriters {
  constructor(private readonly options: Options) {}
  private async current(physical: LocalRangePhysical) {
    const registry = await this.options.control.snapshot();
    if (registry.operations.some((o) => o.stage === 'prepared'))
      throw Error('registry_recovery_required');
    const states: AppState[] = [];
    for (const scope of new Map(
      registry.workspaces.map((w) => [
        key(w),
        {
          projectId: w.projectId,
          taskId: w.taskId,
        },
      ]),
    ).values())
      states.push(await this.options.control.assertClosed(scope));
    const targets = deriveLocalRangeTargets(registry, states, physical);
    this.assertIdle(targets, states, registry.workspaces);
    return { registry, states, targets };
  }
  private assertIdle(
    targets: LocalRangeTargets,
    states: AppState[],
    workspaces: { projectId: string; taskId: string; workspaceId: string }[],
  ) {
    if (targets.cohort.length) throw Error('workspace_writer_still_active');
    for (const scope of targets.tasks) {
      const selected = new Set(
          targets.workers.filter((w) => key(w) === key(scope)).map((w) => w.workerId),
        ),
        known = new Set(states.find((s) => key(s) === key(scope))?.workers.map((w) => w.workerId)),
        knownWorkspaces = new Set(
          workspaces.filter((w) => key(w) === key(scope)).map((w) => w.workspaceId),
        ),
        activity = this.options.activity(scope);
      if (
        key(activity) !== key(scope) ||
        [activity.activeWorkerIds, activity.leasedWorkerIds, activity.queuedWorkerIds].some(
          (ids) =>
            !Array.isArray(ids) ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => typeof id !== 'string' || selected.has(id) || !known.has(id)),
        ) ||
        this.options
          .capabilities(scope)
          .some((c) => selected.has(c.workerId) || !known.has(c.workerId)) ||
        localWorkspaceOperationActivity(scope).some(
          (o) => scope.workspaceIds.includes(o.workspaceId) || !knownWorkspaces.has(o.workspaceId),
        )
      )
        throw Error('workspace_writer_still_active');
    }
  }
  private unopened(claim: LocalClaimRecord, state: AppState): boolean {
    const worker = state.workers.find((w) => w.workerId === claim.workerId);
    return (
      claim.kind === undefined &&
      !!worker &&
      worker.status === 'pending' &&
      !worker.sessionId &&
      !worker.safePoint
    );
  }
  async capture(physical: LocalRangePhysical) {
    const { objects } = this.options,
      current = await this.current(physical),
      operationProofs: LocalQuiescentWriterRecord['operationProofs'] = [],
      claimProofs: ClaimProof[] = [],
      workerProofs: LocalQuiescentWriterRecord['workerProofs'] = [];
    for (const scope of current.targets.tasks)
      for (const workspaceId of scope.workspaceIds) {
        const input = { projectId: scope.projectId, taskId: scope.taskId, workspaceId };
        operationProofs.push({
          ...input,
          ref: await objects.put(await this.options.operations(input)),
        });
      }
    for (const worker of current.targets.workers) {
      const state = current.states.find((s) => key(s) === key(worker));
      if (!state) fail();
      if (worker.status === 'pending' && worker.sessionId === null) continue;
      if (!this.options.runtimeClosure || !this.options.verifyRuntimeClosure) fail();
      const ref = await this.options.runtimeClosure(worker, state);
      await this.options.verifyRuntimeClosure(worker, state, ref);
      workerProofs.push({
        projectId: worker.projectId,
        taskId: worker.taskId,
        workerId: worker.workerId,
        ref,
      });
    }
    for (const claim of current.targets.claims.filter((c) => c.status !== 'released')) {
      const state = current.states.find((s) => key(s) === key(claim));
      if (!state) fail();
      if (this.unopened(claim, state)) {
        claimProofs.push({
          claimId: claim.claimId,
          kind: 'unopened',
          ref: await objects.put({
            schemaVersion: 'local-unopened-writer-v1',
            claim,
            worker: state.workers.find((w) => w.workerId === claim.workerId),
            operationProofs: operationProofs.filter(
              (o) => key(o) === key(claim) && o.workspaceId === claim.workspaceId,
            ),
          }),
        });
      } else {
        const ref = claim.kind
          ? await this.options.controlClosure(claim)
          : await this.options.workerClosure(claim, state);
        await this.options.verifyClosure(claim, state, ref);
        claimProofs.push({ claimId: claim.claimId, kind: 'closed', ref });
      }
    }
    const record: LocalQuiescentWriterRecord = {
      schemaVersion: 'local-quiescent-writers-v1',
      registryHash: await objects.put(current.registry),
      stateHashes: await Promise.all(
        current.states.map(async (s) => ({
          projectId: s.projectId,
          taskId: s.taskId,
          hash: await objects.put(s),
        })),
      ),
      targetsHash: await objects.put(current.targets),
      operationProofs,
      claimProofs,
      workerProofs,
    };
    const again = await this.current(physical);
    if (
      localRecordHash(again.registry) !== record.registryHash ||
      localRecordHash(again.states) !== localRecordHash(current.states)
    )
      throw Error('workspace_writer_source_changed');
    const hash = await objects.put(record);
    await this.read(hash);
    return { record, hash, targets: current.targets };
  }
  async read(hash: string): Promise<LocalQuiescentWriterRecord> {
    const { objects } = this.options,
      record = (await objects.get(hash)) as LocalQuiescentWriterRecord;
    if (
      !record ||
      Object.keys(record).sort().join(',') !==
        'claimProofs,operationProofs,registryHash,schemaVersion,stateHashes,targetsHash,workerProofs' ||
      record.schemaVersion !== 'local-quiescent-writers-v1' ||
      !Array.isArray(record.stateHashes) ||
      !Array.isArray(record.operationProofs) ||
      !Array.isArray(record.claimProofs) ||
      !Array.isArray(record.workerProofs)
    )
      fail();
    const registry = parseLocalRegistry(await objects.get(record.registryHash)),
      states: AppState[] = [];
    for (const ref of record.stateHashes) {
      const state = (await objects.get(ref.hash)) as AppState;
      if (!state || key(state) !== key(ref)) fail();
      states.push(state);
    }
    const targets = (await objects.get(record.targetsHash)) as LocalRangeTargets;
    if (
      localRecordHash(deriveLocalRangeTargets(registry, states, targets.physical)) !==
        record.targetsHash ||
      targets.cohort.length
    )
      fail();
    const expectedOperations = targets.tasks.flatMap((t) =>
      t.workspaceIds.map((workspaceId) => ({
        projectId: t.projectId,
        taskId: t.taskId,
        workspaceId,
      })),
    );
    if (
      localRecordHash(record.operationProofs.map(({ ref: _, ...scope }) => scope)) !==
        localRecordHash(expectedOperations) ||
      localRecordHash(record.claimProofs.map((p) => p.claimId)) !==
        localRecordHash(targets.claims.filter((c) => c.status !== 'released').map((c) => c.claimId))
    )
      fail();
    for (const ref of record.operationProofs) await objects.get(ref.ref);
    const started = targets.workers.filter((w) => w.status !== 'pending' || w.sessionId !== null);
    if (
      localRecordHash(record.workerProofs.map(({ ref: _, ...scope }) => scope)) !==
      localRecordHash(
        started.map((w) => ({ projectId: w.projectId, taskId: w.taskId, workerId: w.workerId })),
      )
    )
      fail();
    for (const proof of record.workerProofs) {
      const worker = started.find((w) => key(w) === key(proof) && w.workerId === proof.workerId),
        state = states.find((s) => key(s) === key(proof));
      if (!worker || !state || !this.options.verifyRuntimeClosure) fail();
      await this.options.verifyRuntimeClosure(worker, state, proof.ref);
    }
    for (const proof of record.claimProofs) {
      const claim = targets.claims.find((c) => c.claimId === proof.claimId),
        state = states.find((s) => key(s) === key(claim as LocalClaimRecord));
      if (!claim || !state || Object.keys(proof).sort().join(',') !== 'claimId,kind,ref') fail();
      if (proof.kind === 'unopened') {
        if (
          !this.unopened(claim, state) ||
          localRecordHash(await objects.get(proof.ref)) !==
            localRecordHash({
              schemaVersion: 'local-unopened-writer-v1',
              claim,
              worker: state.workers.find((w) => w.workerId === claim.workerId),
              operationProofs: record.operationProofs.filter(
                (o) => key(o) === key(claim) && o.workspaceId === claim.workspaceId,
              ),
            })
        )
          fail();
      } else if (proof.kind === 'closed') await this.options.verifyClosure(claim, state, proof.ref);
      else fail();
    }
    return structuredClone(record);
  }
  async verifyCurrent(hash: string) {
    const record = await this.read(hash),
      targets = (await this.options.objects.get(record.targetsHash)) as LocalRangeTargets,
      current = await this.current(targets.physical);
    if (
      localRecordHash(current.registry) !== record.registryHash ||
      localRecordHash(current.targets) !== record.targetsHash ||
      localRecordHash(
        current.states.map((s) => ({
          projectId: s.projectId,
          taskId: s.taskId,
          hash: localRecordHash(s),
        })),
      ) !== localRecordHash(record.stateHashes)
    )
      throw Error('workspace_writer_source_changed');
  }
}
