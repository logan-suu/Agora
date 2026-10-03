/** Leader-only application admission. It never borrows a model worker or an
 * integration identity. The caller holds the task's existing serial queue. */
import {
  type AppState,
  type Message,
  parseWorkspaceControl,
  type WorkspaceRefV1,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalDeliverySources } from './local-delivery-comparison-record';
import { inspectLocalRoot } from './local-file-transaction';
import { assertLocalRangeAdmission } from './local-range-admission';
import {
  assertLocalControlMessage,
  isLocalBindingOperation,
  type LocalClaimRecord,
  type LocalDeliveryClaimRecord,
  localRecordHash,
} from './local-registry-records';
import { localRootBinding } from './local-workspace-authority';

type Scope = { projectId: string; taskId: string };
export type LocalDeliveryCall = Scope & {
  claimId: string;
  workspaceId: string;
  writerEpoch: number;
  grantRevision: number;
  deliveryProposalId: string;
  inputHash: string;
};
type Proposal = { deliveryProposalId: string; inputHash: string; source: LocalDeliverySources };
type Options = {
  control: LocalBindingCoordinator;
  verifyCurrent(scope: Scope, proposalId: string, inputHash: string): Promise<Proposal>;
  /** Recheck immutable proposal and current review, without treating partially
   * changed target bytes as the original U. Native transactions prove U/C. */
  verifyBinding(scope: Scope, proposalId: string, inputHash: string): Promise<Proposal>;
  assertControl(state: AppState): Promise<void>;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  verifyTargetMetadata?(state: AppState, source: LocalDeliverySources): Promise<void>;
  verifyClosedClaim(scope: Scope, claim: LocalClaimRecord): Promise<string>;
};
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const callFor = (claim: LocalDeliveryClaimRecord): LocalDeliveryCall => ({
  projectId: claim.projectId,
  taskId: claim.taskId,
  claimId: claim.claimId,
  workspaceId: claim.workspaceId,
  writerEpoch: claim.writerEpoch,
  grantRevision: claim.grantRevision,
  deliveryProposalId: claim.deliveryProposalId,
  inputHash: claim.inputHash,
});
export class LocalDeliveryAuthority {
  private completed?: { actionId: string; proofHash: string; closureReceiptId: string };
  constructor(private readonly options: Options) {}

  /** Read-only capability for an exact committed release. It cannot reacquire a
   * claim or authorize another target mutation. Every read rechecks both stores. */
  completionReader(actionId: string, proofHash: string, closureReceiptId: string) {
    const reader = new LocalDeliveryAuthority(this.options);
    reader.completed = { actionId, proofHash, closureReceiptId };
    return reader;
  }

  async acquire(
    scope: Scope,
    input: Message,
  ): Promise<{ call: LocalDeliveryCall; replayed: boolean }> {
    if (this.completed) throw Error('delivery_application_read_only');
    scope = structuredClone(scope);
    const source = structuredClone(input);
    const intent = parseWorkspaceControl(source.display);
    if (intent?.verb !== 'apply') throw Error('workspace_control_not_available');
    assertLocalControlMessage(source, {
      ...scope,
      actionId: intent.actionId,
      sourceMessageId: source.msgId,
      expectedRevision: intent.expectedRevision,
    });
    const { control } = this.options;
    const snapshot = await control.snapshot();
    const existing = snapshot.operations.find((o) => o.actionId === source.msgId);
    if (existing) {
      const claim = snapshot.claims.find(
        (c) => c.createdActionId === source.msgId && c.kind === 'delivery',
      );
      if (
        !isLocalBindingOperation(existing) ||
        !existing.sourceMessage ||
        existing.projectId !== scope.projectId ||
        existing.taskId !== scope.taskId ||
        existing.preparedRevision !== intent.expectedRevision + 1 ||
        existing.deliveryTransition?.kind !== 'delivery-application-start-v1' ||
        !equal(existing.sourceMessage, { ...source, ts: existing.sourceMessage.ts }) ||
        claim?.kind !== 'delivery' ||
        claim.deliveryProposalId !== intent.deliveryProposalId ||
        claim.inputHash !== intent.inputHash
      )
        throw Error('operation_conflict');
      // Only close the registry half when the exact State fact already exists.
      // A merely prepared request cannot regain target access through replay.
      await control.recoverCommittedDelivery(existing.actionId, existing.inputHash);
      return { call: callFor(claim), replayed: true };
    }
    if (snapshot.revision !== intent.expectedRevision) throw Error('registry_revision_conflict');
    const state = await control.assertClosed(scope);
    await this.options.assertControl(state);
    const proposal = await this.options.verifyCurrent(
      scope,
      intent.deliveryProposalId,
      intent.inputHash,
    );
    const selected = this.select(state, snapshot, proposal);
    await this.options.verifyTargetMetadata?.(state, proposal.source);
    await this.options.verifyGrant(scope, selected.grant.grantId);
    const claims = structuredClone(snapshot.claims);
    for (const claim of claims) {
      if (claim.status === 'released') continue;
      const workspace = snapshot.workspaces.find(
        (w) => w.workspaceId === claim.workspaceId && w.projectId === claim.projectId,
      );
      if (workspace?.mode !== 'direct') continue;
      const root = snapshot.roots.find(
        (r) => r.projectId === workspace.projectId && r.rootId === workspace.rootId,
      );
      if (
        !root ||
        root.dev !== selected.root.dev ||
        root.inode !== selected.root.inode ||
        root.volumeId !== selected.root.volumeId
      )
        continue;
      if (
        claim.kind !== undefined ||
        claim.projectId !== scope.projectId ||
        claim.taskId !== scope.taskId ||
        claim.status !== 'active'
      )
        throw Error('delivery_application_busy');
      claim.closureReceiptId = await this.options.verifyClosedClaim(scope, claim);
      claim.status = 'released';
    }
    const suffix = localRecordHash({ ...scope, actionId: source.msgId });
    const workspace: WorkspaceRefV1 = {
      schemaVersion: 'workspace-v1',
      ...scope,
      workspaceId: `delivery:${suffix}`,
      rootId: selected.root.rootId,
      grantId: selected.grant.grantId,
      purpose: 'delivery',
      mode: 'direct',
      baselineManifestId: proposal.source.current.manifestId,
    };
    const writerEpoch = Math.max(0, ...snapshot.claims.map((c) => c.writerEpoch)) + 1;
    if (!Number.isSafeInteger(writerEpoch)) throw Error('workspace_epoch_exhausted');
    const claim: LocalDeliveryClaimRecord = {
      kind: 'delivery',
      ...scope,
      claimId: `claim:${suffix}`,
      workspaceId: workspace.workspaceId,
      writerEpoch,
      createdActionId: source.msgId,
      status: 'active',
      closureReceiptId: null,
      grantRevision: selected.grant.revision,
      deliveryProposalId: intent.deliveryProposalId,
      inputHash: intent.inputHash,
    };
    if (!state.localExecution) throw Error('delivery_application_scope_changed');
    await this.options.assertControl(state);
    await this.options.verifyCurrent(scope, intent.deliveryProposalId, intent.inputHash);
    if (
      !equal(await control.assertClosed(scope), state) ||
      !equal(await control.snapshot(), snapshot)
    )
      throw Error('delivery_application_state_changed');
    await control.commitBinding({
      ...scope,
      actionId: source.msgId,
      sourceMessageId: source.msgId,
      sourceMessage: source,
      expectedRevision: intent.expectedRevision,
      deliveryTransition: {
        kind: 'delivery-application-start-v1',
        beforeStateHash: localRecordHash(state),
        workspaceId: workspace.workspaceId,
        deliveryProposalId: intent.deliveryProposalId,
        inputHash: intent.inputHash,
      },
      nextLocalExecution: {
        ...state.localExecution,
        workspaces: [...state.localExecution.workspaces, workspace],
      },
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        linkedRoots: snapshot.linkedRoots ?? [],
        workspaces: [...snapshot.workspaces, workspace],
        claims: [...claims, claim],
      },
    });
    const call = callFor(claim);
    await this.assertCall(call, 'read');
    return { call, replayed: false };
  }

  private select(
    state: AppState,
    snapshot: Awaited<ReturnType<LocalBindingCoordinator['snapshot']>>,
    proposal: Proposal,
  ) {
    const source = proposal.source;
    if (
      (state.localExecution?.git || source.targetIndexHash !== null) &&
      !this.options.verifyTargetMetadata
    )
      throw Error('delivery_git_application_unavailable');
    const root = snapshot.roots.find(
      (r) => r.projectId === state.projectId && r.rootId === source.scope.rootId,
    );
    const grant = snapshot.grants.find(
      (g) =>
        g.projectId === state.projectId &&
        g.rootId === root?.rootId &&
        g.grantId === source.grantId,
    );
    if (
      !root ||
      !grant ||
      grant.status !== 'active' ||
      grant.revision !== source.grantRevision ||
      grant.policyHash !== source.scope.policyHash ||
      !grant.actions.includes('read') ||
      !grant.actions.includes('edit') ||
      source.scope.projectId !== state.projectId ||
      source.scope.taskId !== state.taskId ||
      state.localExecution?.delivery?.rootId !== root.rootId ||
      state.localExecution.delivery.goal !== source.goal ||
      !equal(localRootBinding(root), inspectLocalRoot(root.path))
    )
      throw Error('authorization_closed');
    return { root, grant };
  }

  async readCheckpoint(input: LocalDeliveryCall) {
    const call = structuredClone(input);
    const admitted = await this.assertCall(call, 'read');
    const authorize = async () => {
      const current = await this.assertCall(call, 'read');
      if (!equal(current.state, admitted.state) || !equal(current.snapshot, admitted.snapshot))
        throw Error('delivery_application_state_changed');
      return true;
    };
    return { ...admitted, authorize };
  }

  async assertCall(input: LocalDeliveryCall, action: 'read' | 'edit' | 'remove') {
    const call = structuredClone(input),
      { control } = this.options;
    const state = await control.assertClosed(call),
      snapshot = await control.snapshot();
    const workspace = snapshot.workspaces.find(
      (w) =>
        w.workspaceId === call.workspaceId &&
        w.projectId === call.projectId &&
        w.taskId === call.taskId,
    );
    if (!workspace) throw Error('delivery_application_assignment_mismatch');
    assertLocalRangeAdmission(snapshot, workspace, state.localExecution?.workspaces ?? []);
    await this.options.assertControl(state);
    const claim = snapshot.claims.find((c) => c.claimId === call.claimId);
    if (claim?.kind !== 'delivery' || !equal(callFor(claim), call))
      throw Error('delivery_application_assignment_mismatch');
    if (this.completed) {
      if (action !== 'read') throw Error('delivery_application_read_only');
      const completion = snapshot.operations.find((o) => o.actionId === this.completed?.actionId);
      const recipe =
        completion && isLocalBindingOperation(completion) && completion.deliveryTransition;
      const receipt =
        recipe && recipe.kind === 'delivery-application-complete-v1' && recipe.message.payload;
      if (
        claim.status !== 'released' ||
        claim.closureReceiptId !== this.completed.closureReceiptId ||
        !completion ||
        completion.stage !== 'committed' ||
        !receipt ||
        receipt.proofHash !== this.completed.proofHash ||
        receipt.closureReceiptId !== claim.closureReceiptId ||
        receipt.claimId !== claim.claimId ||
        receipt.workspaceId !== claim.workspaceId ||
        receipt.applyActionId !== claim.createdActionId ||
        receipt.deliveryProposalId !== call.deliveryProposalId ||
        receipt.inputHash !== call.inputHash ||
        receipt.grantRevision !== call.grantRevision
      )
        throw Error('delivery_application_release_mismatch');
    } else if (claim.status !== 'active') throw Error('delivery_application_assignment_mismatch');
    const origin = snapshot.operations.find((o) => o.actionId === claim.createdActionId);
    if (
      !origin ||
      !isLocalBindingOperation(origin) ||
      origin.stage !== 'committed' ||
      origin.deliveryTransition?.kind !== 'delivery-application-start-v1' ||
      origin.deliveryTransition.workspaceId !== call.workspaceId ||
      origin.deliveryTransition.deliveryProposalId !== call.deliveryProposalId ||
      origin.deliveryTransition.inputHash !== call.inputHash
    )
      throw Error('delivery_application_assignment_mismatch');
    const proposal = await this.options.verifyBinding(
      call,
      call.deliveryProposalId,
      call.inputHash,
    );
    const selected = this.select(state, snapshot, proposal);
    await this.options.verifyTargetMetadata?.(state, proposal.source);
    if (
      selected.grant.revision !== call.grantRevision ||
      !['read', 'edit', 'remove'].includes(action) ||
      !selected.grant.actions.includes(action)
    )
      throw Error('authorization_closed');
    await this.options.verifyGrant(call, selected.grant.grantId);
    if (
      !equal(await control.assertClosed(call), state) ||
      !equal(await control.snapshot(), snapshot)
    )
      throw Error('delivery_application_state_changed');
    return {
      state,
      snapshot,
      ...selected,
      claim,
      proposal,
      binding: localRootBinding(selected.root),
      sourceReceiptId: origin.receiptId,
    };
  }
}
