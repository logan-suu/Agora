/** Trusted cross-store range control. commit() only accepts the durable request;
 * hold() runs outside the Leader/task queue. Restart readers never rerun closure. */
import {
  type AppState,
  appendMutation,
  type Message,
  type Mutation,
  parseWorkspaceControl,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import {
  type LocalRangeEvidencePort,
  type LocalRangeHeldProof,
  type LocalRangeSourceProof,
  type LocalRangeWorkerProof,
  localRangeSourceKey,
  reconcileLocalRangeEvidence,
} from './local-range-evidence';
import {
  type LocalRangeHold,
  type LocalRangePlan,
  parseLocalRangeHold,
} from './local-range-records';
import { assertLocalControlMessage, localRecordHash } from './local-registry-records';

type Scope = { projectId: string; taskId: string };
export interface LocalRangeSources extends Omit<LocalRangeEvidencePort, 'objects'> {
  prepare(
    scope: Scope,
    message: Message,
  ): Promise<{ plan: LocalRangePlan; proof: LocalRangeSourceProof }>;
}
export interface LocalRangeLifecycle {
  closeWorkers(hold: LocalRangeHold, sourceRef: string): Promise<LocalRangeWorkerProof[]>;
  proveWriters(
    hold: LocalRangeHold,
    sourceRef: string,
    workers: readonly LocalRangeWorkerProof[],
  ): Promise<string>;
}
type Options = {
  control: Pick<
    LocalBindingCoordinator,
    'snapshot' | 'updateRangeHold' | 'serializeRangeAdmission'
  >;
  objects: Pick<LocalControlObjects, 'get' | 'put' | 'getReference' | 'bindReference'>;
  tasks: {
    load(scope: Scope): Promise<AppState | undefined>;
    compareAndCommit(
      scope: Scope,
      expected: AppState,
      mutations: readonly Mutation[],
    ): Promise<{ state: AppState; changed: boolean }>;
  };
  sources: LocalRangeSources;
  lifecycle: LocalRangeLifecycle;
};
const key = (v: { projectId: string; taskId: string; workerId: string }) =>
  `${v.projectId}/${v.taskId}/${v.workerId}`;
export class LocalRangeController {
  private readonly holds = new Map<string, Promise<LocalRangeHold>>();
  constructor(private readonly options: Options) {}
  private async load(takeoverId: string) {
    const snapshot = await this.options.control.snapshot();
    const matches = (snapshot.rangeHolds ?? []).filter((h) => h.plan.takeoverId === takeoverId);
    if (matches.length !== 1) throw Error('range_control_missing');
    return { snapshot, hold: parseLocalRangeHold(matches[0]) };
  }
  private async task(scope: Scope) {
    const state = await this.options.tasks.load(scope);
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    return state;
  }
  private async persist(next: LocalRangeHold) {
    const { snapshot, hold } = await this.load(next.plan.takeoverId);
    if (hold.planHash !== next.planHash) throw Error('range_control_conflict');
    return this.options.control.updateRangeHold(snapshot.revision, next);
  }
  private async attention(takeoverId: string, phase: string) {
    const { hold } = await this.load(takeoverId);
    const ref = await this.options.objects.put({
      schemaVersion: 'local-range-attention-v1',
      planHash: hold.planHash,
      phase,
      code: 'control_step_unverified',
    });
    return this.persist(
      parseLocalRangeHold({
        ...hold,
        evidence: [...hold.evidence, { phase: 'needs_attention', workerKey: null, ref }],
      }),
    );
  }
  async commit(inputScope: Scope, inputMessage: Message): Promise<AppState> {
    localRecordHash({ inputScope, inputMessage });
    const scope = structuredClone(inputScope),
      message = structuredClone(inputMessage);
    const intent = parseWorkspaceControl(message.display);
    if (intent?.verb !== 'takeover') throw Error('workspace_control_not_available');
    assertLocalControlMessage(message, {
      ...scope,
      actionId: intent.actionId,
      sourceMessageId: message.msgId,
      expectedRevision: intent.expectedRevision,
    });
    const takeoverId = `takeover:${intent.actionId}`;
    const snapshot = await this.options.control.snapshot();
    const old = (snapshot.rangeHolds ?? []).find((h) => h.plan.takeoverId === takeoverId);
    if (old) {
      const hold = parseLocalRangeHold(old);
      if (
        hold.plan.projectId !== scope.projectId ||
        hold.plan.taskId !== scope.taskId ||
        localRecordHash(hold.plan.sourceMessage) !==
          localRecordHash({ ...message, ts: hold.plan.sourceMessage.ts })
      )
        throw Error('range_control_conflict');
      const state = await this.task(scope);
      if (hold.controlStage === 'committed') {
        const canonical = state.messages.filter((m) => m.msgId === message.msgId);
        if (
          canonical.length !== 1 ||
          localRecordHash(canonical[0]) !== localRecordHash(hold.plan.sourceMessage)
        )
          throw Error('workspace_control_source_invalid');
        const sourceRef = await this.options.objects.getReference(localRangeSourceKey(hold.plan));
        const canonicalRef = hold.evidence.find((e) => e.phase === 'canonical')?.ref;
        if (!sourceRef || !canonicalRef) throw Error('range_control_needs_attention');
        await this.options.sources.verifySource(
          hold.plan,
          (await this.options.objects.get(sourceRef)) as LocalRangeSourceProof,
        );
        const proof = (await this.options.objects.get(
          canonicalRef,
        )) as import('./local-range-evidence').LocalRangeCanonicalProof;
        if (
          proof.sourceRef !== sourceRef ||
          proof.planHash !== hold.planHash ||
          proof.messageHash !== localRecordHash(hold.plan.sourceMessage)
        )
          throw Error('range_control_needs_attention');
        await this.options.sources.verifyCanonical(hold.plan, proof);
        // A replay reports persisted facts, including interrupted/attention.
        // It never calls hold(), reclaims a lease or resumes a context.
        return state;
      }
      throw Error('range_control_needs_attention');
    }
    if (snapshot.revision !== intent.expectedRevision) throw Error('registry_revision_conflict');
    const { hold, sourceRef } = await this.options.control.serializeRangeAdmission(async () => {
      if (localRecordHash(await this.options.control.snapshot()) !== localRecordHash(snapshot))
        throw Error('registry_revision_conflict');
      const initialState = await this.task(scope);
      if (
        initialState.humanGate ||
        initialState.messages.some((m) => m.msgId === message.msgId) ||
        snapshot.operations.some((o) => o.actionId === intent.actionId)
      )
        throw Error('range_control_conflict');
      const prepared = await this.options.sources.prepare(scope, message);
      const hold = parseLocalRangeHold({
        plan: prepared.plan,
        planHash: localRecordHash(prepared.plan),
        controlStage: 'prepared',
        stage: 'requested',
        evidence: [],
        returnMessage: null,
      });
      if (
        hold.plan.takeoverId !== takeoverId ||
        hold.plan.projectId !== scope.projectId ||
        hold.plan.taskId !== scope.taskId ||
        hold.plan.expectedRevision !== snapshot.revision ||
        localRecordHash(hold.plan.sourceMessage) !== localRecordHash(message) ||
        prepared.proof.planHash !== hold.planHash ||
        prepared.proof.registryHash !== localRecordHash(snapshot)
      )
        throw Error('range_control_source_invalid');
      await this.options.sources.verifySource(hold.plan, prepared.proof);
      const sourceRef = await this.options.objects.put(prepared.proof);
      await this.options.objects.bindReference(localRangeSourceKey(hold.plan), sourceRef);
      await this.options.control.updateRangeHold(snapshot.revision, hold);
      return { hold, sourceRef };
    });
    try {
      const state = await this.task(scope);
      if (state.humanGate || state.messages.some((m) => m.msgId === message.msgId))
        throw Error('range_control_conflict');
      const committed = await this.options.tasks.compareAndCommit(scope, state, [
        appendMutation('messages', message),
      ]);
      const canonical = {
        schemaVersion: 'local-range-canonical-v1' as const,
        planHash: hold.planHash,
        sourceRef,
        messageHash: localRecordHash(message),
      };
      await this.options.sources.verifyCanonical(hold.plan, canonical);
      const ref = await this.options.objects.put(canonical);
      await this.persist(
        parseLocalRangeHold({
          ...hold,
          controlStage: 'committed',
          evidence: [{ phase: 'canonical', workerKey: null, ref }],
        }),
      );
      return committed.state;
    } catch (cause) {
      try {
        await this.attention(takeoverId, 'canonical');
      } catch (evidence) {
        throw new AggregateError([cause, evidence], 'range_control_needs_attention');
      }
      throw Error('range_control_needs_attention', { cause });
    }
  }
  hold(takeoverId: string): Promise<LocalRangeHold> {
    const existing = this.holds.get(takeoverId);
    if (existing) return existing;
    const result = this.close(takeoverId);
    this.holds.set(takeoverId, result);
    return result;
  }
  private async close(takeoverId: string): Promise<LocalRangeHold> {
    const { hold } = await this.load(takeoverId);
    if (hold.stage === 'heldByLeader') {
      const view = await this.view(takeoverId);
      if (!view.editable) throw Error('range_control_needs_attention');
      return hold;
    }
    if (
      hold.controlStage !== 'committed' ||
      hold.stage !== 'requested' ||
      hold.evidence.some((e) => e.phase === 'needs_attention')
    )
      throw Error('range_control_needs_attention');
    const sourceRef = await this.options.objects.getReference(localRangeSourceKey(hold.plan));
    if (!sourceRef) throw Error('range_control_source_invalid');
    // Durable uncertainty precedes the external close call. A restarted controller
    // cannot silently repeat a close whose outcome is missing from the journal.
    await this.attention(takeoverId, 'closing_requested');
    try {
      const source = (await this.options.objects.get(sourceRef)) as LocalRangeSourceProof;
      await this.options.sources.verifySource(hold.plan, source);
      await this.options.sources.verifyCurrentRootAndGrant(hold.plan);
      const workers = await this.options.lifecycle.closeWorkers(hold, sourceRef);
      if (
        workers.length !== hold.plan.cohort.length ||
        new Set(workers.map(key)).size !== workers.length
      )
        throw Error('range_worker_proof_invalid');
      for (const assignment of hold.plan.cohort) {
        const worker = workers.find((w) => key(w) === key(assignment));
        if (
          worker?.schemaVersion !== 'local-range-worker-closed-v1' ||
          worker.planHash !== hold.planHash ||
          worker.sourceRef !== sourceRef ||
          worker.sessionId !== assignment.sessionId ||
          !['paused', 'done', 'failed'].includes(worker.status) ||
          !worker.closed ||
          !worker.leaseReleased
        )
          throw Error('range_worker_proof_invalid');
        await this.options.sources.verifyWorker(hold.plan, worker);
        const { hold: current } = await this.load(takeoverId);
        const ref = await this.options.objects.put(worker);
        await this.persist(
          parseLocalRangeHold({
            ...current,
            evidence: [
              ...current.evidence,
              { phase: 'worker_closed', workerKey: key(assignment), ref },
            ],
          }),
        );
      }
      const writersProofRef = await this.options.lifecycle.proveWriters(hold, sourceRef, workers);
      const { hold: current } = await this.load(takeoverId);
      const proof: LocalRangeHeldProof = {
        schemaVersion: 'local-range-held-v1',
        planHash: hold.planHash,
        sourceRef,
        workerProofs: hold.plan.cohort.map(
          (c) =>
            current.evidence.find((e) => e.phase === 'worker_closed' && e.workerKey === key(c))
              ?.ref as string,
        ),
        writersProofRef,
      };
      await this.options.sources.verifyWriters(hold.plan, proof);
      await this.options.sources.verifyCurrentRootAndGrant(hold.plan);
      const ref = await this.options.objects.put(proof);
      return this.persist(
        parseLocalRangeHold({
          ...current,
          stage: 'heldByLeader',
          evidence: [...current.evidence, { phase: 'held', workerKey: null, ref }],
        }),
      );
    } catch (cause) {
      try {
        await this.attention(takeoverId, 'closure');
      } catch (evidence) {
        throw new AggregateError([cause, evidence], 'range_control_needs_attention');
      }
      throw Error('range_control_needs_attention', { cause });
    }
  }
  async view(takeoverId: string) {
    const { hold } = await this.load(takeoverId);
    return reconcileLocalRangeEvidence(hold, {
      ...this.options.sources,
      objects: this.options.objects,
      // Preserve methods on concrete source instances rather than spreading prototypes.
      verifySource: this.options.sources.verifySource.bind(this.options.sources),
      verifyCanonical: this.options.sources.verifyCanonical.bind(this.options.sources),
      verifyWorker: this.options.sources.verifyWorker.bind(this.options.sources),
      verifyWriters: this.options.sources.verifyWriters.bind(this.options.sources),
      verifyCurrentRootAndGrant: this.options.sources.verifyCurrentRootAndGrant.bind(
        this.options.sources,
      ),
    });
  }
}
