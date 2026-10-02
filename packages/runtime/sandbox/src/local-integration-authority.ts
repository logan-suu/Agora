/** Trusted serial integration admission. Never expose these calls to model tools.
 * Control liveness is supplied by the task composition, not a fabricated worker lease.
 */
import { isWorktreeRef } from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import { readConflictReworkHistory } from './local-conflict-rework-records';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalGitWorkspaceOptions } from './local-git-workspaces';
import {
  type ApplicationRequest,
  applicationPhase,
  applicationSlot,
  checkApplicationState,
  readCompletedApplication,
  readConfirmedApplicationPrefix,
} from './local-integration-application-records';
import {
  completionKey,
  readIntegrationCompletionPlan,
} from './local-integration-completion-records';
import {
  conflictHandoffKey,
  readIntegrationConflictHandoffPlan,
} from './local-integration-conflict-handoff-records';
import { conflictKey, readIntegrationConflictPlan } from './local-integration-conflict-records';
import { handoffKey, readIntegrationHandoffPlan } from './local-integration-handoff-records';
import { verifyLocalLinkedRoot } from './local-linked-root';
import { assertLocalRangeAdmission } from './local-range-admission';
import {
  isLocalBindingOperation,
  type LocalIntegrationClaimRecord,
  localRecordHash,
} from './local-registry-records';
import type { LocalRootCoordinator } from './local-root-coordinator';
import type {
  ValidationPreparationProofReader,
  ValidationPreparationReference,
} from './local-validation-preparation-control';

type Scope = { projectId: string; taskId: string };
type Request = Scope & {
  actionId: string;
  workspaceId: string;
  integrationId: string;
  expectedRevision: number;
};
export type LocalIntegrationCall = Scope & {
  claimId: string;
  workspaceId: string;
  integrationId: string;
  writerEpoch: number;
  grantRevision: number;
};
type Options = {
  control: LocalBindingCoordinator;
  objects: LocalControlObjects;
  roots: LocalRootCoordinator;
  gitOptions: LocalGitWorkspaceOptions;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  assertControl(scope: Scope): Promise<void>;
  verifyClosure(claim: LocalIntegrationClaimRecord): Promise<string>;
};
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const claimId = (request: Request) =>
  `claim:${localRecordHash({ kind: 'integration', projectId: request.projectId, taskId: request.taskId, actionId: request.actionId })}`;
const callFor = (claim: LocalIntegrationClaimRecord): LocalIntegrationCall => ({
  projectId: claim.projectId,
  taskId: claim.taskId,
  claimId: claim.claimId,
  workspaceId: claim.workspaceId,
  integrationId: claim.integrationId,
  writerEpoch: claim.writerEpoch,
  grantRevision: claim.grantRevision,
});

export class LocalIntegrationAuthority {
  private readonly git: LocalGitWorkspaceOptions;
  private completionCall?: LocalIntegrationCall;
  private handoff = false;
  private conflict = false;
  private conflictHandoff = false;
  private conflictRework = false;
  private preparation?: {
    control: ValidationPreparationProofReader;
    reference: ValidationPreparationReference;
  };
  constructor(private readonly options: Options) {
    this.git = structuredClone(options.gitOptions);
  }
  /** A proof-only reader, bound to an existing immutable completion plan. */
  completionReader(call: LocalIntegrationCall): LocalIntegrationAuthority {
    const reader = new LocalIntegrationAuthority(this.options);
    reader.completionCall = structuredClone(call);
    return reader;
  }
  /** Read-only admission bound to an exact native conflict transition. */
  conflictReader(call: LocalIntegrationCall): LocalIntegrationAuthority {
    const reader = this.completionReader(call);
    reader.conflict = true;
    return reader;
  }
  conflictHandoffReader(call: LocalIntegrationCall): LocalIntegrationAuthority {
    const reader = this.conflictReader(call);
    reader.conflictHandoff = true;
    return reader;
  }
  conflictReworkReader(call: LocalIntegrationCall): LocalIntegrationAuthority {
    const reader = this.conflictHandoffReader(call);
    reader.conflictRework = true;
    return reader;
  }
  /** Read original evidence through an exact, durably recorded closure transition. */
  handoffReader(call: LocalIntegrationCall): LocalIntegrationAuthority {
    const reader = this.completionReader(call);
    reader.handoff = true;
    return reader;
  }
  /** Proof-only history anchored to a unique validation preparation slot. */
  preparationReader(
    call: LocalIntegrationCall,
    control: ValidationPreparationProofReader,
    reference: ValidationPreparationReference,
  ): LocalIntegrationAuthority {
    const reader = this.handoffReader(call);
    reader.preparation = { control, reference: structuredClone(reference) };
    return reader;
  }
  async acquire(input: Request): Promise<LocalIntegrationCall> {
    if (this.completionCall) throw Error('integration_completion_read_only');
    localRecordHash(input);
    if (
      Object.keys(input).sort().join(',') !==
        'actionId,expectedRevision,integrationId,projectId,taskId,workspaceId' ||
      ![
        input.projectId,
        input.taskId,
        input.actionId,
        input.workspaceId,
        input.integrationId,
      ].every(id) ||
      !integer(input.expectedRevision)
    )
      throw Error('invalid_integration_control');
    const request = structuredClone(input),
      { control } = this.options;
    await this.options.assertControl(request);
    const before = await control.snapshot();
    const previous = before.operations.find((o) => o.actionId === request.actionId);
    if (previous) {
      const claim = before.claims.find((c) => c.claimId === claimId(request));
      if (
        !isLocalBindingOperation(previous) ||
        previous.projectId !== request.projectId ||
        previous.taskId !== request.taskId ||
        previous.preparedRevision - 1 !== request.expectedRevision ||
        claim?.kind !== 'integration' ||
        claim.createdActionId !== request.actionId ||
        claim.projectId !== request.projectId ||
        claim.taskId !== request.taskId ||
        claim.workspaceId !== request.workspaceId ||
        claim.integrationId !== request.integrationId
      )
        throw Error('operation_conflict');
      await control.recover(previous.actionId, previous.inputHash);
      const call = callFor(claim);
      await this.assertCall(call, 'read');
      return call;
    }
    const qualified = await this.qualify(request, false);
    const { state, snapshot, workspace, grant, planHash } = qualified;
    if (snapshot.revision !== request.expectedRevision) throw Error('registry_revision_conflict');
    if (
      snapshot.claims.some(
        (c) => c.workspaceId === workspace.workspaceId && c.status !== 'released',
      )
    )
      throw Error('workspace_busy');
    const writerEpoch = Math.max(0, ...snapshot.claims.map((c) => c.writerEpoch)) + 1;
    if (!Number.isSafeInteger(writerEpoch)) throw Error('workspace_epoch_exhausted');
    const claim: LocalIntegrationClaimRecord = {
      kind: 'integration',
      claimId: claimId(request),
      projectId: request.projectId,
      taskId: request.taskId,
      workspaceId: workspace.workspaceId,
      writerEpoch,
      createdActionId: request.actionId,
      integrationId: request.integrationId,
      waveId: qualified.integration.waveId,
      planHash,
      grantRevision: grant.revision,
      status: 'active',
      closureReceiptId: null,
    };
    if (!state.localExecution) throw Error('workspace_binding_missing');
    await control.commitBinding({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      sourceMessageId: grant.leaderMessageId,
      expectedRevision: snapshot.revision,
      nextLocalExecution: state.localExecution,
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        workspaces: snapshot.workspaces,
        claims: [...snapshot.claims, claim],
        linkedRoots: snapshot.linkedRoots ?? [],
      },
    });
    const call = callFor(claim);
    await this.assertCall(call, 'read');
    return call;
  }
  async assertCall(input: LocalIntegrationCall, action: 'read' | 'edit' | 'remove') {
    if (this.completionCall && action !== 'read') throw Error('integration_completion_read_only');
    const result = await this.admit(input, false);
    if (!['read', 'edit', 'remove'].includes(action) || !result.grant.actions.includes(action))
      throw Error('authorization_closed');
    return result;
  }
  /** Capture full admission once; the guard may run inside a serialized Git session.
   * It checks control liveness without recursively entering that Git session. */
  async readCheckpoint(input: LocalIntegrationCall) {
    const call = structuredClone(input);
    const qualified = await this.assertCall(call, 'read');
    return this.checkpoint(call, qualified);
  }
  async readHistoricalSelection(input: ApplicationRequest, inputAnchor?: ApplicationRequest) {
    const request = structuredClone(input),
      anchor = inputAnchor && structuredClone(inputAnchor);
    const checkpoint = anchor
      ? await this.readPublishedCheckpoint(anchor)
      : await this.readCheckpoint(request.call);
    const anchorProof = anchor
      ? await readCompletedApplication(this.options.objects, anchor)
      : undefined;
    if (anchor && localRecordHash(anchor.call) !== localRecordHash(request.call))
      throw Error('integration_application_recovery_required');
    const state = anchorProof
      ? { ...checkpoint.state, integration: anchorProof.prepared.integration }
      : checkpoint.state;
    const prefix = await readConfirmedApplicationPrefix(this.options.objects, state, request.call);
    const proof = prefix.find(
      (p) => localRecordHash(p.prepared.request) === localRecordHash(request),
    );
    if (!proof) throw Error('integration_application_recovery_required');
    return proof.prepared.selection;
  }
  async readPublishedSelection(request: ApplicationRequest) {
    const proof = await readCompletedApplication(this.options.objects, request);
    return structuredClone(proof.prepared.selection);
  }
  async readPublishedCheckpoint(request: ApplicationRequest) {
    if (this.completionCall) throw Error('integration_completion_read_only');
    const input = structuredClone(request);
    const qualified = await this.admit(input.call, false, 'active', input);
    return this.checkpoint(input.call, qualified);
  }
  private async checkpoint(
    call: LocalIntegrationCall,
    qualified: Awaited<ReturnType<LocalIntegrationAuthority['admit']>>,
  ) {
    const stateHash = qualified.liveStateHash;
    const revision = qualified.liveRegistryRevision;
    const grantId = qualified.grant.grantId;
    const completionCall = this.completionCall;
    const preparation = this.preparation;
    const authorize = async () => {
      if (
        completionCall &&
        this.conflictHandoff &&
        ((await this.options.objects.getReference(conflictHandoffKey(completionCall, 'plan'))) !==
          qualified.conflictHandoffPlanHash ||
          (await this.options.objects.getReference(conflictHandoffKey(completionCall, 'invalid'))))
      )
        throw Error('integration_conflict_handoff_recovery_required');
      await this.options.assertControl(call);
      await this.options.verifyGrant(call, grantId);
      if (
        (await this.options.control.snapshot()).revision !== revision ||
        localRecordHash(await this.options.control.assertClosed(call)) !== stateHash
      )
        throw Error('integration_selection_changed');
      if (preparation) {
        const fresh = await preparation.control.read(preparation.reference);
        if (
          fresh.stage !== qualified.preparationStage ||
          localRecordHash(fresh.call) !== localRecordHash(call) ||
          fresh.planHash !== preparation.reference.planHash
        )
          throw Error('initial_validation_preparation_state_changed');
      }
      if (
        completionCall &&
        !this.conflict &&
        ((await this.options.objects.getReference(completionKey(completionCall, 'plan'))) !==
          qualified.completionPlanHash ||
          (await this.options.objects.getReference(completionKey(completionCall, 'invalid'))))
      )
        throw Error('integration_completion_recovery_required');
      if (
        completionCall &&
        this.conflict &&
        ((await this.options.objects.getReference(conflictKey(completionCall, 'plan'))) !==
          qualified.conflictPlanHash ||
          (await this.options.objects.getReference(conflictKey(completionCall, 'invalid'))))
      )
        throw Error('integration_conflict_recovery_required');
      if (
        completionCall &&
        this.handoff &&
        ((await this.options.objects.getReference(handoffKey(completionCall, 'plan'))) !==
          qualified.handoffPlanHash ||
          (await this.options.objects.getReference(handoffKey(completionCall, 'invalid'))))
      )
        throw Error('integration_handoff_recovery_required');
      return true;
    };
    await authorize();
    return { ...qualified, authorize };
  }
  async release(input: LocalIntegrationCall): Promise<void> {
    if (this.completionCall) throw Error('integration_completion_read_only');
    localRecordHash(input);
    const call = structuredClone(input),
      { control } = this.options;
    const releaseKey = localRecordHash({ kind: 'integration-release', call });
    const actionId = `release:${releaseKey}`,
      drainId = `drain:${releaseKey}`;
    await this.options.assertControl(call);
    const snapshot = await control.snapshot();
    const previous = snapshot.operations.find((o) => o.actionId === actionId);
    if (previous) {
      const claim = snapshot.claims.find((c) => c.claimId === call.claimId);
      if (
        !isLocalBindingOperation(previous) ||
        previous.projectId !== call.projectId ||
        previous.taskId !== call.taskId ||
        claim?.kind !== 'integration' ||
        claim.status !== 'released' ||
        localRecordHash(callFor(claim)) !== localRecordHash(call) ||
        !previous.nextLocalExecution.receipts.some((r) => r.actionId === actionId)
      )
        throw Error('operation_conflict');
      const closure = await this.options.verifyClosure(claim);
      if (closure !== claim.closureReceiptId) throw Error('integration_closure_changed');
      await control.recover(previous.actionId, previous.inputHash);
      return;
    }
    const drain = snapshot.operations.find((o) => o.actionId === drainId);
    if (drain) {
      const claim = snapshot.claims.find((c) => c.claimId === call.claimId);
      if (
        !isLocalBindingOperation(drain) ||
        drain.projectId !== call.projectId ||
        drain.taskId !== call.taskId ||
        claim?.kind !== 'integration' ||
        claim.status !== 'draining' ||
        localRecordHash(callFor(claim)) !== localRecordHash(call)
      )
        throw Error('operation_conflict');
      await control.recover(drain.actionId, drain.inputHash);
    } else {
      const active = await this.admit(call, true, 'active');
      if (!active.state.localExecution) throw Error('workspace_binding_missing');
      await control.commitBinding({
        projectId: call.projectId,
        taskId: call.taskId,
        actionId: drainId,
        sourceMessageId: active.grant.leaderMessageId,
        expectedRevision: active.snapshot.revision,
        nextLocalExecution: active.state.localExecution,
        records: {
          roots: active.snapshot.roots,
          grants: active.snapshot.grants,
          workspaces: active.snapshot.workspaces,
          linkedRoots: active.snapshot.linkedRoots ?? [],
          claims: active.snapshot.claims.map((c) =>
            c.claimId === call.claimId ? { ...c, status: 'draining' } : c,
          ),
        },
      });
    }
    const admitted = await this.admit(call, true);
    const closureReceiptId = await this.options.verifyClosure(admitted.claim);
    if (!id(closureReceiptId)) throw Error('integration_closure_invalid');
    const checked = await this.admit(call, true);
    if (
      checked.snapshot.revision !== admitted.snapshot.revision ||
      localRecordHash(checked.state.localExecution) !==
        localRecordHash(admitted.state.localExecution)
    )
      throw Error('registry_revision_conflict');
    if (!checked.state.localExecution) throw Error('workspace_binding_missing');
    await control.commitBinding({
      projectId: call.projectId,
      taskId: call.taskId,
      actionId,
      sourceMessageId: checked.grant.leaderMessageId,
      expectedRevision: checked.snapshot.revision,
      nextLocalExecution: checked.state.localExecution,
      records: {
        roots: checked.snapshot.roots,
        grants: checked.snapshot.grants,
        workspaces: checked.snapshot.workspaces,
        linkedRoots: checked.snapshot.linkedRoots ?? [],
        claims: checked.snapshot.claims.map((c) =>
          c.claimId === call.claimId ? { ...c, status: 'released', closureReceiptId } : c,
        ),
      },
    });
  }
  private async admit(
    input: LocalIntegrationCall,
    closing: boolean,
    expectedStatus: 'active' | 'draining' = closing ? 'draining' : 'active',
    published?: ApplicationRequest,
  ) {
    localRecordHash(input);
    if (
      Object.keys(input).sort().join(',') !==
        'claimId,grantRevision,integrationId,projectId,taskId,workspaceId,writerEpoch' ||
      ![input.projectId, input.taskId, input.claimId, input.workspaceId, input.integrationId].every(
        id,
      ) ||
      !integer(input.writerEpoch) ||
      !integer(input.grantRevision)
    )
      throw Error('invalid_integration_control');
    const call = structuredClone(input);
    if (this.completionCall && localRecordHash(call) !== localRecordHash(this.completionCall))
      throw Error('integration_completion_recovery_required');
    const qualified = await this.qualify(call, closing, published);
    const claim = qualified.snapshot.claims.find((c) => c.claimId === call.claimId);
    if (
      claim?.kind !== 'integration' ||
      claim.status !== expectedStatus ||
      localRecordHash(callFor(claim)) !== localRecordHash(call) ||
      claim.planHash !== qualified.planHash ||
      claim.waveId !== qualified.integration.waveId ||
      claim.grantRevision !== qualified.grant.revision
    )
      throw Error('integration_claim_closed');
    const origin = qualified.snapshot.operations.find((o) => o.actionId === claim.createdActionId);
    if (
      !origin ||
      !isLocalBindingOperation(origin) ||
      origin.stage !== 'committed' ||
      origin.projectId !== call.projectId ||
      origin.taskId !== call.taskId ||
      origin.sourceMessageId !== qualified.grant.leaderMessageId ||
      !qualified.state.localExecution?.receipts.some(
        (r) => r.receiptId === origin.receiptId && r.inputHash === origin.inputHash,
      )
    )
      throw Error('workspace_binding_incomplete');
    if (published) {
      const proof = await readCompletedApplication(this.options.objects, published);
      if (proof.prepared.sourceReceiptId !== origin.receiptId)
        throw Error('integration_application_recovery_required');
    }
    return { ...qualified, claim, sourceReceiptId: origin.receiptId };
  }
  private async qualify(
    scope: Scope & { workspaceId: string; integrationId: string },
    closing: boolean,
    published?: ApplicationRequest,
  ) {
    const { control } = this.options;
    await this.options.assertControl(scope);
    const liveState = await control.assertClosed(scope),
      liveSnapshot = await control.snapshot();
    const completionCall = this.completionCall;
    const historical = this.preparation
      ? await this.preparation.control.readFixedHandoff(this.preparation.reference)
      : undefined;
    if (historical && localRecordHash(historical.call) !== localRecordHash(completionCall))
      throw Error('initial_validation_preparation_mismatch');
    const handoff =
      completionCall && this.handoff
        ? await readIntegrationHandoffPlan(
            this.options.objects,
            completionCall,
            historical?.releasedState ?? liveState,
            historical?.releasedRegistry ?? liveSnapshot,
          )
        : undefined;
    const conflictRework =
      completionCall && this.conflictRework
        ? await readConflictReworkHistory(
            this.options.objects,
            completionCall,
            liveState,
            liveSnapshot,
          )
        : undefined;
    const conflictHandoff =
      completionCall && this.conflictHandoff
        ? await readIntegrationConflictHandoffPlan(
            this.options.objects,
            completionCall,
            conflictRework?.released.state ?? liveState,
            conflictRework?.released.snapshot ?? liveSnapshot,
          )
        : undefined;
    const snapshot = conflictHandoff?.registry ?? handoff?.registry ?? liveSnapshot;
    const conflict =
      conflictHandoff?.conflict ??
      (completionCall && this.conflict
        ? await readIntegrationConflictPlan(this.options.objects, completionCall, liveState)
        : undefined);
    const completion =
      handoff?.completion ??
      (completionCall && !this.conflict
        ? await readIntegrationCompletionPlan(this.options.objects, completionCall, liveState)
        : undefined);
    if (
      completion &&
      (closing || published || completion.plan.registryRevision !== snapshot.revision)
    )
      throw Error('integration_completion_recovery_required');
    if (conflict && (closing || published || conflict.plan.registryRevision !== snapshot.revision))
      throw Error('integration_conflict_recovery_required');
    const state = conflict?.before ?? completion?.before ?? liveState;
    const integration = state.integration;
    const workspace = snapshot.workspaces.find(
      (w) =>
        w.workspaceId === scope.workspaceId &&
        w.projectId === scope.projectId &&
        w.taskId === scope.taskId,
    );
    const record = snapshot.linkedRoots?.find((r) => r.workspaceId === scope.workspaceId);
    const mapping = state.localExecution?.git?.worktrees.find(
      (w) => w.workspaceId === scope.workspaceId,
    );
    if (
      !integration ||
      integration.integrationId !== scope.integrationId ||
      (!closing &&
        (integration.status !== 'merging' || state.phase === 'done' || state.humanGate)) ||
      workspace?.mode !== 'linked-worktree' ||
      workspace.purpose !== 'integration' ||
      !record ||
      !mapping ||
      record.projectId !== scope.projectId ||
      record.taskId !== scope.taskId ||
      !state.localExecution?.workspaces.some(
        (w) => localRecordHash(w) === localRecordHash(workspace),
      ) ||
      mapping.receiptId !== record.bindingReceiptId ||
      mapping.path !== record.path ||
      integration.integrationWorktree.path !== record.path ||
      integration.integrationWorktree.branch !== workspace.branch ||
      integration.integrationWorktree.baseCommit !== workspace.baseCommit
    )
      throw Error('integration_assignment_mismatch');
    if (!closing)
      assertLocalRangeAdmission(
        liveSnapshot,
        workspace,
        liveState.localExecution?.workspaces ?? [],
      );
    const proof = published
      ? await readCompletedApplication(this.options.objects, published)
      : undefined;
    if (proof) {
      await checkApplicationState(this.options.objects, state, proof);
      const prefix = await readConfirmedApplicationPrefix(
        this.options.objects,
        { ...state, integration: proof.prepared.integration },
        proof.prepared.request.call,
      );
      const parent = prefix[0];
      if (
        parent
          ? localRecordHash(proof.prepared.candidate.predecessor ?? null) !==
              localRecordHash({
                inputHash: parent.inputHash,
                resultHash: parent.resultHash,
                confirmationHash: parent.confirmationHash,
              }) ||
            localRecordHash(proof.prepared.candidate.targetVersion) !==
              localRecordHash(parent.result.version)
          : proof.prepared.candidate.predecessor !== undefined
      )
        throw Error('integration_application_recovery_required');

      if (
        proof.prepared.registryRevision !== snapshot.revision ||
        localRecordHash(proof.prepared.gitOptions) !== localRecordHash(this.git)
      )
        throw Error('integration_application_recovery_required');
    } else if (!closing && integration.mergedBranches.length) {
      if (!state.parallelExecution?.activeWave)
        throw Error('integration_application_recovery_required');
      const key = applicationSlot(scope, {
        waveId: integration.waveId,
        attempt: state.parallelExecution?.activeWave?.attempt,
        position: integration.mergedBranches.length - 1,
      });
      const hash = await this.options.objects.getReference(applicationPhase(key, 'prepared'));
      if (!hash) throw Error('integration_application_recovery_required');
      const saved = (await this.options.objects.get(hash)) as { request: ApplicationRequest };
      const completed = await readCompletedApplication(this.options.objects, saved.request);
      const states = await checkApplicationState(this.options.objects, state, completed);
      const confirmation = await this.options.objects.getReference(
        applicationPhase(key, 'state-confirmed'),
      );
      if (
        completed.key !== key ||
        states.mutations.length ||
        !confirmation ||
        localRecordHash(await this.options.objects.get(confirmation)) !==
          localRecordHash({
            schemaVersion: 'local-integration-state-confirmed-v1',
            planHash: localRecordHash(states.plan),
            resultHash: completed.resultHash,
            stateHash: localRecordHash(states.after),
          })
      )
        throw Error('integration_application_recovery_required');
      await readConfirmedApplicationPrefix(
        this.options.objects,
        state,
        completed.prepared.request.call,
      );
    }
    for (const branch of integration.pendingBranches) {
      const worker = state.workers.find((w) => w.workerId === branch.workerId);
      if (
        worker?.status !== 'done' ||
        worker.subtaskId !== branch.subtaskId ||
        !isWorktreeRef(worker.worktree) ||
        localRecordHash(worker.worktree) !== localRecordHash(branch.worktree)
      )
        throw Error('integration_source_mismatch');
    }
    const root = snapshot.roots.find(
      (r) => r.rootId === workspace.rootId && r.projectId === scope.projectId,
    );
    const grant = snapshot.grants.find(
      (g) =>
        g.grantId === workspace.grantId &&
        g.rootId === workspace.rootId &&
        g.projectId === scope.projectId,
    );
    if (
      !root ||
      !grant ||
      grant.status !== 'active' ||
      !grant.actions.includes('read') ||
      !grant.actions.includes('edit')
    )
      throw Error('authorization_closed');
    if (
      conflictRework &&
      (!liveSnapshot.roots.some((r) => localRecordHash(r) === localRecordHash(root)) ||
        !liveSnapshot.grants.some((g) => localRecordHash(g) === localRecordHash(grant)))
    )
      throw Error('integration_conflict_rework_mismatch');
    const initialization = snapshot.operations.find(
      (o) => !isLocalBindingOperation(o) && o.rootId === root.rootId && o.grantId === grant.grantId,
    );
    if (
      !initialization ||
      isLocalBindingOperation(initialization) ||
      initialization.stage !== 'committed'
    )
      throw Error('workspace_root_not_initialized');
    const check = async () => {
      if (
        completionCall &&
        conflictHandoff &&
        ((await this.options.objects.getReference(conflictHandoffKey(completionCall, 'plan'))) !==
          conflictHandoff.planHash ||
          (await this.options.objects.getReference(conflictHandoffKey(completionCall, 'invalid'))))
      )
        throw Error('integration_conflict_handoff_recovery_required');
      await this.options.assertControl(scope);
      await this.options.verifyGrant(scope, grant.grantId);
      if (historical && this.preparation) {
        const fresh = await this.preparation.control.read(this.preparation.reference);
        if (
          fresh.stage !== historical.stage ||
          localRecordHash(fresh.call) !== localRecordHash(completionCall) ||
          fresh.planHash !== historical.planHash
        )
          throw Error('initial_validation_preparation_state_changed');
      }
      if (
        completionCall &&
        conflict &&
        ((await this.options.objects.getReference(conflictKey(completionCall, 'plan'))) !==
          conflict.planHash ||
          (await this.options.objects.getReference(conflictKey(completionCall, 'invalid'))))
      )
        throw Error('integration_conflict_recovery_required');
      const current = await control.assertClosed(scope);
      if (
        (await control.snapshot()).revision !== liveSnapshot.revision ||
        localRecordHash(current) !== localRecordHash(liveState)
      )
        throw Error('integration_assignment_mismatch');
      if (
        completionCall &&
        completion &&
        ((await this.options.objects.getReference(completionKey(completionCall, 'plan'))) !==
          completion.planHash ||
          (await this.options.objects.getReference(completionKey(completionCall, 'invalid'))))
      )
        throw Error('integration_completion_recovery_required');
      if (
        completionCall &&
        handoff &&
        ((await this.options.objects.getReference(handoffKey(completionCall, 'plan'))) !==
          handoff.planHash ||
          (await this.options.objects.getReference(handoffKey(completionCall, 'invalid'))))
      )
        throw Error('integration_handoff_recovery_required');
      return true;
    };
    await check();
    await this.options.roots.initialize({
      projectId: scope.projectId,
      taskId: scope.taskId,
      actionId: initialization.actionId,
      rootId: root.rootId,
      grantId: grant.grantId,
      expectedRevision: initialization.preparedRevision - 1,
    });
    await verifyLocalLinkedRoot({
      ...this.git,
      projectId: scope.projectId,
      taskId: scope.taskId,
      root: root.path,
      sourceRoot: root,
      workspace,
      record,
      expectedHead:
        proof?.result.publication.commit ??
        integration.integrationWorktree.headCommit ??
        integration.integrationWorktree.baseCommit,
      actionId: record.initialization.actionId,
      creationActionId: record.creation.actionId,
      bindingReceiptId: record.bindingReceiptId,
      authorize: check,
    });
    await check();
    if (
      proof &&
      localRecordHash(proof.prepared.binding) !==
        localRecordHash({
          root: record.path,
          chain: record.chain,
          stagingIdentity: record.staging.identity,
        })
    )
      throw Error('integration_application_recovery_required');
    const { headCommit: _, ...fixedWorktree } = integration.integrationWorktree;
    return {
      state,
      liveStateHash: localRecordHash(liveState),
      liveRegistryRevision: liveSnapshot.revision,
      ...(historical ? { preparationStage: historical.stage } : {}),
      completionPlanHash: completion?.planHash,
      conflictPlanHash: conflict?.planHash,
      conflictHandoffPlanHash: conflictHandoff?.planHash,
      handoffPlanHash: handoff?.planHash,
      snapshot,
      integration,
      workspace,
      root,
      grant,
      record,
      planHash: localRecordHash({
        integrationId: integration.integrationId,
        waveId: integration.waveId,
        base: integration.base,
        pendingBranches: integration.pendingBranches,
        worktree: fixedWorktree,
      }),
      binding: {
        root: record.path,
        chain: structuredClone(record.chain),
        stagingIdentity: record.staging.identity,
      },
    };
  }
}
