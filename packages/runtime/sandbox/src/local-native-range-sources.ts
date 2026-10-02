/** Native fixed-root source capture plus immutable historical reconciliation.
 * Runtime/session and control-writer proofs are mandatory host-owned companions;
 * this class cannot manufacture them from registry labels or process absence. */
import { type AppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import { localWorkspacePhysical } from './local-range-admission';
import type { LocalRangeSources } from './local-range-controller';
import {
  type LocalRangeCanonicalProof,
  type LocalRangeHeldProof,
  type LocalRangeSourceProof,
  type LocalRangeWorkerProof,
  localRangeSourceKey,
} from './local-range-evidence';
import { type LocalRangePlan, localRangesOverlap } from './local-range-records';
import { deriveLocalRangeTargets, type LocalRangeTargets } from './local-range-targets';
import {
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';
import { inspectSelectedLocalRoot } from './local-root-inspection';
import type { LocalVersionStore } from './local-version-store';
import { localRootBinding } from './local-workspace-authority';

type Scope = { projectId: string; taskId: string };
type Options = {
  control: Pick<LocalBindingCoordinator, 'snapshot' | 'assertClosed'>;
  objects: LocalControlObjects;
  versions: LocalVersionStore;
  tasks: { load(scope: Scope): Promise<AppState | undefined> };
  inspector: string;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  /** Exact owned Git common-dir/path/branch/HEAD identity, not path existence. */
  verifyLinked(plan: LocalRangePlan, registry: LocalRegistryRecords): Promise<void>;
  verifyWorkerClosure(plan: LocalRangePlan, proof: LocalRangeWorkerProof): Promise<void>;
  verifyWritersClosure(
    plan: LocalRangePlan,
    proof: LocalRangeHeldProof,
    targets: LocalRangeTargets,
  ): Promise<void>;
};
export class LocalNativeRangeSources implements LocalRangeSources {
  constructor(private readonly options: Options) {}
  private async task(scope: Scope) {
    const state = await this.options.tasks.load(scope);
    if (
      !state ||
      state.projectId !== scope.projectId ||
      state.taskId !== scope.taskId ||
      !state.localExecution
    )
      throw Error('range_control_source_invalid');
    return state;
  }
  private async historical(plan: LocalRangePlan, proof: LocalRangeSourceProof) {
    if (
      proof.schemaVersion !== 'local-range-source-v1' ||
      proof.planHash !== localRecordHash(plan) ||
      proof.manifestHash !== plan.startVersion.manifestHash
    )
      throw Error('range_control_source_invalid');
    const registry = parseLocalRegistry(await this.options.objects.get(proof.registryHash));
    if (registry.revision !== plan.expectedRevision) throw Error('range_control_source_invalid');
    const states: AppState[] = [];
    for (const ref of proof.taskStateHashes) {
      const state = (await this.options.objects.get(ref.hash)) as AppState;
      if (
        !state ||
        state.projectId !== ref.projectId ||
        state.taskId !== ref.taskId ||
        localRecordHash(state) !== ref.hash
      )
        throw Error('range_control_source_invalid');
      states.push(state);
    }
    const targets = deriveLocalRangeTargets(registry, states, plan.physical);
    if (
      localRecordHash(targets) !== proof.targetFactsHash ||
      localRecordHash(await this.options.objects.get(proof.targetFactsHash)) !==
        localRecordHash(targets) ||
      localRecordHash(targets.cohort) !== localRecordHash(plan.cohort)
    )
      throw Error('range_control_source_invalid');
    const workspace = registry.workspaces.find(
      (w) =>
        w.workspaceId === plan.workspaceId &&
        w.projectId === plan.projectId &&
        w.taskId === plan.taskId,
    );
    const grant = registry.grants.find(
      (g) => g.grantId === plan.grantId && g.projectId === plan.projectId,
    );
    const intent = parseWorkspaceControl(plan.sourceMessage.display);
    if (
      !workspace ||
      workspace.rootId !== plan.rootId ||
      workspace.grantId !== plan.grantId ||
      localRecordHash(localWorkspacePhysical(registry, workspace)) !==
        localRecordHash(plan.physical) ||
      grant?.status !== 'active' ||
      grant.revision !== plan.grantRevision ||
      !grant.actions.includes('read') ||
      intent?.verb !== 'takeover' ||
      localRecordHash(intent.paths) !== localRecordHash(plan.requestedPaths)
    )
      throw Error('range_control_source_invalid');
    const physical =
      workspace.mode === 'linked-worktree'
        ? registry.linkedRoots?.find((r) => r.workspaceId === workspace.workspaceId)
        : registry.roots.find((r) => r.rootId === workspace.rootId);
    const manifest = await this.options.versions.read(plan.startVersion, {
      projectId: plan.projectId,
      taskId: plan.taskId,
      rootId: plan.rootId,
      policyHash: grant.policyHash,
    });
    if (!physical || manifest.bindingHash !== localRecordHash(localRootBinding(physical)))
      throw Error('range_control_source_invalid');
    return { registry, states, targets };
  }
  async prepare(scope: Scope, message: Message) {
    const intent = parseWorkspaceControl(message.display);
    if (
      intent?.verb !== 'takeover' ||
      intent.projectId !== scope.projectId ||
      intent.taskId !== scope.taskId
    )
      throw Error('range_control_source_invalid');
    const registry = await this.options.control.snapshot();
    if (
      registry.revision !== intent.expectedRevision ||
      registry.operations.some((o) => o.stage === 'prepared')
    )
      throw Error('registry_recovery_required');
    const workspace = registry.workspaces.find(
      (w) =>
        w.workspaceId === intent.workspaceId &&
        w.projectId === scope.projectId &&
        w.taskId === scope.taskId,
    );
    if (!workspace) throw Error('workspace_scope_mismatch');
    const physical = localWorkspacePhysical(registry, workspace);
    if (
      registry.rangeHolds?.some(
        (h) => h.stage !== 'released' && localRangesOverlap(h.plan.physical, physical),
      )
    )
      throw Error('file_taken_over');
    const states: AppState[] = [];
    for (const task of new Map(
      registry.workspaces.map((w) => [
        `${w.projectId}/${w.taskId}`,
        { projectId: w.projectId, taskId: w.taskId },
      ]),
    ).values())
      states.push(await this.options.control.assertClosed(task));
    const targets = deriveLocalRangeTargets(registry, states, physical);
    const grant = registry.grants.find(
      (g) => g.grantId === workspace.grantId && g.projectId === scope.projectId,
    );
    const root =
      workspace.mode === 'linked-worktree'
        ? registry.linkedRoots?.find((r) => r.workspaceId === workspace.workspaceId)
        : registry.roots.find((r) => r.rootId === workspace.rootId);
    if (grant?.status !== 'active' || !root) throw Error('authorization_closed');
    const check = async () => {
      await this.options.verifyGrant(scope, grant.grantId);
      return localRecordHash(await this.options.control.snapshot()) === localRecordHash(registry);
    };
    const startVersion = await this.options.versions.capture(
      { ...scope, rootId: workspace.rootId, policyHash: grant.policyHash },
      localRootBinding(root),
      check,
    );
    const plan: LocalRangePlan = {
      schemaVersion: 'local-range-plan-v1',
      takeoverId: `takeover:${intent.actionId}`,
      ...scope,
      workspaceId: workspace.workspaceId,
      rootId: workspace.rootId,
      grantId: grant.grantId,
      grantRevision: grant.revision,
      expectedRevision: registry.revision,
      sourceMessage: structuredClone(message),
      requestedPaths: [...intent.paths],
      effectiveScope: 'workspace',
      physical,
      startVersion,
      cohort: targets.cohort,
    };
    await this.verifyCurrentRootAndGrant(plan);
    const proof: LocalRangeSourceProof = {
      schemaVersion: 'local-range-source-v1',
      planHash: localRecordHash(plan),
      registryHash: await this.options.objects.put(registry),
      taskStateHashes: await Promise.all(
        states.map(async (s) => ({
          projectId: s.projectId,
          taskId: s.taskId,
          hash: await this.options.objects.put(s),
        })),
      ),
      manifestHash: startVersion.manifestHash,
      targetFactsHash: await this.options.objects.put(targets),
    };
    await this.verifySource(plan, proof);
    if (!(await check())) throw Error('registry_revision_conflict');
    // Recheck canonical assignments/control facts before barrier publication. Step
    // completion during capture requires a new explicit request, never a new cohort.
    for (const old of states)
      if (localRecordHash(await this.task(old)) !== localRecordHash(old))
        throw Error('range_control_source_changed');
    return { plan, proof };
  }
  async verifySource(plan: LocalRangePlan, proof: LocalRangeSourceProof) {
    await this.historical(plan, proof);
  }
  async verifyCanonical(plan: LocalRangePlan, proof: LocalRangeCanonicalProof) {
    if (
      proof.planHash !== localRecordHash(plan) ||
      proof.messageHash !== localRecordHash(plan.sourceMessage) ||
      (await this.options.objects.getReference(localRangeSourceKey(plan))) !== proof.sourceRef
    )
      throw Error('workspace_control_source_invalid');
    const state = await this.task(plan),
      messages = state.messages.filter((m) => m.msgId === plan.sourceMessage.msgId);
    if (messages.length !== 1 || localRecordHash(messages[0]) !== proof.messageHash)
      throw Error('workspace_control_source_invalid');
  }
  async verifyWorker(plan: LocalRangePlan, proof: LocalRangeWorkerProof) {
    await this.options.verifyWorkerClosure(plan, proof);
  }
  async verifyWriters(plan: LocalRangePlan, proof: LocalRangeHeldProof) {
    const source = (await this.options.objects.get(proof.sourceRef)) as LocalRangeSourceProof;
    const { targets } = await this.historical(plan, source);
    await this.options.verifyWritersClosure(plan, proof, targets);
  }
  async verifyCurrentRootAndGrant(plan: LocalRangePlan) {
    const registry = await this.options.control.snapshot();
    if (registry.operations.some((o) => o.stage === 'prepared'))
      throw Error('registry_recovery_required');
    const workspace = registry.workspaces.find(
      (w) =>
        w.workspaceId === plan.workspaceId &&
        w.projectId === plan.projectId &&
        w.taskId === plan.taskId &&
        w.rootId === plan.rootId &&
        w.grantId === plan.grantId,
    );
    const grant = registry.grants.find(
      (g) =>
        g.grantId === plan.grantId && g.projectId === plan.projectId && g.rootId === plan.rootId,
    );
    if (
      !workspace ||
      grant?.status !== 'active' ||
      grant.revision !== plan.grantRevision ||
      localRecordHash(localWorkspacePhysical(registry, workspace)) !==
        localRecordHash(plan.physical)
    )
      throw Error('authorization_closed');
    await this.options.verifyGrant(plan, plan.grantId);
    const root =
      workspace.mode === 'linked-worktree'
        ? registry.linkedRoots?.find((r) => r.workspaceId === workspace.workspaceId)
        : registry.roots.find((r) => r.rootId === workspace.rootId);
    if (
      !root ||
      localRecordHash(inspectSelectedLocalRoot(root.path, this.options.inspector)) !==
        root.inspectionHash
    )
      throw Error('root_identity_changed');
    if (workspace.mode === 'linked-worktree') await this.options.verifyLinked(plan, registry);
    if ((await this.options.control.snapshot()).revision !== registry.revision)
      throw Error('registry_revision_conflict');
  }
}
