/** Trusted task-serial repair registration. No lease or model is started here. */
import {
  type AppState,
  type DeliveryRepairSource,
  deliveryRepairSource,
  type Message,
  type WorkspaceRefV1,
} from '@agora/core-domain';
import { buildCoordinationLedger } from '../../../../packages/core/orchestration/src/progress-ledger';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalDeliveryRepairs } from '../../../../packages/runtime/sandbox/src/local-delivery-repairs';
import {
  isLocalBindingOperation,
  type LocalWorkerClaimRecord,
  localRecordHash,
} from '../../../../packages/runtime/sandbox/src/local-registry-records';

type Scope = { projectId: string; taskId: string };
export class LocalDeliveryRepairControl {
  constructor(
    private readonly control: Pick<
      LocalBindingCoordinator,
      'snapshot' | 'assertClosed' | 'commitBinding' | 'recover'
    >,
    private readonly repairs: Pick<LocalDeliveryRepairs, 'prepare'>,
    private readonly evidence: {
      assertReady(state: AppState): Promise<void>;
      verifySource(state: AppState, source: DeliveryRepairSource): Promise<void>;
      verifyGrant(scope: Scope, grantId: string): Promise<void>;
      verifyClosedClaim(scope: Scope, claim: LocalWorkerClaimRecord): Promise<string>;
      loadState(scope: Scope): Promise<AppState | undefined>;
    },
  ) {}
  async prepare(input: AppState, sourceInput: DeliveryRepairSource): Promise<AppState> {
    const state = structuredClone(input);
    const source = structuredClone(sourceInput);
    const scope = { projectId: state.projectId, taskId: state.taskId };
    const suffix = localRecordHash({ ...scope, source });
    const dispatchId = `repair:${suffix}`;
    const workerId = `worker:${dispatchId}:0`;
    const workspaceId = `repair-workspace:${suffix}`;
    const registry = await this.control.snapshot();
    const existing = registry.operations.find((op) => op.actionId === dispatchId);
    if (existing) {
      if (
        !isLocalBindingOperation(existing) ||
        existing.projectId !== scope.projectId ||
        existing.taskId !== scope.taskId ||
        existing.deliveryTransition?.kind !== 'delivery-repair-start-v1' ||
        existing.deliveryTransition.workspaceId !== workspaceId ||
        localRecordHash(existing.deliveryTransition.dispatch.payload.source) !==
          localRecordHash(source)
      )
        throw Error('operation_conflict');
      const persisted = await this.evidence.loadState(scope);
      if (!persisted?.localExecution?.receipts.some((r) => r.receiptId === existing.receiptId))
        throw Error('delivery_repair_recovery_required');
      await this.control.recover(existing.actionId, existing.inputHash);
      return this.control.assertClosed(scope);
    }
    if (
      localRecordHash(deliveryRepairSource(state)) !== localRecordHash(source) ||
      state.iterationCount >= 8
    )
      throw Error('delivery_repair_not_ready');
    const local = state.localExecution;
    const round = local?.delivery?.rounds.find((r) => r.roundId === source.roundId);
    const grant = registry.grants.find((g) => g.grantId === round?.grantId);
    if (
      !local ||
      !round ||
      !grant ||
      grant.projectId !== scope.projectId ||
      grant.rootId !== local.delivery?.rootId ||
      grant.revision !== round.grantRevision ||
      grant.status !== 'active' ||
      !grant.actions.includes('read') ||
      !grant.actions.includes('edit')
    )
      throw Error('authorization_closed');
    const check = async () => {
      await this.evidence.verifyGrant(scope, grant.grantId);
      return (
        (await this.control.snapshot()).revision === registry.revision &&
        localRecordHash(await this.control.assertClosed(scope)) === localRecordHash(state)
      );
    };
    if (!(await check())) throw Error('delivery_transition_state_changed');
    await this.evidence.assertReady(state);
    await this.evidence.verifySource(state, source);
    const claims = structuredClone(registry.claims);
    for (const claim of claims) {
      if (claim.status === 'released') continue;
      const workspace = registry.workspaces.find((w) => w.workspaceId === claim.workspaceId);
      if (workspace?.rootId !== grant.rootId || workspace.mode === 'linked-worktree') continue;
      // Direct repair claims conservatively retain exclusivity on the granted
      // root. Linked claims occupy their registered physical worktrees and stay
      // unchanged; registry validation still rejects physical overlap. Never
      // release integration/delivery claims by analogy.
      if (
        claim.kind !== undefined ||
        claim.status !== 'active' ||
        claim.projectId !== scope.projectId ||
        claim.taskId !== scope.taskId
      )
        throw Error('workspace_busy');
      claim.closureReceiptId = await this.evidence.verifyClosedClaim(scope, claim);
      claim.status = 'released';
    }
    const writerEpoch = Math.max(0, ...claims.map((c) => c.writerEpoch)) + 1;
    if (!Number.isSafeInteger(writerEpoch)) throw Error('workspace_epoch_exhausted');
    await this.repairs.prepare(
      {
        scope: { ...scope, rootId: grant.rootId, policyHash: grant.policyHash },
        dispatchId,
        source,
      },
      check,
    );
    const workspace: WorkspaceRefV1 = {
      schemaVersion: 'workspace-v1',
      ...scope,
      workspaceId,
      rootId: grant.rootId,
      grantId: grant.grantId,
      purpose: 'coding',
      mode: 'direct',
      baselineManifestId: source.workspaceVersion.manifestId,
    };
    const next = structuredClone(local);
    next.workspaces.push(workspace);
    next.bindings.push({ workerId, workspaceId, receiptId: `binding:${dispatchId}` });
    const ts = Math.max(Date.now(), ...state.messages.map((m) => m.ts + 1));
    const dispatch: Message = {
      msgId: dispatchId,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts,
      display: 'Repair the fixed delivery candidate within the current requirements',
      payload: {
        kind: 'delivery_repair_dispatch',
        nextRole: 'CODER',
        source,
        workerIds: [workerId],
      },
    };
    const ledger: Message = {
      msgId: `repair-ledger:${suffix}`,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'chat',
      ts,
      display: dispatch.display,
      payload: buildCoordinationLedger(
        { ...state, phase: 'coding' },
        {
          nextSpeaker: 'CODER',
          instruction: dispatch.display,
          completionCandidate: false,
          requestSatisfied: false,
        },
      ),
    };
    await this.evidence.assertReady(state);
    await this.evidence.verifySource(state, source);
    if (!(await check())) throw Error('delivery_transition_state_changed');
    await this.control.commitBinding({
      ...scope,
      actionId: dispatchId,
      sourceMessageId: round.actionId,
      expectedRevision: registry.revision,
      nextLocalExecution: next,
      records: {
        roots: registry.roots,
        grants: registry.grants,
        workspaces: [...registry.workspaces, workspace],
        claims: [
          ...claims,
          {
            ...scope,
            claimId: `claim:${suffix}`,
            workspaceId,
            workerId,
            writerEpoch,
            createdActionId: dispatchId,
            status: 'active',
            closureReceiptId: null,
          },
        ],
        ...(registry.linkedRoots ? { linkedRoots: registry.linkedRoots } : {}),
      },
      deliveryTransition: {
        kind: 'delivery-repair-start-v1',
        beforeStateHash: localRecordHash(state),
        workspaceId,
        dispatch,
        ledger,
      },
    });
    return this.control.assertClosed(scope);
  }
}
