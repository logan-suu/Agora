/** Leader-confirmed, distinct inverse writer. A replay is a historical reader;
 * only this process's freshly closed admission may execute an inverse batch. */
import { type AppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalQuiescentWriters } from './local-quiescent-writers';
import type { LocalRangeTargets } from './local-range-targets';
import {
  assertLocalControlMessage,
  isLocalBindingOperation,
  type LocalRegistryRecords,
  type LocalUndoClaimRecord,
  localRecordHash,
} from './local-registry-records';
import type { LocalUndoCurrentSource } from './local-undo-current-source';
import type { LocalUndoProposalStore } from './local-undo-proposal';

type Scope = { projectId: string; taskId: string };
export type LocalUndoCall = Scope & {
  claimId: string;
  actionId: string;
  workspaceId: string;
  writerEpoch: number;
  grantRevision: number;
  fileApplyReceiptId: string;
  inputHash: string;
};
type Options = {
  control: LocalBindingCoordinator;
  objects: LocalControlObjects;
  proposals: LocalUndoProposalStore;
  current: LocalUndoCurrentSource;
  writers: LocalQuiescentWriters;
  tasks: { load(scope: Scope): Promise<AppState | undefined> };
};
type Admission = {
  schemaVersion: 'local-undo-admission-v1';
  source: Message;
  proposalHash: string;
  previousRegistryHash: string;
  claim: LocalUndoClaimRecord;
  releasedClaims: { claimId: string; proofRef: string }[];
};
const slot = (scope: Scope, actionId: string) =>
  localRecordHash({
    kind: 'local-undo-admission',
    projectId: scope.projectId,
    taskId: scope.taskId,
    actionId,
  });
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const callFor = (c: LocalUndoClaimRecord): LocalUndoCall => ({
  projectId: c.projectId,
  taskId: c.taskId,
  claimId: c.claimId,
  actionId: c.createdActionId,
  workspaceId: c.workspaceId,
  writerEpoch: c.writerEpoch,
  grantRevision: c.grantRevision,
  fileApplyReceiptId: c.fileApplyReceiptId,
  inputHash: c.inputHash,
});
function fail(): never {
  throw Error('undo_admission_unverified');
}
export class LocalUndoAuthority {
  private readonly live = new Map<string, LocalUndoCall>();
  private readonly observationPins = new Map<
    string,
    {
      registry: LocalRegistryRecords;
      claim: LocalUndoClaimRecord;
      state: AppState;
      bound: Awaited<ReturnType<LocalUndoCurrentSource['verifyOwned']>>;
    }
  >();
  private resultReader:
    | ((registry: LocalRegistryRecords, state: AppState) => Promise<void>)
    | undefined;
  constructor(private readonly options: Options) {
    options.control.setUndoEvidenceVerifier(this.verifyEvidence);
  }
  setResultReader(reader: (registry: LocalRegistryRecords, state: AppState) => Promise<void>) {
    if (this.resultReader && this.resultReader !== reader)
      throw Error('undo_result_reader_conflict');
    this.resultReader = reader;
  }
  private readonly verifyEvidence = async (registry: LocalRegistryRecords, state: AppState) => {
    for (const claim of registry.claims)
      if (claim.kind === 'undo') await this.readAdmission(registry, claim);
    if (
      state.messages.some((m) => m.payload.kind === 'workspace_undo_result') ||
      registry.claims.some((c) => c.kind === 'undo' && c.status !== 'active')
    ) {
      if (!this.resultReader) throw Error('undo_result_reader_required');
      await this.resultReader(registry, state);
    }
  };
  private async readAdmission(registry: LocalRegistryRecords, claim: LocalUndoClaimRecord) {
    const ref = await this.options.objects.getReference(slot(claim, claim.createdActionId));
    if (!ref) fail();
    const record = (await this.options.objects.get(ref)) as Admission;
    if (
      !record ||
      Object.keys(record).sort().join(',') !==
        'claim,previousRegistryHash,proposalHash,releasedClaims,schemaVersion,source' ||
      record.schemaVersion !== 'local-undo-admission-v1' ||
      !Array.isArray(record.releasedClaims)
    )
      fail();
    const { status: _, closureReceiptId: __, ...identity } = claim,
      { status: s, closureReceiptId: closure, ...originalIdentity } = record.claim,
      intent = parseWorkspaceControl(record.source.display),
      proposal = (await this.options.proposals.read(record.proposalHash)).proposal;
    if (
      !same(identity, originalIdentity) ||
      s !== 'active' ||
      closure !== null ||
      intent?.verb !== 'undo' ||
      intent.actionId !== claim.createdActionId ||
      intent.projectId !== claim.projectId ||
      intent.taskId !== claim.taskId ||
      intent.fileApplyReceiptId !== claim.fileApplyReceiptId ||
      intent.inputHash !== claim.inputHash ||
      intent.expectedRevision !== proposal.expectedRevision ||
      record.proposalHash !== claim.inputHash ||
      proposal.target.workspaceId !== claim.workspaceId ||
      proposal.target.projectId !== claim.projectId ||
      proposal.target.taskId !== claim.taskId ||
      proposal.grantRevision !== claim.grantRevision ||
      record.previousRegistryHash !==
        (await this.options.current.read(proposal.currentHash)).registryHash
    )
      fail();
    assertLocalControlMessage(record.source, {
      ...claim,
      actionId: claim.createdActionId,
      sourceMessageId: record.source.msgId,
      expectedRevision: proposal.expectedRevision,
    });
    const operation = registry.operations.find((o) => o.actionId === claim.createdActionId),
      state = await this.options.tasks.load(claim);
    if (
      !operation ||
      !isLocalBindingOperation(operation) ||
      operation.stage !== 'committed' ||
      operation.preparedRevision !== proposal.expectedRevision + 1 ||
      !same(operation.sourceMessage, record.source) ||
      operation.projectId !== claim.projectId ||
      operation.taskId !== claim.taskId ||
      !state ||
      state.messages.filter((m) => m.msgId === record.source.msgId).length !== 1 ||
      !same(
        state.messages.find((m) => m.msgId === record.source.msgId),
        record.source,
      ) ||
      !state.localExecution?.receipts.some(
        (r) =>
          r.receiptId === operation.receiptId &&
          r.inputHash === operation.inputHash &&
          r.registryRevision === operation.preparedRevision,
      )
    )
      fail();
    const writer = await this.options.writers.read(
        (await this.options.current.read(proposal.currentHash)).writersHash,
      ),
      targets = (await this.options.objects.get(writer.targetsHash)) as LocalRangeTargets,
      expected = targets.claims.filter((c) => c.status !== 'released');
    if (
      !same(
        record.releasedClaims,
        expected.map((c) => ({
          claimId: c.claimId,
          proofRef: writer.claimProofs.find((p) => p.claimId === c.claimId)?.ref,
        })),
      )
    )
      fail();
    for (const release of record.releasedClaims) {
      const current = registry.claims.find((c) => c.claimId === release.claimId);
      if (
        current?.status !== 'released' ||
        current.closureReceiptId !== `closure:${release.proofRef}`
      )
        fail();
    }
    return { record, ref, operation, state };
  }
  async acquire(
    scope: Scope,
    message: Message,
  ): Promise<{ call: LocalUndoCall; replayed: boolean }> {
    const input = structuredClone(message),
      intent = parseWorkspaceControl(input.display);
    if (intent?.verb !== 'undo') throw Error('workspace_control_not_available');
    assertLocalControlMessage(input, {
      ...scope,
      actionId: intent.actionId,
      sourceMessageId: input.msgId,
      expectedRevision: intent.expectedRevision,
    });
    return this.options.control.serializeRangeAdmission(async () => {
      const registry = await this.options.control.snapshot(),
        existing = registry.operations.find((o) => o.actionId === intent.actionId);
      if (existing) {
        const claim = registry.claims.find(
          (c) => c.kind === 'undo' && c.createdActionId === intent.actionId,
        );
        if (claim?.kind !== 'undo') throw Error('operation_conflict');
        const saved = await this.readAdmission(registry, claim);
        if (!same(saved.record.source, { ...input, ts: saved.record.source.ts }))
          throw Error('operation_conflict');
        await this.options.control.assertClosed(scope);
        return { call: callFor(claim), replayed: true };
      }
      if (registry.revision !== intent.expectedRevision) throw Error('registry_revision_conflict');
      const state = await this.options.control.assertClosed(scope),
        facts = await this.options.proposals.verifyFresh(intent.inputHash),
        proposal = facts.proposal;
      if (
        proposal.fileApplyReceiptId !== intent.fileApplyReceiptId ||
        proposal.target.projectId !== scope.projectId ||
        proposal.target.taskId !== scope.taskId ||
        proposal.expectedRevision !== intent.expectedRevision
      )
        throw Error('undo_proposal_scope_mismatch');
      if (facts.plan.kind !== 'candidate') throw Error('undo_candidate_conflict');
      const grant = registry.grants.find(
        (g) => g.projectId === scope.projectId && g.grantId === proposal.grantId,
      );
      if (
        grant?.status !== 'active' ||
        grant.revision !== proposal.grantRevision ||
        !grant.actions.includes('read') ||
        facts.plan.items.some(
          (i) =>
            (i.operation === 'put' ||
              i.operation === 'restoreFile' ||
              i.operation === 'restoreDirectory') &&
            !grant.actions.includes('edit'),
        ) ||
        facts.plan.items.some(
          (i) =>
            (i.operation === 'remove' || i.operation === 'rmdir') &&
            !grant.actions.includes('remove'),
        )
      )
        throw Error('authorization_closed');
      const writer = await this.options.writers.read(facts.current.writersHash),
        targets = (await this.options.objects.get(writer.targetsHash)) as LocalRangeTargets,
        claims = structuredClone(registry.claims),
        releasedClaims: Admission['releasedClaims'] = [];
      for (const prior of targets.claims.filter((c) => c.status !== 'released')) {
        const claim = claims.find((c) => c.claimId === prior.claimId),
          proof = writer.claimProofs.find((p) => p.claimId === prior.claimId);
        if (!claim || !proof || claim.status !== 'active' || !same(claim, prior))
          throw Error('undo_workspace_busy');
        claim.status = 'released';
        claim.closureReceiptId = `closure:${proof.ref}`;
        releasedClaims.push({ claimId: claim.claimId, proofRef: proof.ref });
      }
      const writerEpoch = Math.max(0, ...registry.claims.map((c) => c.writerEpoch)) + 1;
      if (!Number.isSafeInteger(writerEpoch)) throw Error('workspace_epoch_exhausted');
      const claim: LocalUndoClaimRecord = {
        kind: 'undo',
        ...scope,
        claimId: `claim:${slot(scope, input.msgId)}`,
        workspaceId: proposal.target.workspaceId,
        writerEpoch,
        createdActionId: input.msgId,
        status: 'active',
        closureReceiptId: null,
        grantRevision: proposal.grantRevision,
        fileApplyReceiptId: proposal.fileApplyReceiptId,
        inputHash: intent.inputHash,
      };
      const record: Admission = {
        schemaVersion: 'local-undo-admission-v1',
        source: input,
        proposalHash: intent.inputHash,
        previousRegistryHash: facts.current.registryHash,
        claim,
        releasedClaims,
      };
      if (await this.options.objects.getReference(slot(scope, input.msgId)))
        throw Error('undo_recovery_required');
      await this.options.objects.bindReference(
        slot(scope, input.msgId),
        await this.options.objects.put(record),
      );
      await this.options.proposals.verifyFresh(intent.inputHash);
      if (
        !same(await this.options.control.snapshot(), registry) ||
        !same(await this.options.control.assertClosed(scope), state) ||
        !state.localExecution
      )
        throw Error('undo_admission_changed');
      await this.options.control.commitBinding({
        ...scope,
        actionId: input.msgId,
        sourceMessageId: input.msgId,
        sourceMessage: input,
        expectedRevision: intent.expectedRevision,
        nextLocalExecution: state.localExecution,
        records: {
          roots: registry.roots,
          grants: registry.grants,
          workspaces: registry.workspaces,
          linkedRoots: registry.linkedRoots ?? [],
          claims: [...claims, claim],
        },
      });
      const call = callFor(claim);
      await this.options.control.assertClosed(scope);
      this.live.set(claim.claimId, call);
      return { call, replayed: false };
    });
  }
  async assertCall(call: LocalUndoCall) {
    if (!this.live.has(call.claimId) || !same(this.live.get(call.claimId), call))
      throw Error('undo_not_live');
    const state = await this.options.control.assertClosed(call),
      registry = await this.options.control.snapshot(),
      claim = registry.claims.find((c) => c.claimId === call.claimId);
    if (
      claim?.kind !== 'undo' ||
      claim.status !== 'active' ||
      claim.closureReceiptId !== null ||
      !same(callFor(claim), call)
    )
      throw Error('undo_admission_closed');
    const admission = await this.readAdmission(registry, claim);
    if (!same(admission.operation.nextLocalExecution, state.localExecution))
      throw Error('undo_control_changed');
    const facts = await this.options.proposals.read(call.inputHash);
    const bound = await this.options.current.verifyOwned(facts.proposal.currentHash, claim);
    this.observationPins.set(call.claimId, structuredClone({ registry, claim, state, bound }));
    return { registry, claim, state, facts, bound };
  }
  /** Drop live capabilities only after the caller has closed the registry with
   * immutable native and canonical result evidence. No later replay can write. */
  retire(call: LocalUndoCall) {
    this.live.delete(call.claimId);
    this.observationPins.delete(call.claimId);
  }
  /** Within one read-only full-manifest observation, recheck live canonical
   * state/revision and the pinned admission on every native read. The caller
   * must run assertCall again before admitting any write or accepting the read. */
  async pinObservation(call: LocalUndoCall) {
    const saved = this.observationPins.get(call.claimId);
    if (!saved) throw Error('undo_observation_not_verified');
    const admitted = structuredClone(saved),
      referenceKey = slot(call, call.actionId),
      admissionRef = await this.options.objects.getReference(referenceKey);
    if (!admissionRef) fail();
    const stateHash = localRecordHash(admitted.state);
    const check = async () => {
      if (!this.live.has(call.claimId) || !same(this.live.get(call.claimId), call))
        throw Error('undo_not_live');
      const registry = await this.options.control.snapshot(),
        state = await this.options.tasks.load(call);
      if (
        registry.revision !== admitted.registry.revision ||
        !state ||
        localRecordHash(state) !== stateHash ||
        !same(
          registry.claims.find((c) => c.claimId === call.claimId),
          admitted.claim,
        ) ||
        (await this.options.objects.getReference(referenceKey)) !== admissionRef
      )
        throw Error('undo_control_changed');
      return true;
    };
    await check();
    return { admitted, check };
  }
}
