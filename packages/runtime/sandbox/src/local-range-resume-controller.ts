/** Live return continuation and read-only history are separate entry points.
 * An immutable start record prevents a cold process from repeating a Fork whose
 * external outcome was not recorded. No method here executes a model step. */
import {
  type AppState,
  appendMutation,
  applyMutations,
  type Message,
  type Mutation,
  type WorkspaceRangeResume,
  workspaceRangeResumes,
  workspaceVersionChanges,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalRangeWorkerProof } from './local-range-evidence';
import { type LocalRangeHold, parseLocalRangeHold } from './local-range-records';
import type { LocalRangeReleasedProof } from './local-range-return-controller';
import { localRangeAssignmentHash } from './local-range-targets';
import { localRecordHash } from './local-registry-records';
import type { WorkspaceRangeResumeRequest } from './workspace-range-port';

type Scope = { projectId: string; taskId: string };
export interface LocalRangeForkPlan extends Scope {
  schemaVersion: 'local-range-fork-plan-v1';
  planHash: string;
  releasedRef: string;
  changeId: string;
  takeoverId: string;
  returnActionId: string;
  actionId: string;
  workerId: string;
  role: string;
  sourceSessionId: string;
  sourceSafePointRef: string;
  resumeSessionId: string;
  assignmentHash: string;
  pausedStateHash: string;
}
export type LocalRangeForkEvidence = Scope & {
  sourceSessionId: string;
  childSessionId: string;
  role: string;
  cwd: string;
  boundary: number;
  seedLength: number;
  seedHash: string;
};
type Proof = {
  schemaVersion: 'local-range-resume-proof-v1';
  forkPlanRef: string;
  official: LocalRangeForkEvidence;
};
type Options = {
  control: Pick<LocalBindingCoordinator, 'snapshot' | 'updateRangeHold'>;
  objects: Pick<LocalControlObjects, 'get' | 'put' | 'bindReference' | 'getReference'>;
  tasks: {
    load(scope: Scope): Promise<AppState | undefined>;
    compareAndCommit(
      scope: Scope,
      state: AppState,
      mutations: readonly Mutation[],
    ): Promise<{ state: AppState; changed: boolean }>;
  };
  evidence: {
    verifyReleased(hold: LocalRangeHold, proof: LocalRangeReleasedProof): Promise<void>;
    verifyResumeAdmission(hold: LocalRangeHold, scope: Scope & { workerId: string }): Promise<void>;
  };
  /** Official factory with a closed deferred tool port; no worker lease or turn. */
  prepareFork(plan: LocalRangeForkPlan, state: AppState): Promise<void>;
  readFork(plan: LocalRangeForkPlan, fresh: boolean): Promise<LocalRangeForkEvidence>;
  /** All facts are durable before the host admits any selected worker. */
  register(
    request: WorkspaceRangeResumeRequest,
    verify: (workerId: string, phase: 'register' | 'execute') => Promise<void>,
  ): Promise<void>;
};
const workerKey = (s: Scope & { workerId: string }) => `${s.projectId}/${s.taskId}/${s.workerId}`;
const startKey = (planHash: string, worker: Scope & { workerId: string }) =>
  localRecordHash({ kind: 'range-fork-start', planHash, worker: workerKey(worker) });
function fail(): never {
  throw Error('range_resume_evidence_invalid');
}
function exact(v: unknown, keys: string) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== keys)
    fail();
}
function resumeMessage(hold: LocalRangeHold, plan: LocalRangeForkPlan, proofRef: string): Message {
  if (!hold.returnMessage) fail();
  const resumeId = `workspace-resume:${localRecordHash({ kind: 'range-resume-fact', proofRef })}`;
  const payload: WorkspaceRangeResume = {
    kind: 'workspace_range_resume',
    version: 1,
    projectId: plan.projectId,
    taskId: plan.taskId,
    resumeId,
    takeoverId: plan.takeoverId,
    returnActionId: plan.returnActionId,
    changeId: plan.changeId,
    workerId: plan.workerId,
    sourceSessionId: plan.sourceSessionId,
    sourceSafePointRef: plan.sourceSafePointRef,
    resumeSessionId: plan.resumeSessionId,
    privateProofHash: proofRef,
  };
  return {
    msgId: resumeId,
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    ts: hold.returnMessage.ts,
    display:
      'A fresh workspace session is registered. Execution still requires current permission and a new worker lease.',
    payload: { ...payload },
  };
}
export class LocalRangeResumeController {
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly liveProofs = new Map<string, string>();
  private readonly fullyRegistered = new Set<string>();
  constructor(private readonly options: Options) {}
  private async load(takeoverId: string) {
    const registry = await this.options.control.snapshot(),
      holds = registry.rangeHolds?.filter((h) => h.plan.takeoverId === takeoverId) ?? [];
    if (holds.length !== 1) fail();
    const hold = parseLocalRangeHold(holds[0]),
      ref = hold.evidence.find((e) => e.phase === 'released')?.ref;
    if (hold.stage !== 'released' || !ref || !hold.returnMessage) fail();
    await this.options.evidence.verifyReleased(
      hold,
      (await this.options.objects.get(ref)) as LocalRangeReleasedProof,
    );
    return { registry, hold, releasedRef: ref };
  }
  private async task(scope: Scope) {
    const state = await this.options.tasks.load(scope);
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId) fail();
    return state;
  }
  /** Only the fresh live return callback invokes this method. Repeated live calls
   * share a promise; persisted start evidence refuses cold repeat construction. */
  prepare(hold: LocalRangeHold): Promise<void> {
    const previous = this.preparations.get(hold.plan.takeoverId);
    if (previous) return previous;
    const result = this.finish(hold.plan.takeoverId);
    this.preparations.set(hold.plan.takeoverId, result);
    return result;
  }
  private async finish(takeoverId: string) {
    const initial = await this.load(takeoverId),
      plans: { plan: LocalRangeForkPlan; ref: string }[] = [];
    // Reject any ineligible cohort member before constructing an external
    // child for the first member. Each member is rechecked again at its CAS.
    for (const assignment of initial.hold.plan.cohort) {
      const state = await this.task(assignment),
        worker = state.workers.find((w) => w.workerId === assignment.workerId);
      if (!worker) fail();
      if (worker.status === 'done' || worker.status === 'failed') continue;
      if (
        state.humanGate ||
        worker.status !== 'paused' ||
        worker.sessionId !== assignment.sessionId ||
        !worker.safePoint ||
        localRangeAssignmentHash(state, worker.workerId) !== assignment.assignmentHash
      )
        throw Error('range_resume_not_admissible');
      if (await this.options.objects.getReference(startKey(initial.hold.planHash, assignment)))
        throw Error('range_resume_not_live');
      await this.options.evidence.verifyResumeAdmission(initial.hold, assignment);
    }
    for (const assignment of initial.hold.plan.cohort) {
      const state = await this.task(assignment),
        worker = state.workers.find((w) => w.workerId === assignment.workerId);
      if (!worker) fail();
      // A natural terminal worker is historical; return cannot reopen it.
      if (worker.status === 'done' || worker.status === 'failed') continue;
      if (
        state.humanGate ||
        worker.status !== 'paused' ||
        worker.sessionId !== assignment.sessionId ||
        !worker.safePoint ||
        localRangeAssignmentHash(state, worker.workerId) !== assignment.assignmentHash
      )
        throw Error('range_resume_not_admissible');
      const closedRef = initial.hold.evidence.find(
        (e) => e.phase === 'worker_closed' && e.workerKey === workerKey(assignment),
      )?.ref;
      if (!closedRef) fail();
      const closed = (await this.options.objects.get(closedRef)) as LocalRangeWorkerProof;
      if (
        closed.status !== 'paused' ||
        closed.sessionId !== worker.sessionId ||
        closed.safePointRef !== worker.safePoint ||
        closed.workerId !== worker.workerId ||
        closed.projectId !== state.projectId ||
        closed.taskId !== state.taskId ||
        closed.planHash !== initial.hold.planHash
      )
        fail();
      const changes = workspaceVersionChanges(state).filter(
        (c) =>
          c.takeoverId === takeoverId &&
          c.returnActionId === initial.hold.returnMessage?.msgId &&
          c.affectedWorkerIds.includes(worker.workerId),
      );
      if (changes.length !== 1) fail();
      await this.options.evidence.verifyResumeAdmission(initial.hold, assignment);
      const pausedStateHash = await this.options.objects.put(state);
      const seed = {
        planHash: initial.hold.planHash,
        releasedRef: initial.releasedRef,
        changeId: changes[0]?.changeId,
        worker: workerKey(assignment),
        sourceSafePointRef: worker.safePoint,
      };
      const plan: LocalRangeForkPlan = {
        schemaVersion: 'local-range-fork-plan-v1',
        projectId: state.projectId,
        taskId: state.taskId,
        planHash: initial.hold.planHash,
        releasedRef: initial.releasedRef,
        changeId: changes[0]?.changeId as string,
        takeoverId,
        returnActionId: initial.hold.returnMessage?.msgId as string,
        actionId: initial.hold.plan.sourceMessage.msgId,
        workerId: worker.workerId,
        role: worker.role,
        sourceSessionId: worker.sessionId,
        sourceSafePointRef: worker.safePoint,
        resumeSessionId: `range-child:${localRecordHash(seed)}`,
        assignmentHash: assignment.assignmentHash,
        pausedStateHash,
      };
      const k = startKey(initial.hold.planHash, assignment);
      if (await this.options.objects.getReference(k)) throw Error('range_resume_not_live');
      const planRef = await this.options.objects.put(plan);
      await this.options.objects.bindReference(k, planRef);
      // The closed port must remain inert until later worker lease acquisition.
      const beforeFork = await this.load(takeoverId),
        attentionRef = await this.options.objects.put({
          schemaVersion: 'local-range-attention-v1',
          planHash: initial.hold.planHash,
          phase: 'resume_fork_requested',
          code: 'control_step_unverified',
          workerKey: workerKey(plan),
          forkPlanRef: planRef,
        });
      await this.options.control.updateRangeHold(
        beforeFork.registry.revision,
        parseLocalRangeHold({
          ...beforeFork.hold,
          evidence: [
            ...beforeFork.hold.evidence,
            { phase: 'needs_attention', workerKey: null, ref: attentionRef },
          ],
        }),
      );
      await this.options.prepareFork(plan, structuredClone(state));
      if (localRecordHash(await this.task(assignment)) !== pausedStateHash)
        throw Error('range_resume_source_changed');
      await this.options.evidence.verifyResumeAdmission(
        (await this.load(takeoverId)).hold,
        assignment,
      );
      const official = await this.options.readFork(plan, true);
      const proof: Proof = {
        schemaVersion: 'local-range-resume-proof-v1',
        forkPlanRef: planRef,
        official,
      };
      const ref = await this.options.objects.put(proof),
        message = resumeMessage(initial.hold, plan, ref);
      workspaceRangeResumes(applyMutations(state, [appendMutation('messages', message)]));
      await this.verifyShape(initial.hold, proof, ref, false);
      await this.options.tasks.compareAndCommit(assignment, state, [
        appendMutation('messages', message),
      ]);
      let current = await this.load(takeoverId);
      await this.options.control.updateRangeHold(
        current.registry.revision,
        parseLocalRangeHold({
          ...current.hold,
          evidence: [
            ...current.hold.evidence,
            { phase: 'resume_registered', workerKey: workerKey(assignment), ref },
          ],
        }),
      );
      current = await this.load(takeoverId);
      await this.read(current.hold, ref);
      plans.push({ plan, ref });
    }
    // Registration is performed only after all selected canonical/private facts
    // closed; an earlier failed prefix never dispatches a subset automatically.
    const groups = new Map<string, typeof plans>();
    for (const p of plans) {
      const k = `${p.plan.projectId}/${p.plan.taskId}`;
      groups.set(k, [...(groups.get(k) ?? []), p]);
      this.liveProofs.set(workerKey(p.plan), p.ref);
    }
    for (const group of groups.values()) {
      const first = group[0];
      if (!first) fail();
      await this.options.register(
        {
          projectId: first.plan.projectId,
          taskId: first.plan.taskId,
          actionId: first.plan.actionId,
          workers: group.map(({ plan: p }) => ({
            workerId: p.workerId,
            sourceSessionId: p.sourceSessionId,
            sourceSafePointRef: p.sourceSafePointRef,
            resumeSessionId: p.resumeSessionId,
          })),
        },
        async (id, phase) => {
          const member = group.find((p) => p.plan.workerId === id);
          if (!member) fail();
          if (phase === 'execute' && !this.fullyRegistered.has(takeoverId))
            throw Error('range_resume_registration_incomplete');
          await this.verifyLive(member.plan, member.ref);
        },
      );
    }
    this.fullyRegistered.add(takeoverId);
  }
  private async verifyShape(hold: LocalRangeHold, proof: Proof, ref: string, canonical: boolean) {
    exact(proof, 'forkPlanRef,official,schemaVersion');
    if (proof.schemaVersion !== 'local-range-resume-proof-v1' || localRecordHash(proof) !== ref)
      fail();
    const plan = (await this.options.objects.get(proof.forkPlanRef)) as LocalRangeForkPlan;
    exact(
      plan,
      'actionId,assignmentHash,changeId,pausedStateHash,planHash,projectId,releasedRef,resumeSessionId,returnActionId,role,schemaVersion,sourceSafePointRef,sourceSessionId,takeoverId,taskId,workerId',
    );
    const assignment = hold.plan.cohort.find((c) => workerKey(c) === workerKey(plan));
    const original = (await this.options.objects.get(plan.pausedStateHash)) as AppState,
      worker = original.workers.find((w) => w.workerId === plan.workerId);
    const change = workspaceVersionChanges(original).find((c) => c.changeId === plan.changeId);
    if (
      !assignment ||
      plan.schemaVersion !== 'local-range-fork-plan-v1' ||
      plan.planHash !== hold.planHash ||
      plan.releasedRef !== hold.evidence.find((e) => e.phase === 'released')?.ref ||
      plan.takeoverId !== hold.plan.takeoverId ||
      plan.actionId !== hold.plan.sourceMessage.msgId ||
      plan.returnActionId !== hold.returnMessage?.msgId ||
      !change ||
      !change.affectedWorkerIds.includes(plan.workerId) ||
      change.takeoverId !== plan.takeoverId ||
      change.returnActionId !== plan.returnActionId ||
      original.projectId !== plan.projectId ||
      original.taskId !== plan.taskId ||
      original.humanGate ||
      worker?.status !== 'paused' ||
      worker.sessionId !== plan.sourceSessionId ||
      worker.safePoint !== plan.sourceSafePointRef ||
      worker.role !== plan.role ||
      localRangeAssignmentHash(original, plan.workerId) !== plan.assignmentHash ||
      assignment.assignmentHash !== plan.assignmentHash ||
      assignment.sessionId !== plan.sourceSessionId ||
      plan.resumeSessionId !==
        `range-child:${localRecordHash({
          planHash: plan.planHash,
          releasedRef: plan.releasedRef,
          changeId: plan.changeId,
          worker: workerKey(plan),
          sourceSafePointRef: plan.sourceSafePointRef,
        })}` ||
      (await this.options.objects.getReference(startKey(hold.planHash, plan))) !== proof.forkPlanRef
    )
      fail();
    exact(
      proof.official,
      'boundary,childSessionId,cwd,projectId,role,seedHash,seedLength,sourceSessionId,taskId',
    );
    if (
      proof.official.sourceSessionId !== plan.sourceSessionId ||
      proof.official.childSessionId !== plan.resumeSessionId ||
      proof.official.projectId !== plan.projectId ||
      proof.official.taskId !== plan.taskId ||
      proof.official.role !== plan.role ||
      proof.official.seedLength !== proof.official.boundary + 1 ||
      !/^[a-f0-9]{64}$/.test(proof.official.seedHash) ||
      localRecordHash(await this.options.readFork(plan, !canonical)) !==
        localRecordHash(proof.official)
    )
      fail();
    if (canonical) {
      const state = await this.task(plan),
        expected = resumeMessage(hold, plan, ref),
        messages = state.messages.filter((m) => m.msgId === expected.msgId);
      workspaceRangeResumes(state);
      if (
        messages.length !== 1 ||
        localRecordHash(messages[0]) !== localRecordHash(expected) ||
        hold.evidence.find(
          (e) => e.phase === 'resume_registered' && e.workerKey === workerKey(plan),
        )?.ref !== ref
      )
        fail();
    }
    return plan;
  }
  async read(hold: LocalRangeHold, ref: string) {
    const loaded = await this.load(hold.plan.takeoverId);
    if (loaded.hold.planHash !== hold.planHash) fail();
    return this.verifyShape(loaded.hold, (await this.options.objects.get(ref)) as Proof, ref, true);
  }
  private async verifyLive(plan: LocalRangeForkPlan, ref: string) {
    if (this.liveProofs.get(workerKey(plan)) !== ref) throw Error('range_resume_not_live');
    const { hold } = await this.load(plan.takeoverId);
    await this.read(hold, ref);
    const state = await this.task(plan),
      worker = state.workers.find((w) => w.workerId === plan.workerId);
    if (
      state.humanGate ||
      worker?.status !== 'paused' ||
      worker.sessionId !== plan.sourceSessionId ||
      worker.safePoint !== plan.sourceSafePointRef ||
      localRangeAssignmentHash(state, plan.workerId) !== plan.assignmentHash
    )
      throw Error('range_resume_not_admissible');
    if (
      localRecordHash(await this.options.readFork(plan, true)) !==
      localRecordHash(((await this.options.objects.get(ref)) as Proof).official)
    )
      fail();
    await this.options.evidence.verifyResumeAdmission(hold, plan);
  }
}
