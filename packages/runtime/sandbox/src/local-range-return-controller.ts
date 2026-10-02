/** Trusted return saga. Only a fresh accepted request owns release work. Cold
 * readers and replays inspect immutable facts without capturing or resuming. */
import {
  type AppState,
  appendMutation,
  applyMutations,
  isLocalValidationReceipt,
  isWaveValidationReceipt,
  type Message,
  type Mutation,
  parseWorkspaceControl,
  type WorkspaceVersionChange,
  type WorkspaceVersionV1,
  workspaceVersionChanges,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import { localRangeSourceKey } from './local-range-evidence';
import { type LocalRangeHold, parseLocalRangeHold } from './local-range-records';
import { assertLocalControlMessage, localRecordHash } from './local-registry-records';

type Scope = { projectId: string; taskId: string };
export interface LocalRangeReturnRequest {
  schemaVersion: 'local-range-return-request-v1';
  planHash: string;
  sourceRef: string;
  heldProofRef: string;
  messageHash: string;
  registryHash: string;
}
export interface LocalRangeReturnCapture {
  schemaVersion: 'local-range-return-capture-v1';
  planHash: string;
  sourceRef: string;
  requestRef: string;
  heldProofRef: string;
  registryHash: string;
  targetsHash: string;
  heldVersion: WorkspaceVersionV1;
  returnedVersion: WorkspaceVersionV1;
  taskStateHashes: (Scope & { hash: string })[];
  tasks: (Scope & { stateHash: string; workspaceIds: string[]; affectedWorkerIds: string[] })[];
}
export interface LocalRangeReturnInvalidation {
  schemaVersion: 'local-range-return-invalidated-v1';
  planHash: string;
  captureRef: string;
  facts: (Scope & { messageId: string; messageHash: string; previousStateHash: string })[];
}
export interface LocalRangeReleasedProof {
  schemaVersion: 'local-range-released-v1';
  planHash: string;
  requestRef: string;
  captureRef: string;
  invalidationRef: string;
}
export interface LocalRangeReturnEvidence {
  /** Original native/session closure and immutable held version, without new
   * source access. Revocation must not prevent saving responsibility intent. */
  verifyHeld(hold: LocalRangeHold): Promise<void>;
  capture(hold: LocalRangeHold, requestRef: string): Promise<LocalRangeReturnCapture>;
  verifyCapture(
    hold: LocalRangeHold,
    proof: LocalRangeReturnCapture,
    current: boolean,
  ): Promise<void>;
  /** Historical native capture and all canonical per-task facts; no live restart. */
  verifyReleased(hold: LocalRangeHold, proof: LocalRangeReleasedProof): Promise<void>;
}
type Options = {
  control: Pick<
    LocalBindingCoordinator,
    'snapshot' | 'updateRangeHold' | 'serializeRangeAdmission'
  >;
  objects: Pick<LocalControlObjects, 'get' | 'put' | 'getReference'>;
  tasks: {
    load(scope: Scope): Promise<AppState | undefined>;
    compareAndCommit(
      scope: Scope,
      expected: AppState,
      mutations: readonly Mutation[],
    ): Promise<{ state: AppState; changed: boolean }>;
  };
  evidence: LocalRangeReturnEvidence;
  /** Fresh live return only; historical replay never calls this continuation. */
  onReleased?(hold: LocalRangeHold): Promise<void>;
  /** Post-commit facts use the host's task queue, outside the original request. */
  commitFacts?(
    scope: Scope,
    expected: AppState,
    mutations: readonly Mutation[],
  ): Promise<{ state: AppState; changed: boolean }>;
};
export function localRangeChangeMessage(
  hold: LocalRangeHold,
  capture: LocalRangeReturnCapture,
  captureRef: string,
  state: AppState,
): Message {
  const task = capture.tasks.find(
    (t) => t.projectId === state.projectId && t.taskId === state.taskId,
  );
  const source = hold.returnMessage;
  if (!task || !source || localRecordHash(state) !== task.stateHash || !state.localExecution)
    throw Error('range_return_capture_invalid');
  const changeId = `workspace-change:${localRecordHash({
    kind: 'local-range-change',
    captureRef,
    projectId: state.projectId,
    taskId: state.taskId,
  })}`;
  const invalidatedValidationIds = state.messages
    .filter(
      (m) =>
        m.fromRole === 'COORDINATOR' &&
        m.channelId === 'main' &&
        m.type === 'announce' &&
        ((isLocalValidationReceipt(m.payload) &&
          m.msgId === `workspace-validation:${m.payload.dispatchId}` &&
          m.payload.projectId === state.projectId &&
          m.payload.taskId === state.taskId) ||
          (isWaveValidationReceipt(m.payload) && m.msgId === m.payload.receiptId)),
    )
    .map((m) => m.msgId);
  const fact: WorkspaceVersionChange = {
    kind: 'workspace_version_change',
    version: 1,
    projectId: state.projectId,
    taskId: state.taskId,
    changeId,
    takeoverId: hold.plan.takeoverId,
    returnActionId: source.msgId,
    source: {
      projectId: hold.plan.projectId,
      taskId: hold.plan.taskId,
      msgId: source.msgId,
      workspaceId: hold.plan.workspaceId,
      rootId: hold.plan.rootId,
      grantId: hold.plan.grantId,
      grantRevision: hold.plan.grantRevision,
    },
    workspaceIds: [...task.workspaceIds],
    affectedWorkerIds: [...task.affectedWorkerIds],
    heldVersion: structuredClone(capture.heldVersion),
    returnedVersion: structuredClone(capture.returnedVersion),
    privateProofHash: captureRef,
    invalidatedValidationIds,
  };
  const message: Message = {
    msgId: changeId,
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    ts: source.ts,
    display:
      'Leader returned responsibility for the workspace. Current version evidence requires validation.',
    payload: { ...fact },
  };
  workspaceVersionChanges(applyMutations(state, [appendMutation('messages', message)]));
  return message;
}
export class LocalRangeReturnController {
  private readonly live = new Map<string, string>();
  private readonly releases = new Map<string, Promise<LocalRangeHold>>();
  constructor(private readonly options: Options) {}
  private async load(takeoverId: string) {
    const registry = await this.options.control.snapshot();
    const holds = (registry.rangeHolds ?? []).filter((h) => h.plan.takeoverId === takeoverId);
    if (holds.length !== 1) throw Error('range_control_missing');
    return { registry, hold: parseLocalRangeHold(holds[0]) };
  }
  private async task(scope: Scope) {
    const state = await this.options.tasks.load(scope);
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    return state;
  }
  private async attention(takeoverId: string, phase: string) {
    const { registry, hold } = await this.load(takeoverId);
    const ref = await this.options.objects.put({
      schemaVersion: 'local-range-attention-v1',
      planHash: hold.planHash,
      phase,
      code: 'control_step_unverified',
    });
    await this.options.control.updateRangeHold(
      registry.revision,
      parseLocalRangeHold({
        ...hold,
        evidence: [...hold.evidence, { phase: 'needs_attention', workerKey: null, ref }],
      }),
    );
  }
  private async request(hold: LocalRangeHold) {
    const ref = hold.evidence.find((e) => e.phase === 'return_requested')?.ref;
    if (!ref || !hold.returnMessage) throw Error('range_return_needs_attention');
    const request = (await this.options.objects.get(ref)) as LocalRangeReturnRequest;
    if (
      Object.keys(request).sort().join(',') !==
        'heldProofRef,messageHash,planHash,registryHash,schemaVersion,sourceRef' ||
      request.schemaVersion !== 'local-range-return-request-v1' ||
      request.planHash !== hold.planHash ||
      request.messageHash !== localRecordHash(hold.returnMessage) ||
      request.heldProofRef !== hold.evidence.find((e) => e.phase === 'held')?.ref ||
      request.sourceRef !==
        (await this.options.objects.getReference(localRangeSourceKey(hold.plan)))
    )
      throw Error('range_return_needs_attention');
    await this.options.objects.get(request.registryHash);
    const state = await this.task(hold.plan),
      messages = state.messages.filter((m) => m.msgId === hold.returnMessage?.msgId);
    if (messages.length !== 1 || localRecordHash(messages[0]) !== request.messageHash)
      throw Error('range_return_needs_attention');
    return { request, ref, state };
  }
  async commit(inputScope: Scope, inputMessage: Message): Promise<AppState> {
    localRecordHash({ inputScope, inputMessage });
    const scope = structuredClone(inputScope),
      message = structuredClone(inputMessage);
    const intent = parseWorkspaceControl(message.display);
    if (intent?.verb !== 'return') throw Error('workspace_control_not_available');
    assertLocalControlMessage(message, {
      ...scope,
      actionId: intent.actionId,
      sourceMessageId: message.msgId,
      expectedRevision: intent.expectedRevision,
    });
    const { registry, hold } = await this.load(intent.takeoverReceiptId);
    if (hold.plan.projectId !== scope.projectId || hold.plan.taskId !== scope.taskId)
      throw Error('range_return_conflict');
    if (hold.returnMessage) {
      if (
        localRecordHash({ ...message, ts: hold.returnMessage.ts }) !==
        localRecordHash(hold.returnMessage)
      )
        throw Error('range_return_conflict');
      const { state } = await this.request(hold);
      if (hold.stage === 'released') {
        const proofRef = hold.evidence.find((e) => e.phase === 'released')?.ref;
        if (!proofRef) throw Error('range_return_needs_attention');
        await this.options.evidence.verifyReleased(
          hold,
          (await this.options.objects.get(proofRef)) as LocalRangeReleasedProof,
        );
      }
      return state;
    }
    if (registry.revision !== intent.expectedRevision) throw Error('registry_revision_conflict');
    if (
      hold.stage !== 'heldByLeader' ||
      hold.controlStage !== 'committed' ||
      hold.evidence.map((e) => e.phase).lastIndexOf('needs_attention') >
        hold.evidence.map((e) => e.phase).lastIndexOf('held')
    )
      throw Error('range_return_needs_attention');
    await this.options.evidence.verifyHeld(hold);
    const sourceRef = await this.options.objects.getReference(localRangeSourceKey(hold.plan)),
      heldProofRef = hold.evidence.find((e) => e.phase === 'held')?.ref;
    if (!sourceRef || !heldProofRef) throw Error('range_return_needs_attention');
    const request: LocalRangeReturnRequest = {
      schemaVersion: 'local-range-return-request-v1',
      planHash: hold.planHash,
      sourceRef,
      heldProofRef,
      messageHash: localRecordHash(message),
      registryHash: await this.options.objects.put(registry),
    };
    const requestRef = await this.options.objects.put(request);
    try {
      const state = await this.task(scope);
      if (
        state.messages.some((m) => m.msgId === message.msgId) ||
        localRecordHash(await this.options.control.snapshot()) !== localRecordHash(registry)
      )
        throw Error('range_return_conflict');
      const committed = await this.options.tasks.compareAndCommit(scope, state, [
        appendMutation('messages', message),
      ]);
      const next = parseLocalRangeHold({
        ...hold,
        stage: 'returnRequested',
        returnMessage: message,
        evidence: [
          ...hold.evidence,
          { phase: 'return_requested', workerKey: null, ref: requestRef },
        ],
      });
      await this.options.control.updateRangeHold(registry.revision, next);
      await this.request(next);
      this.live.set(hold.plan.takeoverId, requestRef);
      return committed.state;
    } catch (cause) {
      await this.attention(hold.plan.takeoverId, 'return_request');
      throw Error('range_return_needs_attention', { cause });
    }
  }
  release(takeoverId: string): Promise<LocalRangeHold> {
    const existing = this.releases.get(takeoverId);
    if (existing) return existing;
    if (!this.live.has(takeoverId)) return Promise.reject(Error('range_return_not_live'));
    const result = this.finish(takeoverId);
    this.releases.set(takeoverId, result);
    return result;
  }
  private async finish(takeoverId: string): Promise<LocalRangeHold> {
    const { hold } = await this.load(takeoverId);
    const { ref: requestRef } = await this.request(hold);
    if (
      hold.stage !== 'returnRequested' ||
      this.live.get(takeoverId) !== requestRef ||
      hold.evidence.some((e) => e.phase === 'captured' || e.phase === 'invalidated')
    )
      throw Error('range_return_not_live');
    // A cold process never repeats a capture whose external outcome was uncertain.
    await this.attention(takeoverId, 'return_capture_requested');
    try {
      const capture = await this.options.evidence.capture(hold, requestRef);
      await this.options.evidence.verifyCapture(hold, capture, true);
      const captureRef = await this.options.objects.put(capture);
      let current = await this.load(takeoverId);
      await this.options.control.updateRangeHold(
        current.registry.revision,
        parseLocalRangeHold({
          ...current.hold,
          evidence: [
            ...current.hold.evidence,
            { phase: 'captured', workerKey: null, ref: captureRef },
          ],
        }),
      );
      const facts: LocalRangeReturnInvalidation['facts'] = [];
      if (
        !capture.tasks.length ||
        capture.tasks.length > 4096 ||
        new Set(capture.tasks.map((t) => `${t.projectId}/${t.taskId}`)).size !==
          capture.tasks.length
      )
        throw Error('range_return_capture_invalid');
      for (const task of capture.tasks) {
        const before = await this.task(task);
        if (localRecordHash(before) !== task.stateHash) throw Error('range_return_source_changed');
        const message = localRangeChangeMessage(hold, capture, captureRef, before);
        const mutations: Mutation[] = [appendMutation('messages', message)];
        if (this.options.commitFacts) await this.options.commitFacts(task, before, mutations);
        else await this.options.tasks.compareAndCommit(task, before, mutations);
        const after = await this.task(task),
          found = after.messages.filter((m) => m.msgId === message.msgId);
        if (found.length !== 1 || localRecordHash(found[0]) !== localRecordHash(message))
          throw Error('range_return_source_changed');
        facts.push({
          projectId: task.projectId,
          taskId: task.taskId,
          messageId: message.msgId,
          messageHash: localRecordHash(message),
          previousStateHash: task.stateHash,
        });
      }
      const invalidation: LocalRangeReturnInvalidation = {
        schemaVersion: 'local-range-return-invalidated-v1',
        planHash: hold.planHash,
        captureRef,
        facts,
      };
      const invalidationRef = await this.options.objects.put(invalidation);
      current = await this.load(takeoverId);
      await this.options.control.updateRangeHold(
        current.registry.revision,
        parseLocalRangeHold({
          ...current.hold,
          evidence: [
            ...current.hold.evidence,
            { phase: 'invalidated', workerKey: null, ref: invalidationRef },
          ],
        }),
      );
      const released: LocalRangeReleasedProof = {
        schemaVersion: 'local-range-released-v1',
        planHash: hold.planHash,
        requestRef,
        captureRef,
        invalidationRef,
      };
      await this.options.evidence.verifyReleased((await this.load(takeoverId)).hold, released);
      const completed = await this.options.control.serializeRangeAdmission(async () => {
        await this.options.evidence.verifyCapture(
          (await this.load(takeoverId)).hold,
          capture,
          true,
        );
        const releasedRef = await this.options.objects.put(released);
        const final = await this.load(takeoverId);
        return this.options.control.updateRangeHold(
          final.registry.revision,
          parseLocalRangeHold({
            ...final.hold,
            stage: 'released',
            evidence: [
              ...final.hold.evidence,
              { phase: 'released', workerKey: null, ref: releasedRef },
            ],
          }),
        );
      });
      await this.options.onReleased?.(completed);
      return completed;
    } catch (cause) {
      await this.attention(takeoverId, 'return_capture_or_invalidation_or_resume');
      throw Error('range_return_needs_attention', { cause });
    }
  }
  async view(takeoverId: string) {
    try {
      const { hold } = await this.load(takeoverId);
      await this.request(hold);
      if (hold.stage !== 'released')
        return {
          released: false,
          needsAttention: hold.evidence.some((e) => e.phase === 'needs_attention'),
        };
      const ref = hold.evidence.find((e) => e.phase === 'released')?.ref;
      if (!ref) throw Error('range_return_needs_attention');
      await this.options.evidence.verifyReleased(
        hold,
        (await this.options.objects.get(ref)) as LocalRangeReleasedProof,
      );
      const phases = hold.evidence.map((e) => e.phase);
      return {
        released: true,
        needsAttention:
          phases.lastIndexOf('needs_attention') >
          Math.max(phases.lastIndexOf('released'), phases.lastIndexOf('resume_registered')),
      };
    } catch {
      return { released: false, needsAttention: true };
    }
  }
}
