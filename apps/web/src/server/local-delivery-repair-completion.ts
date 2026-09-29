/** Trusted task-serial closure of a repair and dispatch of its fixed successor.
 * No worker is started here; a full-state CAS publishes the immutable chain. */
import {
  type AppState,
  appendMutation,
  deliveryRepairAssignment,
  deliveryValidationDispatch,
  isDeliveryRepairCandidate,
  type Message,
  type Mutation,
  setMutation,
} from '@agora/core-domain';
import { buildCoordinationLedger } from '../../../../packages/core/orchestration/src/progress-ledger';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalDeliveryRepairs } from '../../../../packages/runtime/sandbox/src/local-delivery-repairs';
import {
  type LocalClaimRecord,
  localRecordHash,
} from '../../../../packages/runtime/sandbox/src/local-registry-records';

type Scope = { projectId: string; taskId: string };
export class LocalDeliveryRepairCompletion {
  constructor(
    private readonly control: Pick<LocalBindingCoordinator, 'snapshot' | 'assertClosed'>,
    private readonly repairs: Pick<LocalDeliveryRepairs, 'seal'>,
    private readonly evidence: {
      assertReady(state: AppState): Promise<void>;
      verifySource(state: AppState, workerId: string): Promise<void>;
      verifyGrant(scope: Scope, grantId: string): Promise<void>;
      verifyClosedClaim(scope: Scope, claim: LocalClaimRecord): Promise<string>;
      compareAndCommit(state: AppState, mutations: readonly Mutation[]): Promise<AppState>;
    },
  ) {}
  async complete(scope: Scope, workerId: string): Promise<AppState> {
    const state = await this.control.assertClosed(scope);
    const assignment = deliveryRepairAssignment(state, workerId);
    if (assignment?.worker.status !== 'done') throw Error('delivery_repair_not_closed');
    const candidateId = `repair-candidate:${assignment.message.msgId}`;
    const dispatchId = `repair-test:${localRecordHash({ ...scope, workerId, candidateId })}`;
    const recorded = state.messages.filter((m) => m.msgId === candidateId);
    if (recorded.length) {
      const selected = deliveryValidationDispatch(state, assignment.round.roundId, dispatchId);
      if (
        recorded.length !== 1 ||
        !isDeliveryRepairCandidate(recorded[0]?.payload) ||
        selected?.repairCandidate?.message.msgId !== candidateId
      )
        throw Error('delivery_repair_candidate_changed');
      return state;
    }
    if (
      state.phase !== 'coding' ||
      state.nextRole !== 'CODER' ||
      state.humanGate ||
      state.localExecution?.delivery?.currentRoundId !== assignment.round.roundId ||
      state.workers.some((w) => ['pending', 'running', 'paused'].includes(w.status))
    )
      throw Error('delivery_repair_not_closed');
    const snapshot = await this.control.snapshot();
    const grant = snapshot.grants.find((g) => g.grantId === assignment.round.grantId);
    const claims = snapshot.claims.filter(
      (c) =>
        c.workerId === workerId && c.projectId === scope.projectId && c.taskId === scope.taskId,
    );
    const claim = claims[0];
    if (
      grant?.status !== 'active' ||
      grant.revision !== assignment.round.grantRevision ||
      claims.length !== 1 ||
      !claim ||
      claim.status !== 'active' ||
      claim.workspaceId !== assignment.workspace.workspaceId
    )
      throw Error('delivery_repair_claim_changed');
    const check = async () => {
      await this.evidence.verifyGrant(scope, grant.grantId);
      return (
        (await this.control.snapshot()).revision === snapshot.revision &&
        localRecordHash(await this.control.assertClosed(scope)) === localRecordHash(state)
      );
    };
    await this.evidence.assertReady(state);
    await this.evidence.verifySource(state, workerId);
    const closure = await this.evidence.verifyClosedClaim(scope, claim);
    const candidate = await this.repairs.seal(state, workerId, grant, closure, check);
    const ts = Math.max(Date.now(), ...state.messages.map((m) => m.ts + 1));
    const fact: Message = {
      msgId: candidateId,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts,
      display: 'Fixed the closed repair candidate for validation',
      payload: { ...candidate },
    };
    const dispatch: Message = {
      msgId: dispatchId,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts,
      display: 'Validate the repaired candidate and preserve cumulative tests',
      payload: {
        kind: 'delivery_validation_dispatch',
        nextRole: 'TESTER',
        roundId: candidate.roundId,
        workerIds: [`worker:${dispatchId}:0`],
        workspaceVersion: candidate.workspaceVersion,
        repairCandidateReceiptId: candidateId,
      },
    };
    const ledger: Message = {
      msgId: `repair-test-ledger:${localRecordHash({ dispatchId })}`,
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'chat',
      ts,
      display: dispatch.display,
      payload: buildCoordinationLedger(
        { ...state, phase: 'testing' },
        {
          nextSpeaker: 'TESTER',
          instruction: dispatch.display,
          completionCandidate: false,
          requestSatisfied: false,
        },
      ),
    };
    await this.evidence.assertReady(state);
    await this.evidence.verifySource(state, workerId);
    if ((await this.evidence.verifyClosedClaim(scope, claim)) !== closure || !(await check()))
      throw Error('delivery_transition_state_changed');
    return this.evidence.compareAndCommit(state, [
      appendMutation('messages', fact),
      appendMutation('messages', ledger),
      appendMutation('messages', dispatch),
      setMutation('phase', 'testing'),
      setMutation('nextRole', 'TESTER'),
      setMutation('testResults', undefined),
    ]);
  }
}
