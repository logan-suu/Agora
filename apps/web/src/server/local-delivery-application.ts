/** Trusted application completion under the existing task serial queue. A
 * released claim remains readable only through its exact immutable proof. */
import {
  type AppState,
  assertCurrentDeliveryApplication,
  assertLocalDeliveryApplicationMessage,
  currentDeliveryApplicationMessage,
  type LocalDeliveryApplicationReceipt,
  type Message,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalControlObjects } from '../../../../packages/runtime/sandbox/src/local-control-objects';
import type {
  LocalDeliveryAuthority,
  LocalDeliveryCall,
} from '../../../../packages/runtime/sandbox/src/local-delivery-authority';
import type { LocalDeliveryTreeBatch } from '../../../../packages/runtime/sandbox/src/local-integration-tree-batch';
import { localRecordHash } from '../../../../packages/runtime/sandbox/src/local-registry-records';
import type { LocalDeliveryApplicationProposals } from './local-delivery-application-proposals';

type Options = {
  control: LocalBindingCoordinator;
  objects: LocalControlObjects;
  proposals: LocalDeliveryApplicationProposals;
  authority: LocalDeliveryAuthority;
  batch: LocalDeliveryTreeBatch;
};
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const actionFor = (call: LocalDeliveryCall) => `delivery-finish:${localRecordHash(call)}`;
export class LocalDeliveryApplication {
  constructor(private readonly options: Options) {}

  async verifyCurrent(expected: AppState) {
    const scope = { projectId: expected.projectId, taskId: expected.taskId };
    const state = await this.options.control.assertClosed(scope);
    if (!same(state, expected)) throw Error('delivery_application_state_changed');
    const message = currentDeliveryApplicationMessage(state);
    if (!message) return undefined;
    assertLocalDeliveryApplicationMessage(message);
    const proof = await this.options.objects.get(message.payload.proofHash);
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || !('call' in proof))
      throw Error('delivery_application_proof_changed');
    // assertCall compares every field with the durable claim; this cast confers
    // no authority and cannot turn a caller-supplied object into a live call.
    const call = proof.call as LocalDeliveryCall;
    const verified = await this.verify(call, message);
    if (!same(verified.state, expected)) throw Error('delivery_application_state_changed');
    return { ...verified, message, call };
  }

  async complete(input: LocalDeliveryCall): Promise<Message> {
    const call = structuredClone(input);
    const { control, objects, authority, proposals, batch } = this.options;
    const completionActionId = actionFor(call);
    const pending = (await control.snapshot()).operations.find(
      (o) => o.actionId === completionActionId,
    );
    if (pending?.stage === 'prepared')
      await control.recoverCommittedDelivery(pending.actionId, pending.inputHash);
    const state = await control.assertClosed(call);
    const existing = state.messages.find(
      (m) => m.msgId === `delivery-applied:${completionActionId}`,
    );
    if (existing) {
      await this.verify(call, existing);
      return structuredClone(existing);
    }
    const admitted = await authority.assertCall(call, 'read');
    if (!same(admitted.state, state)) throw Error('delivery_application_state_changed');
    const proposal = await proposals.verifyBinding(call, call.deliveryProposalId, call.inputHash);
    const plan = {
      scope: proposal.source.scope,
      baseline: proposal.source.baseline,
      artifact: proposal.source.artifact,
      current: proposal.source.current,
    };
    const result = await batch.readApplied(call, admitted.claim.createdActionId, plan);
    if (result.stage !== 'applied' || !result.version)
      throw Error('delivery_application_incomplete');
    const closureReceiptId = await batch.closure(admitted.claim);
    const proof = {
      schemaVersion: 'delivery-application-proof-v1',
      call,
      proposal,
      plan,
      result,
      closureReceiptId,
      completionActionId,
    };
    const proofHash = await objects.put(proof);
    const receipt: LocalDeliveryApplicationReceipt = {
      kind: 'workspace_delivery_application',
      version: 1,
      projectId: call.projectId,
      taskId: call.taskId,
      applyActionId: admitted.claim.createdActionId,
      completionActionId,
      claimId: call.claimId,
      workspaceId: call.workspaceId,
      deliveryProposalId: call.deliveryProposalId,
      inputHash: call.inputHash,
      roundId: proposal.roundId,
      reviewId: proposal.reviewId,
      validationReceiptId: proposal.evidence.validationReceiptId,
      candidateVersion: proposal.source.artifact,
      targetVersion: result.version,
      grantId: admitted.grant.grantId,
      grantRevision: call.grantRevision,
      controlFingerprint: proposal.evidence.controlFingerprint,
      treeReceiptId: result.receiptId,
      treeInputHash: result.inputHash,
      closureReceiptId,
      proofHash,
    };
    const message: Message = {
      msgId: `delivery-applied:${completionActionId}`,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: Date.now(),
      display: 'Reviewed version applied to the selected directory.',
      payload: { ...receipt },
    };
    assertCurrentDeliveryApplication(state, message, false);
    if (!state.localExecution) throw Error('delivery_application_scope_changed');
    // Recheck actual bytes after persisting the immutable proof, before either
    // store is changed. A concurrent edit cannot be accepted by a saved result.
    if (
      !same(await batch.readApplied(call, receipt.applyActionId, plan), result) ||
      !same(await control.assertClosed(call), state) ||
      !same(await control.snapshot(), admitted.snapshot)
    )
      throw Error('delivery_application_state_changed');
    await control.commitBinding({
      projectId: call.projectId,
      taskId: call.taskId,
      actionId: completionActionId,
      sourceMessageId: receipt.applyActionId,
      expectedRevision: admitted.snapshot.revision,
      nextLocalExecution: state.localExecution,
      deliveryTransition: {
        kind: 'delivery-application-complete-v1',
        beforeStateHash: localRecordHash(state),
        message,
      },
      records: {
        roots: admitted.snapshot.roots,
        grants: admitted.snapshot.grants,
        linkedRoots: admitted.snapshot.linkedRoots ?? [],
        workspaces: admitted.snapshot.workspaces,
        claims: admitted.snapshot.claims.map((c) =>
          c.claimId === call.claimId ? { ...c, status: 'released' as const, closureReceiptId } : c,
        ),
      },
    });
    await this.verify(call, message);
    return message;
  }

  async verify(input: LocalDeliveryCall, original: Message) {
    const call = structuredClone(input),
      message = structuredClone(original);
    assertLocalDeliveryApplicationMessage(message);
    const { control, objects, authority, batch, proposals } = this.options;
    const state = await control.assertClosed(call);
    const receipt = assertCurrentDeliveryApplication(state, message);
    if (
      receipt.completionActionId !== actionFor(call) ||
      receipt.claimId !== call.claimId ||
      receipt.workspaceId !== call.workspaceId ||
      receipt.deliveryProposalId !== call.deliveryProposalId ||
      receipt.inputHash !== call.inputHash ||
      receipt.grantRevision !== call.grantRevision
    )
      throw Error('delivery_application_proof_changed');
    const reader = authority.completionReader(
      receipt.completionActionId,
      receipt.proofHash,
      receipt.closureReceiptId,
    );
    const admitted = await reader.assertCall(call, 'read');
    const proposal = await proposals.verifyBinding(call, call.deliveryProposalId, call.inputHash);
    const plan = {
      scope: proposal.source.scope,
      baseline: proposal.source.baseline,
      artifact: proposal.source.artifact,
      current: proposal.source.current,
    };
    const readonlyBatch = batch.withAuthority(reader);
    const result = await readonlyBatch.readApplied(call, receipt.applyActionId, plan);
    const closureReceiptId = await readonlyBatch.closure(admitted.claim);
    const expected = {
      schemaVersion: 'delivery-application-proof-v1',
      call,
      proposal,
      plan,
      result,
      closureReceiptId,
      completionActionId: receipt.completionActionId,
    };
    if (
      !same(await objects.get(receipt.proofHash), expected) ||
      closureReceiptId !== receipt.closureReceiptId ||
      !same(result.version, receipt.targetVersion) ||
      result.receiptId !== receipt.treeReceiptId ||
      result.inputHash !== receipt.treeInputHash ||
      receipt.grantId !== admitted.grant.grantId ||
      !same(await control.assertClosed(call), state) ||
      !same(await control.snapshot(), admitted.snapshot)
    )
      throw Error('delivery_application_proof_changed');
    return { state, receipt };
  }
}
