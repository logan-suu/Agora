/** Canonical result closure for a freshly admitted undo. Cross-task facts use
 * CAS, retain historical approvals/workers, and precede claim release. Cold
 * or interrupted attempts are strictly read-only; they never finish a saga. */
import {
  type AppState,
  appendMutation,
  applyMutations,
  isLocalValidationReceipt,
  isWaveValidationReceipt,
  type Message,
  type Mutation,
  type WorkspaceUndoResult,
  workspaceUndoResults,
} from '@agora/core-domain';
import type { LocalBindingCoordinator, LocalBindingRequest } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import { localWorkspacePhysical } from './local-range-admission';
import { deriveLocalRangeTargets } from './local-range-targets';
import {
  isLocalBindingOperation,
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from './local-registry-records';
import type { LocalUndoAuthority, LocalUndoCall } from './local-undo-authority';
import type { LocalUndoBatch, LocalUndoBatchResult } from './local-undo-batch';
import type { LocalUndoProposalStore } from './local-undo-proposal';

type Scope = { projectId: string; taskId: string };
type Options = {
  control: LocalBindingCoordinator;
  objects: LocalControlObjects;
  authority: LocalUndoAuthority;
  batch: LocalUndoBatch;
  proposals: LocalUndoProposalStore;
  /** Host lock order is task queue, then the short registry admission lane. */
  serializeTask?<T>(scope: Scope, work: () => Promise<T>): Promise<T>;
  tasks: {
    load(scope: Scope): Promise<AppState | undefined>;
    compareAndCommit(
      scope: Scope,
      expected: AppState,
      mutations: readonly Mutation[],
    ): Promise<{ state: AppState; changed: boolean }>;
  };
};
type Qualification = Awaited<ReturnType<LocalUndoBatch['verifyCurrent']>>;
type Draft = {
  schemaVersion: 'local-undo-completion-draft-v2';
  call: LocalUndoCall;
  registryHash: string;
  stateHashes: string[];
  nativeResultHash: string;
  qualificationHash: string | null;
  qualificationFailure: string | null;
  stage: LocalUndoBatchResult['stage'];
};
type Complete = {
  schemaVersion: 'local-undo-completion-v1';
  draftHash: string;
  facts: (Scope & { messageId: string; messageHash: string })[];
};
export type LocalUndoCompleted = {
  stage: LocalUndoBatchResult['stage'];
  native: LocalUndoBatchResult;
  closureReceiptId: string | null;
  facts: Complete['facts'];
};
const keyFor = (call: LocalUndoCall, phase: string) =>
  localRecordHash({ kind: 'local-undo-completion', call, phase });
const closureAction = (call: LocalUndoCall) => `undo-close:${keyFor(call, 'closure')}`;
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
const exact = (v: unknown, keys: string): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys;
function fail(): never {
  throw Error('undo_completion_unverified');
}
function validationIds(state: AppState): string[] {
  return state.messages
    .filter(
      (m) =>
        m.fromRole === 'COORDINATOR' &&
        m.channelId === 'main' &&
        m.type === 'announce' &&
        ((isLocalValidationReceipt(m.payload) &&
          m.msgId === `workspace-validation:${m.payload.dispatchId}`) ||
          (isWaveValidationReceipt(m.payload) && m.msgId === m.payload.receiptId)),
    )
    .map((m) => m.msgId);
}
export class LocalUndoCompletion {
  private readonly finishing = new Map<string, Promise<LocalUndoCompleted>>();
  constructor(private readonly options: Options) {
    options.authority.setResultReader(this.verifyEvidence);
  }
  private async state(scope: Scope) {
    const state = await this.options.tasks.load(scope);
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    return state;
  }
  private async allStates(registry: LocalRegistryRecords) {
    const states: AppState[] = [];
    for (const scope of new Map(
      registry.workspaces.map((w) => [`${w.projectId}/${w.taskId}`, w]),
    ).values())
      states.push(await this.state(scope));
    return states;
  }
  private async draft(call: LocalUndoCall) {
    const ref = await this.options.objects.getReference(keyFor(call, 'draft'));
    if (!ref) fail();
    const draft = (await this.options.objects.get(ref)) as Draft;
    if (
      !exact(
        draft,
        'call,nativeResultHash,qualificationFailure,qualificationHash,registryHash,schemaVersion,stage,stateHashes',
      ) ||
      draft.schemaVersion !== 'local-undo-completion-draft-v2' ||
      (draft.qualificationFailure !== null &&
        (typeof draft.qualificationFailure !== 'string' ||
          !/^[a-z][a-z0-9_]{0,79}$/.test(draft.qualificationFailure))) ||
      !same(draft.call, call) ||
      !Array.isArray(draft.stateHashes) ||
      new Set(draft.stateHashes).size !== draft.stateHashes.length
    )
      fail();
    const registry = parseLocalRegistry(await this.options.objects.get(draft.registryHash)),
      states = (await Promise.all(
        draft.stateHashes.map((h) => this.options.objects.get(h)),
      )) as AppState[],
      claim = registry.claims.find((c) => c.claimId === call.claimId),
      proposal = (await this.options.proposals.read(call.inputHash)).proposal,
      native = await this.options.batch.readHistory(call),
      operation = registry.operations.find((o) => o.actionId === call.actionId),
      workspace = registry.workspaces.find(
        (w) =>
          w.projectId === call.projectId &&
          w.taskId === call.taskId &&
          w.workspaceId === call.workspaceId,
      ),
      sourceState = states.find((s) => s.projectId === call.projectId && s.taskId === call.taskId);
    if (
      claim?.kind !== 'undo' ||
      claim.status !== 'active' ||
      claim.closureReceiptId !== null ||
      !same(
        {
          projectId: claim.projectId,
          taskId: claim.taskId,
          claimId: claim.claimId,
          actionId: claim.createdActionId,
          workspaceId: claim.workspaceId,
          writerEpoch: claim.writerEpoch,
          grantRevision: claim.grantRevision,
          fileApplyReceiptId: claim.fileApplyReceiptId,
          inputHash: claim.inputHash,
        },
        call,
      ) ||
      !workspace ||
      !sourceState ||
      !operation ||
      !isLocalBindingOperation(operation) ||
      operation.stage !== 'committed' ||
      !operation.sourceMessage ||
      !same(
        sourceState.messages.find((m) => m.msgId === call.actionId),
        operation.sourceMessage,
      ) ||
      draft.nativeResultHash !== localRecordHash(native)
    )
      fail();
    const latest = registry.operations
      .filter(isLocalBindingOperation)
      .filter(
        (o) =>
          o.projectId === call.projectId && o.taskId === call.taskId && o.stage === 'committed',
      )
      .sort((a, b) => b.preparedRevision - a.preparedRevision)[0];
    if (!latest || !same(sourceState.localExecution, latest.nextLocalExecution)) fail();
    const registered = [
      ...new Set(registry.workspaces.map((w) => `${w.projectId}/${w.taskId}`)),
    ].sort();
    if (!same(states.map((s) => `${s.projectId}/${s.taskId}`).sort(), registered)) fail();
    if (draft.qualificationHash !== null) {
      const q = (await this.options.objects.get(draft.qualificationHash)) as Qualification;
      if (
        !exact(
          q,
          'call,currentVersion,nativeResultHash,prefixHash,registryHash,schemaVersion,stateHash',
        ) ||
        q.schemaVersion !== 'local-undo-current-result-v1' ||
        !same(q.call, call) ||
        q.nativeResultHash !== draft.nativeResultHash ||
        q.registryHash !== draft.registryHash ||
        q.stateHash !== localRecordHash(sourceState) ||
        q.prefixHash !== native.prefixHash ||
        !same(q.currentVersion, native.currentVersion) ||
        native.stage !== 'applied' ||
        draft.stage !== 'applied' ||
        draft.qualificationFailure !== null
      )
        fail();
    } else if (
      draft.stage !== (native.stage === 'applied' ? 'partial' : native.stage) ||
      (native.stage === 'applied') !== (draft.qualificationFailure !== null)
    )
      fail();
    const targets = deriveLocalRangeTargets(
        registry,
        states,
        localWorkspacePhysical(registry, workspace),
      ),
      messages: (Scope & { state: AppState; message: Message })[] = [];
    for (const target of targets.tasks) {
      const state = states.find(
        (s) => s.projectId === target.projectId && s.taskId === target.taskId,
      );
      if (!state?.localExecution) fail();
      const workers = targets.workers.filter(
          (w) => w.projectId === target.projectId && w.taskId === target.taskId,
        ),
        ownIds = new Set([
          ...target.workspaceIds,
          ...state.localExecution.bindings
            .filter((b) => workers.some((w) => w.workerId === b.workerId))
            .map((b) => b.workspaceId),
        ]);
      if (
        !ownIds.size ||
        [...ownIds].some(
          (id) => !state.localExecution?.workspaces.some((w) => w.workspaceId === id),
        )
      )
        fail();
      const resultId = `workspace-undo:${localRecordHash({ draftHash: ref, projectId: target.projectId, taskId: target.taskId })}`,
        payload: WorkspaceUndoResult = {
          kind: 'workspace_undo_result',
          version: 1,
          projectId: target.projectId,
          taskId: target.taskId,
          resultId,
          source: {
            projectId: call.projectId,
            taskId: call.taskId,
            msgId: call.actionId,
            workspaceId: call.workspaceId,
            fileApplyReceiptId: call.fileApplyReceiptId,
            inputHash: call.inputHash,
          },
          workspaceIds: [...ownIds].sort(),
          originalReceiptHash: proposal.originalReceiptHash,
          privateProofHash: ref,
          stage: draft.stage,
          currentVersion: draft.stage === 'applied' ? native.currentVersion : null,
          invalidatedValidationIds: validationIds(state),
        },
        message: Message = {
          msgId: resultId,
          channelId: 'main',
          fromRole: 'COORDINATOR',
          type: 'announce',
          ts: operation.sourceMessage.ts,
          display: 'Leader-confirmed undo recorded. Current evidence requires validation.',
          payload: { ...payload },
        };
      workspaceUndoResults(applyMutations(state, [appendMutation('messages', message)]));
      messages.push({ projectId: target.projectId, taskId: target.taskId, state, message });
    }
    return { draft, ref, registry, native, messages, states, targets };
  }
  private closureRequest(
    facts: Awaited<ReturnType<LocalUndoCompletion['draft']>>,
    completeRef: string,
  ): LocalBindingRequest {
    const call = facts.draft.call,
      registry = facts.registry,
      source = facts.states.find((s) => s.projectId === call.projectId && s.taskId === call.taskId);
    if (!source?.localExecution) fail();
    return {
      projectId: call.projectId,
      taskId: call.taskId,
      actionId: closureAction(call),
      sourceMessageId: call.actionId,
      expectedRevision: registry.revision,
      nextLocalExecution: structuredClone(source.localExecution),
      records: {
        roots: registry.roots,
        grants: registry.grants,
        workspaces: registry.workspaces,
        linkedRoots: registry.linkedRoots ?? [],
        claims: registry.claims.map((c) =>
          c.claimId === call.claimId
            ? {
                ...c,
                status: facts.native.closed ? 'released' : 'quarantined',
                closureReceiptId: facts.native.closed ? `closure:${completeRef}` : null,
              }
            : c,
        ),
      },
    };
  }
  private async verifyFreshFacts(facts: Awaited<ReturnType<LocalUndoCompletion['draft']>>) {
    const registry = await this.options.control.snapshot();
    if (!same(registry, facts.registry)) throw Error('undo_completion_needs_attention');
    const states = await this.allStates(registry);
    for (const state of states) {
      const own = facts.messages.find(
        (m) => m.projectId === state.projectId && m.taskId === state.taskId,
      );
      if (!own) continue;
      const messages = state.messages.filter((m) => m.msgId === own.message.msgId);
      if (messages.length !== 1 || !same(messages[0], own.message)) fail();
      state.messages = state.messages.filter((m) => m.msgId !== own.message.msgId);
    }
    const targets = deriveLocalRangeTargets(registry, states, facts.targets.physical);
    if (!same(targets, facts.targets)) throw Error('undo_completion_targets_changed');
  }
  private async complete(call: LocalUndoCall) {
    const facts = await this.draft(call),
      ref = await this.options.objects.getReference(keyFor(call, 'complete'));
    if (!ref) throw Error('undo_completion_needs_attention');
    const complete = (await this.options.objects.get(ref)) as Complete,
      expected: Complete = {
        schemaVersion: 'local-undo-completion-v1',
        draftHash: facts.ref,
        facts: facts.messages.map(({ projectId, taskId, message }) => ({
          projectId,
          taskId,
          messageId: message.msgId,
          messageHash: localRecordHash(message),
        })),
      };
    if (!same(complete, expected)) fail();
    for (const { message, ...scope } of facts.messages) {
      const current = await this.state(scope),
        matches = current.messages.filter((m) => m.msgId === message.msgId);
      if (matches.length !== 1 || !same(matches[0], message)) fail();
      workspaceUndoResults(current);
    }
    return { ...facts, complete, completeRef: ref };
  }
  private readonly verifyEvidence = async (registry: LocalRegistryRecords, state: AppState) => {
    for (const fact of workspaceUndoResults(state)) {
      const claim = registry.claims.find(
        (c) =>
          c.kind === 'undo' &&
          c.createdActionId === fact.source.msgId &&
          c.projectId === fact.source.projectId &&
          c.taskId === fact.source.taskId,
      );
      if (claim?.kind !== 'undo') fail();
      const call = {
          projectId: claim.projectId,
          taskId: claim.taskId,
          claimId: claim.claimId,
          actionId: claim.createdActionId,
          workspaceId: claim.workspaceId,
          writerEpoch: claim.writerEpoch,
          grantRevision: claim.grantRevision,
          fileApplyReceiptId: claim.fileApplyReceiptId,
          inputHash: claim.inputHash,
        },
        draft = await this.draft(call),
        expected = draft.messages.find(
          (m) => m.projectId === state.projectId && m.taskId === state.taskId,
        )?.message;
      if (
        !expected ||
        !same(
          state.messages.find((m) => m.msgId === fact.resultId),
          expected,
        )
      )
        fail();
    }
    for (const claim of registry.claims.filter((c) => c.kind === 'undo' && c.status !== 'active')) {
      if (claim.kind !== 'undo') fail();
      const call = {
          projectId: claim.projectId,
          taskId: claim.taskId,
          claimId: claim.claimId,
          actionId: claim.createdActionId,
          workspaceId: claim.workspaceId,
          writerEpoch: claim.writerEpoch,
          grantRevision: claim.grantRevision,
          fileApplyReceiptId: claim.fileApplyReceiptId,
          inputHash: claim.inputHash,
        },
        completed = await this.complete(call),
        operation = registry.operations.find((o) => o.actionId === closureAction(call));
      if (
        claim.status !== (completed.native.closed ? 'released' : 'quarantined') ||
        claim.closureReceiptId !==
          (completed.native.closed ? `closure:${completed.completeRef}` : null) ||
        !operation ||
        !isLocalBindingOperation(operation) ||
        operation.stage !== 'committed' ||
        operation.sourceMessageId !== call.actionId ||
        operation.projectId !== call.projectId ||
        operation.taskId !== call.taskId ||
        operation.inputHash !==
          localRecordHash(this.closureRequest(completed, completed.completeRef)) ||
        operation.preparedRevision !== completed.registry.revision + 1
      )
        fail();
      const source = await this.state(call);
      if (
        !source.localExecution?.receipts.some(
          (r) =>
            r.receiptId === operation.receiptId &&
            r.actionId === operation.actionId &&
            r.inputHash === operation.inputHash &&
            r.registryRevision === operation.preparedRevision,
        )
      )
        fail();
    }
  };
  async readHistory(call: LocalUndoCall): Promise<LocalUndoCompleted> {
    const completed = await this.complete(call),
      registry = await this.options.control.snapshot(),
      claim = registry.claims.find((c) => c.claimId === call.claimId);
    if (claim?.kind !== 'undo' || claim.status === 'active')
      throw Error('undo_completion_needs_attention');
    await this.verifyEvidence(registry, await this.state(call));
    return {
      stage: completed.draft.stage,
      native: completed.native,
      closureReceiptId: claim.closureReceiptId,
      facts: completed.complete.facts,
    };
  }
  finish(input: LocalUndoCall): Promise<LocalUndoCompleted> {
    const call = structuredClone(input),
      key = keyFor(call, 'draft'),
      prior = this.finishing.get(key);
    if (prior) return prior;
    const run = this.finishFresh(call).finally(() => this.finishing.delete(key));
    this.finishing.set(key, run);
    return run;
  }
  private async finishFresh(call: LocalUndoCall): Promise<LocalUndoCompleted> {
    if (await this.options.objects.getReference(keyFor(call, 'draft')))
      return this.readHistory(call);
    await this.options.authority.assertCall(call);
    const native = await this.options.batch.apply(call);
    let qualification: Qualification | null = null;
    let qualificationFailure: string | null = null;
    if (native.stage === 'applied') {
      try {
        qualification = await this.options.batch.verifyCurrent(call, native);
      } catch (error) {
        qualificationFailure =
          error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message)
            ? error.message
            : 'unclassified_qualification_failure';
      }
    }
    const prepared = await this.options.control.serializeRangeAdmission(async () => {
      if (await this.options.objects.getReference(keyFor(call, 'draft')))
        return this.readHistory(call);
      const registry = await this.options.control.snapshot(),
        states = await this.allStates(registry);
      if (
        qualification &&
        (qualification.registryHash !== localRecordHash(registry) ||
          !states.some(
            (s) =>
              s.projectId === call.projectId &&
              s.taskId === call.taskId &&
              qualification?.stateHash === localRecordHash(s),
          ))
      ) {
        qualification = null;
        qualificationFailure = 'qualification_control_changed';
      }
      const draft: Draft = {
          schemaVersion: 'local-undo-completion-draft-v2',
          call,
          registryHash: await this.options.objects.put(registry),
          stateHashes: await Promise.all(states.map((s) => this.options.objects.put(s))),
          nativeResultHash: localRecordHash(native),
          qualificationHash: qualification ? await this.options.objects.put(qualification) : null,
          qualificationFailure,
          stage: native.stage === 'applied' && !qualification ? 'partial' : native.stage,
        },
        draftHash = await this.options.objects.put(draft);
      await this.options.objects.bindReference(keyFor(call, 'draft'), draftHash);
      return this.draft(call);
    });
    if (!('messages' in prepared)) return prepared;
    for (const { state, message, ...scope } of prepared.messages) {
      if (!same(await this.options.control.snapshot(), prepared.registry))
        throw Error('undo_completion_needs_attention');
      await this.options.tasks.compareAndCommit(scope, state, [
        appendMutation('messages', message),
      ]);
    }
    const complete: Complete = {
        schemaVersion: 'local-undo-completion-v1',
        draftHash: prepared.ref,
        facts: prepared.messages.map(({ projectId, taskId, message }) => ({
          projectId,
          taskId,
          messageId: message.msgId,
          messageHash: localRecordHash(message),
        })),
      },
      completeRef = await this.options.objects.put(complete);
    const finish = () =>
      this.options.control.serializeRangeAdmission(async () => {
        await this.verifyFreshFacts(prepared);
        await this.options.objects.bindReference(keyFor(call, 'complete'), completeRef);
        await this.complete(call);
        await this.verifyFreshFacts(prepared);
        await this.options.control.commitBinding(this.closureRequest(prepared, completeRef));
        this.options.authority.retire(call);
        return this.readHistory(call);
      });
    return this.options.serializeTask ? this.options.serializeTask(call, finish) : finish();
  }
}
