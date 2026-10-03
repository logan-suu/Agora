// Task/control/native-proof doubles isolate result ordering and interrupted
// saga recovery. They do not qualify native inverse effects or Harness G5.
import {
  type AppState,
  applyMutations,
  createInitialAppState,
  parseWorkspaceControl,
  workspaceUndoResults,
} from '@agora/core-domain';
import { expect, it } from 'vitest';
import {
  assertLocalRegistryTransition,
  type LocalRegistryRecords,
  localRecordHash,
  parseLocalRegistry,
} from '../src/local-registry-records';
import type { LocalUndoCall } from '../src/local-undo-authority';
import type { LocalUndoBatchResult } from '../src/local-undo-batch';
import { LocalUndoCompletion } from '../src/local-undo-completion';
import { linkedRegistryFixture } from './local-linked-registry-fixture';

function fixture(stage: LocalUndoBatchResult['stage'] = 'applied') {
  const base = linkedRegistryFixture(),
    scope = { projectId: 'project', taskId: 'task' },
    call: LocalUndoCall = {
      ...scope,
      workspaceId: 'one',
      claimId: 'claim-undo',
      actionId: 'undo',
      writerEpoch: 4,
      grantRevision: 0,
      fileApplyReceiptId: `apply:${'a'.repeat(64)}`,
      inputHash: 'b'.repeat(64),
    },
    display =
      '/workspace undo ' +
      JSON.stringify({
        ...scope,
        actionId: 'undo',
        expectedRevision: 4,
        fileApplyReceiptId: call.fileApplyReceiptId,
        inputHash: call.inputHash,
      }),
    source = {
      msgId: 'undo',
      channelId: 'main',
      fromRole: 'leader' as const,
      type: 'chat' as const,
      ts: 10,
      display,
      payload: {
        kind: 'leader_intent',
        intent: parseWorkspaceControl(display),
        action: { status: 'applied' },
      },
    },
    originalExecution = base.operations[1]?.nextLocalExecution;
  if (!originalExecution) throw Error('missing fixture binding');
  const execution = structuredClone(originalExecution);
  const bindings = execution.bindings.map((b) => ({ ...b, subtaskId: `sub-${b.workerId}` }));
  Object.assign(execution, { bindings });
  execution.receipts.push({
    actionId: 'undo',
    inputHash: 'c'.repeat(64),
    receiptId: 'binding:undo',
    registryRevision: 5,
  });
  let registry = parseLocalRegistry({
    ...base,
    revision: 6,
    claims: [
      ...base.claims.map((c) => ({ ...c, status: 'released', closureReceiptId: 'closed-source' })),
      {
        ...scope,
        kind: 'undo',
        claimId: call.claimId,
        workspaceId: call.workspaceId,
        writerEpoch: call.writerEpoch,
        grantRevision: 0,
        fileApplyReceiptId: call.fileApplyReceiptId,
        inputHash: call.inputHash,
        createdActionId: call.actionId,
        status: 'active',
        closureReceiptId: null,
      },
    ],
    operations: [
      ...base.operations,
      {
        actionId: 'undo',
        inputHash: 'c'.repeat(64),
        receiptId: 'binding:undo',
        ...scope,
        preparedRevision: 5,
        stage: 'committed',
        previousLocalHash: localRecordHash(originalExecution),
        nextLocalExecution: execution,
        sourceMessageId: source.msgId,
        sourceMessage: source,
      },
    ],
  });
  const currentExecution = registry.operations
    .filter((o) => 'nextLocalExecution' in o)
    .at(-1)?.nextLocalExecution;
  if (!currentExecution) throw Error('missing fixture current execution');
  let state: AppState = {
    ...createInitialAppState('task', 'Inverse fixture', 'project'),
    localExecution: currentExecution,
    subtasks: bindings.map((b) => ({
      id: b.subtaskId,
      title: 'Fixture',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'done',
    })),
    workers: bindings.map((b) => ({
      workerId: b.workerId,
      subtaskId: b.subtaskId,
      role: b.workspaceId === 'tester' ? 'TESTER' : 'CODER',
      status: 'done',
      executor: 'harness',
      startedTs: 1,
    })),
    messages: [source],
  };
  const native: LocalUndoBatchResult = {
      schemaVersion: 'local-undo-batch-result-v1',
      receiptId: `undo:${'d'.repeat(64)}`,
      inputHash: call.inputHash,
      preparedHash: 'e'.repeat(64),
      stage,
      reason: stage === 'applied' ? 'none' : 'native_item_failed',
      attempted: 1,
      items: [],
      prefixHash: 'f'.repeat(64),
      closed: stage !== 'recoveryRequired',
      currentVersion:
        stage === 'applied'
          ? { kind: 'files', manifestId: 'manifest:current', manifestHash: 'a'.repeat(64) }
          : null,
    },
    values = new Map<string, unknown>(),
    refs = new Map<string, string>(),
    events: string[] = [];
  let commitFail = false,
    closureFail = false,
    qualificationFail = false,
    targetRace = false,
    assertions = 0,
    writes = 0,
    reader: ((registry: LocalRegistryRecords, state: AppState) => Promise<void>) | undefined;
  const objects = {
      async put(v: unknown) {
        const h = localRecordHash(v);
        values.set(h, structuredClone(v));
        return h;
      },
      async get(h: string) {
        if (!values.has(h)) throw Error('missing');
        return structuredClone(values.get(h));
      },
      async getReference(k: string) {
        return refs.get(k);
      },
      async bindReference(k: string, h: string) {
        if (refs.has(k) && refs.get(k) !== h) throw Error('conflict');
        refs.set(k, h);
      },
    },
    tasks = {
      async load() {
        return structuredClone(state);
      },
      async compareAndCommit(
        _scope: unknown,
        expected: AppState,
        mutations: Parameters<typeof applyMutations>[1],
      ) {
        if (commitFail) throw Error('state_disk_failed');
        if (!same(expected, state)) throw Error('stale');
        state = applyMutations(state, mutations);
        events.push('canonical-result');
        if (targetRace)
          state = applyMutations(state, [{ op: 'set', field: 'phase', value: 'coding' }]);
        return { state: structuredClone(state), changed: true };
      },
    },
    control = {
      async snapshot() {
        return structuredClone(registry);
      },
      async serializeRangeAdmission<T>(fn: () => Promise<T>) {
        return fn();
      },
      async commitBinding(request: Record<string, unknown>) {
        events.push('claim-closure');
        if (closureFail) throw Error('registry_disk_failed');
        const actionId = request.actionId as string,
          next = structuredClone(state.localExecution);
        if (!next) throw Error('missing');
        const inputHash = localRecordHash(request),
          preparedRevision = registry.revision + 1;
        next.receipts.push({
          actionId,
          inputHash,
          receiptId: `binding:${actionId}`,
          registryRevision: preparedRevision,
        });
        const after = parseLocalRegistry({
          ...registry,
          ...(request.records as object),
          revision: registry.revision + 1,
          operations: [
            ...registry.operations,
            {
              ...scope,
              actionId,
              inputHash,
              preparedRevision,
              receiptId: `binding:${actionId}`,
              sourceMessageId: request.sourceMessageId,
              previousLocalHash: localRecordHash(state.localExecution),
              nextLocalExecution: next,
              stage: 'prepared',
            },
          ],
        });
        assertLocalRegistryTransition(registry, after);
        const committed = parseLocalRegistry({
          ...after,
          revision: after.revision + 1,
          operations: after.operations.map((o) =>
            o.actionId === actionId ? { ...o, stage: 'committed' } : o,
          ),
        });
        assertLocalRegistryTransition(after, committed);
        registry = committed;
        state = applyMutations(state, [{ op: 'set', field: 'localExecution', value: next }]);
      },
    },
    authority = {
      setResultReader(r: typeof reader) {
        reader = r;
      },
      async assertCall() {
        assertions++;
      },
      retire() {
        events.push('retired');
      },
    },
    batch = {
      async apply() {
        writes++;
        return structuredClone(native);
      },
      async readHistory() {
        return structuredClone(native);
      },
      async verifyCurrent() {
        if (qualificationFail) throw Error('actual_version_changed');
        return {
          schemaVersion: 'local-undo-current-result-v1',
          call,
          nativeResultHash: localRecordHash(native),
          registryHash: localRecordHash(registry),
          stateHash: localRecordHash(state),
          prefixHash: native.prefixHash,
          currentVersion: native.currentVersion,
        };
      },
    },
    proposals = {
      async read() {
        return { proposal: { originalReceiptHash: 'a'.repeat(64) } };
      },
    };
  const options = {
    control,
    objects,
    authority,
    batch,
    proposals,
    tasks,
  } as unknown as ConstructorParameters<typeof LocalUndoCompletion>[0];
  return {
    call,
    native,
    options,
    completion: new LocalUndoCompletion(options),
    events,
    states: () => ({ state, registry }),
    counts: () => ({ assertions, writes }),
    failCommit() {
      commitFail = true;
    },
    failClosure() {
      closureFail = true;
    },
    failQualification() {
      qualificationFail = true;
    },
    raceTarget() {
      targetRace = true;
    },
    verify: () => reader?.(registry, state),
    values,
    refs,
  };
}
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
it('records canonical facts before releasing its own claim and replays without any live assertion or write', async () => {
  const f = fixture(),
    worker = structuredClone(f.states().state.workers[0]),
    result = await f.completion.finish(f.call);
  expect(result.stage).toBe('applied');
  expect(f.events).toEqual(['canonical-result', 'claim-closure', 'retired']);
  expect(f.states().registry.claims.find((c) => c.claimId === f.call.claimId)?.status).toBe(
    'released',
  );
  expect(f.states().state.workers[0]).toEqual(worker);
  expect(workspaceUndoResults(f.states().state)[0]?.stage).toBe('applied');
  const counts = f.counts();
  expect(await f.completion.finish(f.call)).toEqual(result);
  expect(await new LocalUndoCompletion(f.options).finish(f.call)).toEqual(result);
  expect(f.counts()).toEqual(counts);
  await f.verify();
});
it('retains the blocking claim on a failed canonical commit and never repairs it on a repeated or cold action', async () => {
  const f = fixture();
  f.failCommit();
  await expect(f.completion.finish(f.call)).rejects.toThrow('state_disk_failed');
  const counts = f.counts();
  expect(f.events).toEqual([]);
  expect(f.states().registry.claims.find((c) => c.claimId === f.call.claimId)?.status).toBe(
    'active',
  );
  await expect(f.completion.finish(f.call)).rejects.toThrow('undo_completion_needs_attention');
  await expect(new LocalUndoCompletion(f.options).finish(f.call)).rejects.toThrow(
    'undo_completion_needs_attention',
  );
  expect(f.counts()).toEqual(counts);
});
it('keeps actual committed facts when final registry release fails, without repairing the claim later', async () => {
  const f = fixture();
  f.failClosure();
  await expect(f.completion.finish(f.call)).rejects.toThrow('registry_disk_failed');
  const counts = f.counts();
  expect(workspaceUndoResults(f.states().state)).toHaveLength(1);
  expect(f.states().registry.claims.find((c) => c.claimId === f.call.claimId)?.status).toBe(
    'active',
  );
  await expect(f.completion.finish(f.call)).rejects.toThrow('undo_completion_needs_attention');
  expect(f.counts()).toEqual(counts);
  await f.verify();
});
it('preserves native applied history but records partial qualification after a fresh version failure', async () => {
  const f = fixture();
  f.failQualification();
  const result = await f.completion.finish(f.call);
  expect(result).toMatchObject({ stage: 'partial', native: { stage: 'applied' } });
  expect(workspaceUndoResults(f.states().state)[0]).toMatchObject({
    stage: 'partial',
    currentVersion: null,
  });
  const draft = [...f.values.values()].find(
    (v) => (v as { schemaVersion?: string }).schemaVersion === 'local-undo-completion-draft-v2',
  ) as { qualificationFailure?: string } | undefined;
  expect(draft?.qualificationFailure).toBe('actual_version_changed');
});
it('quarantines an unknown native effect instead of releasing its writer', async () => {
  const f = fixture('recoveryRequired'),
    result = await f.completion.finish(f.call);
  expect(result.stage).toBe('recoveryRequired');
  expect(f.states().registry.claims.find((c) => c.claimId === f.call.claimId)?.status).toBe(
    'quarantined',
  );
  expect(workspaceUndoResults(f.states().state)[0]?.currentVersion).toBeNull();
});
it('rechecks current target facts after CAS and retains the barrier on a concurrent control change', async () => {
  const f = fixture();
  f.raceTarget();
  await expect(f.completion.finish(f.call)).rejects.toThrow('undo_completion_targets_changed');
  expect(workspaceUndoResults(f.states().state)).toHaveLength(1);
  expect(f.events).toEqual(['canonical-result']);
  expect(f.states().registry.claims.find((c) => c.claimId === f.call.claimId)?.status).toBe(
    'active',
  );
  const counts = f.counts();
  await expect(f.completion.finish(f.call)).rejects.toThrow('undo_completion_needs_attention');
  expect(f.counts()).toEqual(counts);
});
it('rejects missing private completion evidence and changed canonical results on history reads', async () => {
  const f = fixture();
  await f.completion.finish(f.call);
  const entry = [...f.refs].find(
    ([k]) =>
      k === localRecordHash({ kind: 'local-undo-completion', call: f.call, phase: 'complete' }),
  );
  if (!entry) throw Error('missing fixture record');
  f.refs.delete(entry[0]);
  await expect(f.completion.readHistory(f.call)).rejects.toThrow('undo_completion_needs_attention');
  f.refs.set(...entry);
  const message = f.states().state.messages.at(-1);
  if (!message) throw Error('missing fixture result');
  message.display = 'tampered';
  await expect(f.completion.readHistory(f.call)).rejects.toThrow('undo_completion_unverified');
});
