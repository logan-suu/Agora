/** Native full-version capture and private/canonical return reconciliation.
 * Historical reads never touch a source root or repair missing control facts. */
import {
  type AppState,
  type Message,
  parseWorkspaceControl,
  workspaceRangeResumes,
  workspaceVersionChanges,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import type { LocalNativeRangeSources } from './local-native-range-sources';
import { localWorkspacePhysical } from './local-range-admission';
import {
  type LocalRangeHeldProof,
  type LocalRangeSourceProof,
  type LocalRangeWorkerProof,
  localRangeSourceKey,
} from './local-range-evidence';
import {
  type LocalRangeHold,
  localRangesOverlap,
  parseLocalRangeHold,
} from './local-range-records';
import { assertLocalRangeResumeOwnership } from './local-range-resume-ownership';
import {
  type LocalRangeReleasedProof,
  type LocalRangeReturnCapture,
  type LocalRangeReturnInvalidation,
  type LocalRangeReturnRequest,
  localRangeChangeMessage,
  type LocalRangeReturnEvidence as ReturnPort,
} from './local-range-return-controller';
import { deriveLocalRangeTargets, type LocalRangeTargets } from './local-range-targets';
import type { LocalRangeWritersEvidence } from './local-range-writers-evidence';
import {
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';
import type { LocalVersionStore } from './local-version-store';
import { localRootBinding } from './local-workspace-authority';

type Scope = { projectId: string; taskId: string };
type Options = {
  control: Pick<LocalBindingCoordinator, 'snapshot' | 'assertClosed'>;
  objects: LocalControlObjects;
  sources: LocalNativeRangeSources;
  writers: LocalRangeWritersEvidence;
  versions: LocalVersionStore;
  tasks: { load(scope: Scope): Promise<AppState | undefined> };
  /** Actual current TESTER/REVIEWER dispatch, validation source and version
   * qualification. Missing role evidence must stop before external Fork. */
  verifyRoleEligibility?(state: AppState, workerId: string): Promise<void>;
};
function fail(): never {
  throw Error('range_return_evidence_invalid');
}
function exact(value: unknown, keys: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys
  )
    fail();
}
const key = (v: Scope) => `${v.projectId}/${v.taskId}`;
export class LocalRangeReturnEvidence implements ReturnPort {
  private resumeReader: ((hold: LocalRangeHold, proofRef: string) => Promise<unknown>) | undefined;
  constructor(private readonly options: Options) {}
  setResumeReader(reader: (hold: LocalRangeHold, proofRef: string) => Promise<unknown>) {
    if (this.resumeReader && this.resumeReader !== reader)
      throw Error('range_resume_reader_already_bound');
    this.resumeReader = reader;
  }
  async verifyResumeAdmission(hold: LocalRangeHold, scope: Scope & { workerId: string }) {
    const ref = hold.evidence.find((e) => e.phase === 'released')?.ref,
      captureRef = hold.evidence.find((e) => e.phase === 'captured')?.ref;
    if (hold.stage !== 'released' || !ref || !captureRef) fail();
    await this.verifyReleased(
      hold,
      (await this.options.objects.get(ref)) as LocalRangeReleasedProof,
    );
    await this.options.sources.verifyCurrentRootAndGrant(hold.plan);
    const state = await this.options.control.assertClosed(scope),
      worker = state.workers.find((w) => w.workerId === scope.workerId);
    if (state.humanGate || !worker || worker.status !== 'paused') fail();
    const registry = await this.options.control.snapshot(),
      sourceRef = await this.options.objects.getReference(localRangeSourceKey(hold.plan));
    if (!sourceRef) fail();
    const source = (await this.options.objects.get(sourceRef)) as LocalRangeSourceProof,
      original = parseLocalRegistry(await this.options.objects.get(source.registryHash));
    assertLocalRangeResumeOwnership(state, original, registry, scope.workerId);
    if (['TESTER', 'REVIEWER'].includes(worker.role)) {
      if (!this.options.verifyRoleEligibility) throw Error('range_resume_role_evidence_required');
      await this.options.verifyRoleEligibility(state, scope.workerId);
    }
    const binding = state.localExecution?.bindings.find((b) => b.workerId === scope.workerId),
      workspace =
        state.localExecution?.workspaces.find((w) => w.workspaceId === binding?.workspaceId) ??
        (['PM', 'COORDINATOR'].includes(worker.role)
          ? state.localExecution?.workspaces.find((w) =>
              localRangesOverlap(localWorkspacePhysical(registry, w), hold.plan.physical),
            )
          : undefined);
    const grant = registry.grants.find(
      (g) => g.grantId === workspace?.grantId && g.projectId === scope.projectId,
    );
    if (
      !workspace ||
      !grant ||
      grant.status !== 'active' ||
      !grant.actions.includes('read') ||
      (worker.role === 'CODER' && !grant.actions.includes('edit'))
    )
      fail();
    const bound = this.root(hold, registry),
      capture = (await this.options.objects.get(captureRef)) as LocalRangeReturnCapture;
    await this.options.versions.verify(
      capture.returnedVersion,
      bound.scope,
      localRootBinding(bound.root),
      async () => {
        await this.options.sources.verifyCurrentRootAndGrant(hold.plan);
        const current = await this.options.control.snapshot();
        return current.revision === registry.revision;
      },
    );
  }
  private async held(hold: LocalRangeHold) {
    const ref = hold.evidence.find((e) => e.phase === 'held')?.ref;
    if (!ref) fail();
    const proof = (await this.options.objects.get(ref)) as LocalRangeHeldProof;
    exact(proof, 'planHash,schemaVersion,sourceRef,workerProofs,writersProofRef');
    if (
      proof.schemaVersion !== 'local-range-held-v1' ||
      proof.planHash !== hold.planHash ||
      proof.sourceRef !==
        (await this.options.objects.getReference(localRangeSourceKey(hold.plan))) ||
      localRecordHash(proof.workerProofs) !==
        localRecordHash(
          hold.plan.cohort.map(
            (c) =>
              hold.evidence.find(
                (e) => e.phase === 'worker_closed' && e.workerKey === `${key(c)}/${c.workerId}`,
              )?.ref,
          ),
        )
    )
      fail();
    const source = (await this.options.objects.get(proof.sourceRef)) as LocalRangeSourceProof;
    await this.options.sources.verifySource(hold.plan, source);
    const canonical = hold.evidence.find((e) => e.phase === 'canonical')?.ref;
    if (!canonical) fail();
    await this.options.sources.verifyCanonical(
      hold.plan,
      (await this.options.objects.get(
        canonical,
      )) as import('./local-range-evidence').LocalRangeCanonicalProof,
    );
    for (const workerRef of proof.workerProofs)
      await this.options.sources.verifyWorker(
        hold.plan,
        (await this.options.objects.get(workerRef)) as LocalRangeWorkerProof,
      );
    const writers = await this.options.writers.read(hold.plan, proof);
    const closedRegistry = parseLocalRegistry(await this.options.objects.get(writers.registryHash));
    const bound = this.root(hold, closedRegistry);
    const manifest = await this.options.versions.read(writers.heldVersion, bound.scope);
    if (manifest.bindingHash !== localRecordHash(localRootBinding(bound.root))) fail();
    return { ref, proof, source, writers };
  }
  async verifyHeld(hold: LocalRangeHold) {
    await this.held(parseLocalRangeHold(hold));
  }
  private async request(hold: LocalRangeHold, requestRef: string) {
    if (
      !hold.returnMessage ||
      hold.evidence.find((e) => e.phase === 'return_requested')?.ref !== requestRef
    )
      fail();
    const request = (await this.options.objects.get(requestRef)) as LocalRangeReturnRequest;
    exact(request, 'heldProofRef,messageHash,planHash,registryHash,schemaVersion,sourceRef');
    const held = await this.held(hold);
    if (
      request.schemaVersion !== 'local-range-return-request-v1' ||
      request.planHash !== hold.planHash ||
      request.sourceRef !== held.proof.sourceRef ||
      request.heldProofRef !== held.ref ||
      request.messageHash !== localRecordHash(hold.returnMessage)
    )
      fail();
    const registry = parseLocalRegistry(await this.options.objects.get(request.registryHash));
    const old = registry.rangeHolds?.find((h) => h.plan.takeoverId === hold.plan.takeoverId);
    const intent = parseWorkspaceControl(hold.returnMessage.display);
    if (
      old?.stage !== 'heldByLeader' ||
      old.planHash !== hold.planHash ||
      intent?.verb !== 'return' ||
      intent.expectedRevision !== registry.revision
    )
      fail();
    const state = await this.options.tasks.load(hold.plan),
      messages = state?.messages.filter((m) => m.msgId === hold.returnMessage?.msgId);
    if (messages?.length !== 1 || localRecordHash(messages[0]) !== request.messageHash) fail();
    return { held, request };
  }
  private async states(registry: LocalRegistryRecords) {
    const states: AppState[] = [];
    for (const scope of new Map(
      registry.workspaces.map((w) => [key(w), { projectId: w.projectId, taskId: w.taskId }]),
    ).values())
      states.push(await this.options.control.assertClosed(scope));
    return states;
  }
  private impacts(targets: LocalRangeTargets, states: AppState[]) {
    return targets.tasks.map((task) => {
      const state = states.find((s) => key(s) === key(task));
      if (!state?.localExecution) fail();
      const workers = targets.workers.filter((w) => key(w) === key(task));
      // Dependencies also invalidate the affected worker's own current workspace.
      const workspaceIds = [
        ...new Set([...task.workspaceIds, ...workers.flatMap((w) => w.dependencyWorkspaceIds)]),
      ]
        .filter((id) => state.localExecution?.workspaces.some((w) => w.workspaceId === id))
        .sort();
      if (!workspaceIds.length) fail();
      return {
        projectId: task.projectId,
        taskId: task.taskId,
        stateHash: localRecordHash(state),
        workspaceIds,
        affectedWorkerIds: workers.map((w) => w.workerId).sort(),
      };
    });
  }
  private root(hold: LocalRangeHold, registry: LocalRegistryRecords) {
    const plan = hold.plan,
      workspace = registry.workspaces.find(
        (w) => key(w) === key(plan) && w.workspaceId === plan.workspaceId,
      );
    const grant = registry.grants.find(
      (g) => g.projectId === plan.projectId && g.grantId === plan.grantId,
    );
    const root =
      workspace?.mode === 'linked-worktree'
        ? registry.linkedRoots?.find(
            (r) => r.workspaceId === plan.workspaceId && key(r) === key(plan),
          )
        : registry.roots.find((r) => r.rootId === plan.rootId);
    if (
      !root ||
      !grant ||
      grant.rootId !== plan.rootId ||
      grant.revision !== plan.grantRevision ||
      !grant.actions.includes('read')
    )
      fail();
    return {
      root,
      grant,
      scope: {
        projectId: plan.projectId,
        taskId: plan.taskId,
        rootId: plan.rootId,
        policyHash: grant.policyHash,
      },
    };
  }
  async capture(hold: LocalRangeHold, requestRef: string): Promise<LocalRangeReturnCapture> {
    const { held } = await this.request(hold, requestRef);
    await this.options.sources.verifyCurrentRootAndGrant(hold.plan);
    await this.options.sources.verifyWriters(hold.plan, held.proof);
    const registry = await this.options.control.snapshot(),
      states = await this.states(registry),
      targets = deriveLocalRangeTargets(registry, states, hold.plan.physical),
      bound = this.root(hold, registry);
    if (targets.cohort.length || bound.grant.status !== 'active') fail();
    const check = async () => {
      await this.options.sources.verifyCurrentRootAndGrant(hold.plan);
      await this.options.sources.verifyWriters(hold.plan, held.proof);
      return localRecordHash(await this.options.control.snapshot()) === localRecordHash(registry);
    };
    const returnedVersion = await this.options.versions.capture(
      bound.scope,
      localRootBinding(bound.root),
      check,
    );
    if (!(await check())) fail();
    for (const state of states)
      if (localRecordHash(await this.options.tasks.load(state)) !== localRecordHash(state)) fail();
    const proof: LocalRangeReturnCapture = {
      schemaVersion: 'local-range-return-capture-v1',
      planHash: hold.planHash,
      sourceRef: held.proof.sourceRef,
      requestRef,
      heldProofRef: held.ref,
      registryHash: await this.options.objects.put(registry),
      targetsHash: await this.options.objects.put(targets),
      heldVersion: held.writers.heldVersion,
      returnedVersion,
      taskStateHashes: await Promise.all(
        states.map(async (s) => ({
          projectId: s.projectId,
          taskId: s.taskId,
          hash: await this.options.objects.put(s),
        })),
      ),
      tasks: this.impacts(targets, states),
    };
    await this.verifyCapture(hold, proof, true);
    return proof;
  }
  async verifyCapture(hold: LocalRangeHold, proof: LocalRangeReturnCapture, current: boolean) {
    exact(
      proof,
      'heldProofRef,heldVersion,planHash,registryHash,requestRef,returnedVersion,schemaVersion,sourceRef,targetsHash,taskStateHashes,tasks',
    );
    const { held } = await this.request(hold, proof.requestRef);
    if (
      proof.schemaVersion !== 'local-range-return-capture-v1' ||
      proof.planHash !== hold.planHash ||
      proof.sourceRef !== held.proof.sourceRef ||
      proof.heldProofRef !== held.ref ||
      localRecordHash(proof.heldVersion) !== localRecordHash(held.writers.heldVersion) ||
      !Array.isArray(proof.taskStateHashes) ||
      !proof.taskStateHashes.length ||
      proof.taskStateHashes.length > 4096 ||
      new Set(proof.taskStateHashes.map(key)).size !== proof.taskStateHashes.length
    )
      fail();
    const registry = parseLocalRegistry(await this.options.objects.get(proof.registryHash));
    const stored = registry.rangeHolds?.find((h) => h.plan.takeoverId === hold.plan.takeoverId);
    if (
      stored?.stage !== 'returnRequested' ||
      stored.planHash !== hold.planHash ||
      localRecordHash(stored.returnMessage) !== localRecordHash(hold.returnMessage)
    )
      fail();
    const states: AppState[] = [];
    for (const task of proof.taskStateHashes) {
      exact(task, 'hash,projectId,taskId');
      const state = (await this.options.objects.get(task.hash)) as AppState;
      if (key(state) !== key(task)) fail();
      states.push(state);
    }
    const targets = deriveLocalRangeTargets(registry, states, hold.plan.physical);
    if (
      localRecordHash(await this.options.objects.get(proof.targetsHash)) !==
      localRecordHash(targets)
    )
      fail();
    if (
      targets.cohort.length ||
      localRecordHash(targets) !== proof.targetsHash ||
      localRecordHash(proof.tasks) !== localRecordHash(this.impacts(targets, states))
    )
      fail();
    const sourceState = states.find((s) => key(s) === key(hold.plan)),
      message = sourceState?.messages.find((m) => m.msgId === hold.returnMessage?.msgId);
    if (!message || localRecordHash(message) !== localRecordHash(hold.returnMessage)) fail();
    const bound = this.root(hold, registry);
    const manifest = await this.options.versions.read(proof.returnedVersion, bound.scope);
    if (manifest.bindingHash !== localRecordHash(localRootBinding(bound.root))) fail();
    if (current) {
      await this.options.sources.verifyCurrentRootAndGrant(hold.plan);
      await this.options.sources.verifyWriters(hold.plan, held.proof);
      await this.options.versions.verify(
        proof.returnedVersion,
        bound.scope,
        localRootBinding(bound.root),
        async () => {
          await this.options.sources.verifyCurrentRootAndGrant(hold.plan);
          await this.options.sources.verifyWriters(hold.plan, held.proof);
          return true;
        },
      );
    }
  }
  private async factMessages(
    hold: LocalRangeHold,
    proof: LocalRangeReturnCapture,
    captureRef: string,
  ) {
    const messages: (Scope & { message: Message; previousStateHash: string })[] = [];
    for (const task of proof.tasks) {
      const state = (await this.options.objects.get(task.stateHash)) as AppState;
      messages.push({
        projectId: task.projectId,
        taskId: task.taskId,
        message: localRangeChangeMessage(hold, proof, captureRef, state),
        previousStateHash: task.stateHash,
      });
    }
    return messages;
  }
  async verifyReleased(hold: LocalRangeHold, proof: LocalRangeReleasedProof) {
    exact(proof, 'captureRef,invalidationRef,planHash,requestRef,schemaVersion');
    if (
      proof.schemaVersion !== 'local-range-released-v1' ||
      proof.planHash !== hold.planHash ||
      proof.requestRef !== hold.evidence.find((e) => e.phase === 'return_requested')?.ref ||
      proof.captureRef !== hold.evidence.find((e) => e.phase === 'captured')?.ref ||
      proof.invalidationRef !== hold.evidence.find((e) => e.phase === 'invalidated')?.ref
    )
      fail();
    const capture = (await this.options.objects.get(proof.captureRef)) as LocalRangeReturnCapture;
    await this.verifyCapture(hold, capture, false);
    const invalidation = (await this.options.objects.get(
      proof.invalidationRef,
    )) as LocalRangeReturnInvalidation;
    exact(invalidation, 'captureRef,facts,planHash,schemaVersion');
    const expected = await this.factMessages(hold, capture, proof.captureRef);
    if (
      invalidation.schemaVersion !== 'local-range-return-invalidated-v1' ||
      invalidation.planHash !== hold.planHash ||
      invalidation.captureRef !== proof.captureRef ||
      localRecordHash(invalidation.facts) !==
        localRecordHash(
          expected.map((e) => ({
            projectId: e.projectId,
            taskId: e.taskId,
            messageId: e.message.msgId,
            messageHash: localRecordHash(e.message),
            previousStateHash: e.previousStateHash,
          })),
        )
    )
      fail();
    for (const e of expected) {
      const state = await this.options.tasks.load(e),
        messages = state?.messages.filter((m) => m.msgId === e.message.msgId);
      if (messages?.length !== 1 || localRecordHash(messages[0]) !== localRecordHash(e.message))
        fail();
      if (!state || !workspaceVersionChanges(state).some((c) => c.changeId === e.message.msgId))
        fail();
    }
  }
  /** Attach to every same-owner coordinator facade. Arbitrary canonical hashes
   * cannot authorize a released range or current version qualification. */
  async verifyAdmission(registry: LocalRegistryRecords, state: AppState) {
    for (const fact of workspaceVersionChanges(state)) {
      const hold = registry.rangeHolds?.find((h) => h.plan.takeoverId === fact.takeoverId);
      if (!hold) fail();
      const capture = (await this.options.objects.get(
        fact.privateProofHash,
      )) as LocalRangeReturnCapture;
      if (hold.evidence.find((e) => e.phase === 'captured')?.ref !== fact.privateProofHash) fail();
      await this.verifyCapture(hold, capture, false);
      const expected = (await this.factMessages(hold, capture, fact.privateProofHash)).find(
        (e) => key(e) === key(state),
      );
      const actual = state.messages.filter((m) => m.msgId === fact.changeId);
      if (
        !expected ||
        actual.length !== 1 ||
        localRecordHash(expected.message) !== localRecordHash(actual[0]) ||
        localRecordHash(expected.message.payload) !== localRecordHash(fact)
      )
        fail();
    }
    for (const fact of workspaceRangeResumes(state)) {
      const hold = registry.rangeHolds?.find((h) => h.plan.takeoverId === fact.takeoverId);
      if (!hold || !this.resumeReader) fail();
      await this.resumeReader(hold, fact.privateProofHash);
    }
    for (const hold of registry.rangeHolds ?? [])
      if (hold.stage === 'released') {
        const ref = hold.evidence.find((e) => e.phase === 'released')?.ref;
        if (!ref) fail();
        await this.verifyReleased(
          hold,
          (await this.options.objects.get(ref)) as LocalRangeReleasedProof,
        );
      }
  }
}
