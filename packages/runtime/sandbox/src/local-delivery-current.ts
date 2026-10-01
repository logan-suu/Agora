/** Read-only direct-directory U capture. The caller owns task serialization;
 * this port creates no grant, claim, worker, command or delivery permission. */
import type { AppState, WorkspaceVersionV1 } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalClaimRecord, LocalRegistryRecords } from './local-registry-records';
import { localRecordHash } from './local-registry-records';
import type { LocalVersionScope, LocalVersionStore } from './local-version-store';
import { localRootBinding } from './local-workspace-authority';

type Scope = { projectId: string; taskId: string };
type Control = Pick<LocalBindingCoordinator, 'assertClosed' | 'snapshot'>;
export interface LocalDirectDeliveryCurrent {
  scope: LocalVersionScope;
  grantId: string;
  grantRevision: number;
  goal: 'apply_to_directory' | 'artifact_only';
  version: Extract<WorkspaceVersionV1, { kind: 'files' }>;
  sourceReceiptId: string;
}

function select(state: AppState, registry: LocalRegistryRecords, scope: Scope) {
  const execution = state.localExecution;
  const delivery = execution?.delivery;
  if (
    state.projectId !== scope.projectId ||
    state.taskId !== scope.taskId ||
    !execution ||
    !delivery ||
    execution.git !== undefined ||
    !execution.rootIds.includes(delivery.rootId)
  )
    throw Error('delivery_direct_source_unavailable');
  const workspaces = execution.workspaces.filter(
    (workspace) =>
      workspace.projectId === scope.projectId &&
      workspace.taskId === scope.taskId &&
      workspace.rootId === delivery.rootId &&
      workspace.mode === 'direct',
  );
  const grantIds = [...new Set(workspaces.map((workspace) => workspace.grantId))];
  if (workspaces.length === 0 || grantIds.length !== 1) throw Error('delivery_grant_ambiguous');
  const grantId = grantIds[0];
  const root = registry.roots.find(
    (entry) => entry.projectId === scope.projectId && entry.rootId === delivery.rootId,
  );
  const grant = registry.grants.find(
    (entry) =>
      entry.projectId === scope.projectId &&
      entry.rootId === delivery.rootId &&
      entry.grantId === grantId,
  );
  if (
    !root ||
    !grant ||
    grant.status !== 'active' ||
    !grant.actions.includes('read') ||
    workspaces.some(
      (workspace) =>
        registry.workspaces.filter(
          (record) => localRecordHash(record) === localRecordHash(workspace),
        ).length !== 1,
    )
  )
    throw Error('delivery_direct_source_unavailable');
  const retained = registry.claims.filter(
    (claim) =>
      claim.status !== 'released' &&
      registry.workspaces.some(
        (workspace) =>
          workspace.workspaceId === claim.workspaceId &&
          workspace.projectId === claim.projectId &&
          registry.roots.some(
            (claimedRoot) =>
              claimedRoot.projectId === workspace.projectId &&
              claimedRoot.rootId === workspace.rootId &&
              claimedRoot.volumeId === root.volumeId &&
              claimedRoot.dev === root.dev &&
              claimedRoot.inode === root.inode,
          ),
      ),
  );
  if (
    retained.some(
      (claim) =>
        claim.projectId !== scope.projectId ||
        claim.taskId !== scope.taskId ||
        claim.status !== 'active' ||
        claim.kind !== undefined,
    )
  )
    throw Error('delivery_direct_source_unavailable');
  return { root, grant, goal: delivery.goal, retained };
}

export class LocalDirectDeliveryCurrentSource {
  constructor(
    private readonly control: Control,
    private readonly versions: LocalVersionStore,
    private readonly verifyGrant: (scope: Scope, grantId: string) => Promise<void>,
    private readonly verifyClosedClaim?: (scope: Scope, claim: LocalClaimRecord) => Promise<string>,
  ) {}

  async capture(scope: Scope): Promise<LocalDirectDeliveryCurrent> {
    const state = await this.control.assertClosed(scope);
    const registry = await this.control.snapshot();
    const selected = select(state, registry, scope);
    const stateHash = localRecordHash(state);
    const registryHash = localRecordHash(registry);
    const versionScope: LocalVersionScope = {
      ...scope,
      rootId: selected.root.rootId,
      policyHash: selected.grant.policyHash,
    };
    const authorize = async () => {
      await this.verifyGrant(scope, selected.grant.grantId);
      for (const claim of selected.retained) {
        if (!this.verifyClosedClaim) throw Error('delivery_direct_source_unavailable');
        await this.verifyClosedClaim(scope, claim);
      }
      return (
        localRecordHash(await this.control.assertClosed(scope)) === stateHash &&
        localRecordHash(await this.control.snapshot()) === registryHash
      );
    };
    if (!(await authorize())) throw Error('delivery_direct_source_changed');
    const version = await this.versions.capture(
      versionScope,
      localRootBinding(selected.root),
      authorize,
    );
    if (version.kind !== 'files' || !(await authorize()))
      throw Error('delivery_direct_source_changed');
    return {
      scope: versionScope,
      grantId: selected.grant.grantId,
      grantRevision: selected.grant.revision,
      goal: selected.goal,
      version,
      sourceReceiptId: version.manifestId,
    };
  }
}
