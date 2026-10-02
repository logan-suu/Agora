/** Trusted closure inventory. Host activity, native journals and close-time
 * versions remain separate facts; none is inferred from a PID or status label. */
import type { AppState, WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type {
  LocalRangeHeldProof,
  LocalRangeSourceProof,
  LocalRangeWorkerProof,
} from './local-range-evidence';
import type { LocalRangeHold, LocalRangePlan } from './local-range-records';
import { deriveLocalRangeTargets, type LocalRangeTargets } from './local-range-targets';
import {
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';
import type { LocalVersionStore } from './local-version-store';
import { localRootBinding } from './local-workspace-authority';
import { localWorkspaceOperationActivity } from './local-workspace-operation';
import type { WorkspaceRangeActivity } from './workspace-range-port';

type Scope = { projectId: string; taskId: string };
type Options = {
  control: Pick<LocalBindingCoordinator, 'snapshot' | 'assertClosed'>;
  objects: LocalControlObjects;
  versions: LocalVersionStore;
  tasks: { load(scope: Scope): Promise<AppState | undefined> };
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  capabilities(
    scope: Scope,
  ): { workerId: string; sessionId: string; closing: boolean; fileCapabilities: boolean }[];
  /** Must combine the actual global lease collection and every live task runtime. */
  activity(scope: Scope): WorkspaceRangeActivity;
  operations(scope: Scope & { workspaceId: string }): Promise<unknown>;
  /** Requires actual native tree/control closure; a claim label is insufficient. */
  controlWriter(claim: LocalRegistryRecords['claims'][number]): Promise<string>;
  /** Already stopped workers outside the active request cohort also need their
   * native close boundary, not only a canonical done/paused label. */
  dormantWorker?(
    scope: Scope & { workerId: string; sessionId: string; safePointRef: string },
  ): Promise<string>;
};
type Record = {
  schemaVersion: 'local-range-writers-closed-v1';
  planHash: string;
  sourceRef: string;
  targetsHash: string;
  closedTargetsHash: string;
  registryHash: string;
  taskStateHashes: { projectId: string; taskId: string; hash: string }[];
  workerProofHashes: string[];
  operationProofs: { projectId: string; taskId: string; workspaceId: string; hash: string }[];
  controlProofs: { claimId: string; hash: string }[];
  dormantProofs: { projectId: string; taskId: string; workerId: string; hash: string }[];
  heldVersion: WorkspaceVersionV1;
};
const slot = (plan: LocalRangePlan) =>
  localRecordHash({ kind: 'local-range-writers', planHash: localRecordHash(plan) });
const workerKey = (w: Scope & { workerId: string }) => `${w.projectId}/${w.taskId}/${w.workerId}`;
const stableTargets = (targets: LocalRangeTargets) => ({
  physical: targets.physical,
  tasks: targets.tasks.map(({ stateHash: _, ...t }) => t),
  workers: targets.workers.map(({ status: _, ...w }) => w),
  claims: targets.claims.map(({ status: _, closureReceiptId: __, ...c }) => c),
});
export class LocalRangeWritersEvidence {
  constructor(private readonly options: Options) {}
  private async targets(registry: LocalRegistryRecords, plan: LocalRangePlan) {
    const states: AppState[] = [];
    for (const scope of new Map(
      registry.workspaces.map((w) => [
        `${w.projectId}/${w.taskId}`,
        { projectId: w.projectId, taskId: w.taskId },
      ]),
    ).values()) {
      const state = await this.options.control.assertClosed(scope);
      if (!state.localExecution) throw Error('range_writer_proof_invalid');
      states.push(state);
    }
    return { targets: deriveLocalRangeTargets(registry, states, plan.physical), states };
  }
  private activity(targets: LocalRangeTargets, states: AppState[], registry: LocalRegistryRecords) {
    for (const scope of targets.tasks) {
      const selected = new Set(
        targets.workers
          .filter((w) => w.projectId === scope.projectId && w.taskId === scope.taskId)
          .map((w) => w.workerId),
      );
      const known = new Set(
        states
          .find((s) => s.projectId === scope.projectId && s.taskId === scope.taskId)
          ?.workers.map((w) => w.workerId),
      );
      const knownWorkspaces = new Set(
        registry.workspaces
          .filter((w) => w.projectId === scope.projectId && w.taskId === scope.taskId)
          .map((w) => w.workspaceId),
      );
      const activity = this.options.activity({ projectId: scope.projectId, taskId: scope.taskId });
      if (
        activity.projectId !== scope.projectId ||
        activity.taskId !== scope.taskId ||
        [activity.activeWorkerIds, activity.leasedWorkerIds, activity.queuedWorkerIds].some(
          (ids) =>
            !Array.isArray(ids) ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => typeof id !== 'string' || selected.has(id) || !known.has(id)),
        )
      )
        throw Error('range_writer_still_active');
      // Unregistered synthetic control operations have no proven independent scope.
      if (
        this.options
          .capabilities(scope)
          .some((c) => selected.has(c.workerId) || !known.has(c.workerId))
      )
        throw Error('range_writer_still_active');
      const operations = localWorkspaceOperationActivity(scope);
      if (
        operations.some(
          (o) => scope.workspaceIds.includes(o.workspaceId) || !knownWorkspaces.has(o.workspaceId),
        )
      )
        throw Error('range_writer_still_active');
    }
  }
  private async current(plan: LocalRangePlan, original: LocalRangeTargets) {
    const registry = await this.options.control.snapshot();
    const hold = registry.rangeHolds?.find((h) => h.plan.takeoverId === plan.takeoverId);
    if (
      !hold ||
      hold.planHash !== localRecordHash(plan) ||
      hold.controlStage !== 'committed' ||
      hold.stage === 'released' ||
      registry.operations.some((o) => o.stage === 'prepared')
    )
      throw Error('range_writer_proof_invalid');
    const { targets, states } = await this.targets(registry, plan);
    if (
      localRecordHash(stableTargets(targets)) !== localRecordHash(stableTargets(original)) ||
      targets.cohort.length
    )
      throw Error('range_writer_source_changed');
    this.activity(targets, states, registry);
    return { registry, targets, states };
  }
  async prove(
    hold: LocalRangeHold,
    sourceRef: string,
    workers: readonly LocalRangeWorkerProof[],
  ): Promise<string> {
    const plan = hold.plan;
    if (
      hold.planHash !== localRecordHash(plan) ||
      workers.length !== plan.cohort.length ||
      workers.some(
        (w) =>
          w.planHash !== hold.planHash ||
          w.sourceRef !== sourceRef ||
          !w.closed ||
          !w.leaseReleased,
      )
    )
      throw Error('range_writer_proof_invalid');
    const source = (await this.options.objects.get(sourceRef)) as LocalRangeSourceProof;
    if (source.planHash !== hold.planHash) throw Error('range_writer_proof_invalid');
    const original = (await this.options.objects.get(source.targetFactsHash)) as LocalRangeTargets;
    const { registry, targets, states } = await this.current(plan, original);
    const operationProofs: Record['operationProofs'] = [],
      controlProofs: Record['controlProofs'] = [],
      dormantProofs: Record['dormantProofs'] = [];
    for (const task of targets.tasks)
      for (const workspaceId of task.workspaceIds) {
        const scope = { projectId: task.projectId, taskId: task.taskId, workspaceId };
        operationProofs.push({
          ...scope,
          hash: await this.options.objects.put(await this.options.operations(scope)),
        });
      }
    for (const claim of targets.claims) {
      if (claim.kind) {
        const hash = await this.options.controlWriter(claim);
        await this.options.objects.get(hash);
        controlProofs.push({ claimId: claim.claimId, hash });
      } else {
        const w = targets.workers.find((w) => workerKey(w) === workerKey(claim));
        if (!w || w.status === 'running') throw Error('range_writer_proof_invalid');
        if (
          !plan.cohort.some((c) => workerKey(c) === workerKey(w)) &&
          (w.status !== 'pending' || w.sessionId !== null)
        ) {
          const state = await this.options.control.assertClosed(w),
            worker = state.workers.find((c) => c.workerId === w.workerId);
          if (!worker?.sessionId || !worker.safePoint || !this.options.dormantWorker)
            throw Error('range_writer_proof_invalid');
          const hash = await this.options.dormantWorker({
            ...w,
            sessionId: worker.sessionId,
            safePointRef: worker.safePoint,
          });
          await this.options.objects.get(hash);
          dormantProofs.push({
            projectId: w.projectId,
            taskId: w.taskId,
            workerId: w.workerId,
            hash,
          });
        }
      }
    }
    const workspace = registry.workspaces.find(
      (w) =>
        w.workspaceId === plan.workspaceId &&
        w.projectId === plan.projectId &&
        w.taskId === plan.taskId,
    );
    const root =
      workspace?.mode === 'linked-worktree'
        ? registry.linkedRoots?.find((r) => r.workspaceId === plan.workspaceId)
        : registry.roots.find((r) => r.rootId === plan.rootId);
    const grant = registry.grants.find(
      (g) => g.grantId === plan.grantId && g.projectId === plan.projectId,
    );
    if (!root || grant?.status !== 'active' || grant.revision !== plan.grantRevision)
      throw Error('authorization_closed');
    const check = async () => {
      await this.options.verifyGrant(plan, plan.grantId);
      const current = await this.current(plan, original);
      return localRecordHash(current.registry) === localRecordHash(registry);
    };
    const heldVersion = await this.options.versions.capture(
      {
        policyHash: grant.policyHash,
        projectId: plan.projectId,
        taskId: plan.taskId,
        rootId: plan.rootId,
      },
      localRootBinding(root),
      check,
    );
    // Capture scope is deliberately exact; plan fields never become file authority.
    const record: Record = {
      schemaVersion: 'local-range-writers-closed-v1',
      planHash: hold.planHash,
      sourceRef,
      targetsHash: source.targetFactsHash,
      closedTargetsHash: await this.options.objects.put(targets),
      registryHash: await this.options.objects.put(registry),
      taskStateHashes: await Promise.all(
        states.map(async (s) => ({
          projectId: s.projectId,
          taskId: s.taskId,
          hash: await this.options.objects.put(s),
        })),
      ),
      workerProofHashes: await Promise.all(workers.map((w) => this.options.objects.put(w))),
      operationProofs,
      controlProofs,
      dormantProofs,
      heldVersion,
    };
    if (!(await check())) throw Error('range_writer_source_changed');
    const hash = await this.options.objects.put(record);
    await this.options.objects.bindReference(slot(plan), hash);
    return hash;
  }
  async read(plan: LocalRangePlan, proof: LocalRangeHeldProof) {
    const record = (await this.options.objects.get(proof.writersProofRef)) as Record;
    if (
      !record ||
      Object.keys(record).sort().join(',') !==
        'closedTargetsHash,controlProofs,dormantProofs,heldVersion,operationProofs,planHash,registryHash,schemaVersion,sourceRef,targetsHash,taskStateHashes,workerProofHashes' ||
      record.schemaVersion !== 'local-range-writers-closed-v1' ||
      record.planHash !== localRecordHash(plan) ||
      proof.planHash !== record.planHash ||
      record.sourceRef !== proof.sourceRef ||
      localRecordHash(record.workerProofHashes) !== localRecordHash(proof.workerProofs) ||
      (await this.options.objects.getReference(slot(plan))) !== proof.writersProofRef
    )
      throw Error('range_writer_proof_invalid');
    const closedRegistry = parseLocalRegistry(await this.options.objects.get(record.registryHash));
    await this.options.objects.get(record.closedTargetsHash);
    const states: AppState[] = [];
    for (const task of record.taskStateHashes) {
      const state = (await this.options.objects.get(task.hash)) as AppState;
      if (state.projectId !== task.projectId || state.taskId !== task.taskId)
        throw Error('range_writer_proof_invalid');
      states.push(state);
    }
    const derived = deriveLocalRangeTargets(closedRegistry, states, plan.physical);
    if (
      localRecordHash(derived) !== record.closedTargetsHash ||
      derived.cohort.length ||
      !Array.isArray(record.operationProofs) ||
      !Array.isArray(record.controlProofs) ||
      !Array.isArray(record.dormantProofs) ||
      localRecordHash(record.operationProofs.map(({ hash: _, ...scope }) => scope)) !==
        localRecordHash(
          derived.tasks.flatMap((t) =>
            t.workspaceIds.map((workspaceId) => ({
              projectId: t.projectId,
              taskId: t.taskId,
              workspaceId,
            })),
          ),
        ) ||
      localRecordHash(record.controlProofs.map((p) => p.claimId)) !==
        localRecordHash(derived.claims.filter((c) => c.kind).map((c) => c.claimId))
    )
      throw Error('range_writer_proof_invalid');
    return record;
  }
  async verify(plan: LocalRangePlan, proof: LocalRangeHeldProof, original: LocalRangeTargets) {
    const record = await this.read(plan, proof);
    if (localRecordHash(original) !== record.targetsHash) throw Error('range_writer_proof_invalid');
    const { registry } = await this.current(plan, original);
    for (const p of record.operationProofs)
      if (
        localRecordHash(
          await this.options.operations({
            projectId: p.projectId,
            taskId: p.taskId,
            workspaceId: p.workspaceId,
          }),
        ) !== p.hash
      )
        throw Error('range_writer_source_changed');
    for (const p of record.controlProofs) {
      const claim = registry.claims.find((c) => c.claimId === p.claimId);
      if (!claim || (await this.options.controlWriter(claim)) !== p.hash)
        throw Error('range_writer_source_changed');
    }
    for (const p of record.dormantProofs) await this.options.objects.get(p.hash);
    const grant = registry.grants.find(
      (g) => g.grantId === plan.grantId && g.projectId === plan.projectId,
    );
    if (grant?.status !== 'active' || grant.revision !== plan.grantRevision)
      throw Error('authorization_closed');
    await this.options.versions.read(record.heldVersion, {
      projectId: plan.projectId,
      taskId: plan.taskId,
      rootId: plan.rootId,
      policyHash: grant.policyHash,
    });
  }
}
