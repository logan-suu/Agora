// Unit control-flow tests mock provenance/readiness ports; native manifests and
// registry/TaskState crash recovery have separate integration coverage. These
// doubles do not establish execution, authorization, or delivery G5.
import { createInitialAppState, type Message, parseWorkspaceControl } from '@agora/core-domain';
import { describe, expect, it, vi } from 'vitest';
import type {
  LocalBindingCoordinator,
  LocalBindingRequest,
} from '../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalDeliveryCandidates } from '../../../packages/runtime/sandbox/src/local-delivery-candidates';
import type { LocalDeliveryComparisonRecord } from '../../../packages/runtime/sandbox/src/local-delivery-comparison-record';
import {
  type LocalBindingOperation,
  parseLocalRegistry,
} from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalDeliveryRevalidation } from '../src/server/local-delivery-revalidation';

const scope = { projectId: 'p', taskId: 't' };
function fixture() {
  const state = createInitialAppState('t', 'Fixed requirement', 'p');
  state.phase = 'done';
  state.iterationCount = 5;
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    workspaces: [],
    bindings: [],
    receipts: [],
    delivery: {
      schemaVersion: 'local-delivery-v1',
      rootId: 'root',
      goal: 'artifact_only',
      currentRoundId: null,
      rounds: [],
    },
  };
  const registry = parseLocalRegistry({
    schemaVersion: 'local-workspaces-v1',
    revision: 0,
    roots: [],
    grants: [],
    workspaces: [],
    claims: [],
    operations: [],
  });
  const version = {
    kind: 'files' as const,
    manifestId: `manifest:${'a'.repeat(64)}`,
    manifestHash: 'a'.repeat(64),
  };
  const record = {
    deliveryComparisonId: `comparison:${'b'.repeat(64)}`,
    inputHash: 'c'.repeat(64),
    comparison: { status: 'requires_validation' },
    source: {
      scope: { ...scope, rootId: 'root', policyHash: 'd'.repeat(64) },
      baseline: version,
      artifact: version,
      current: version,
      grantId: 'grant',
      grantRevision: 0,
      goal: 'artifact_only',
      targetIndexHash: null,
      controlFingerprint: 'e'.repeat(64),
      sourceReceipts: { baseline: 'baseline', artifact: 'validation', current: 'current' },
    },
  } as LocalDeliveryComparisonRecord;
  const action = {
    ...scope,
    actionId: 'revalidate',
    expectedRevision: 0,
    deliveryComparisonId: record.deliveryComparisonId,
    inputHash: record.inputHash,
  };
  const display = `/workspace revalidate ${JSON.stringify(action)}`;
  const message: Message = {
    msgId: action.actionId,
    fromRole: 'leader',
    channelId: 'main',
    type: 'chat',
    display,
    ts: 1,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  const commitBinding = vi.fn<LocalBindingCoordinator['commitBinding']>(
    async () => ({}) as LocalBindingOperation,
  );
  const control = {
    snapshot: vi.fn(async () => registry),
    assertClosed: vi.fn(async () => state),
    recover: vi.fn<LocalBindingCoordinator['recover']>(),
    commitBinding,
  };
  const comparisons = { verifyCurrent: vi.fn(async () => record) };
  const candidates = {
    materialize: vi.fn<LocalDeliveryCandidates['materialize']>(
      async () => ({ version }) as Awaited<ReturnType<LocalDeliveryCandidates['materialize']>>,
    ),
  };
  const ready = vi.fn(async () => {});
  const service = new LocalDeliveryRevalidation(
    control,
    comparisons,
    candidates,
    async () => state,
    ready,
  );
  return { state, registry, record, message, control, comparisons, candidates, ready, service };
}
describe('explicit delivery revalidation admission', () => {
  it('binds one new round without altering old workers, budget or source artifact', async () => {
    const f = fixture();
    await f.service.commit(scope, f.message);
    expect(f.ready).toHaveBeenCalledTimes(2);
    expect(f.comparisons.verifyCurrent).toHaveBeenCalledTimes(2);
    const input = f.control.commitBinding.mock.calls[0]?.[0] as LocalBindingRequest;
    expect(input.sourceMessage).toEqual(f.message);
    expect(input.nextLocalExecution.delivery?.rounds).toHaveLength(1);
    expect(input.nextLocalExecution.delivery?.rounds[0]?.sourceVersion).toEqual(
      f.record.source.artifact,
    );
    expect(input.deliveryTransition?.kind).toBe('delivery-round-start-v1');
    if (input.deliveryTransition?.kind !== 'delivery-round-start-v1')
      throw Error('missing round recipe');
    expect(input.deliveryTransition.dispatch.payload.nextRole).toBe('TESTER');
    expect(f.state.iterationCount).toBe(5);
    expect(f.state.phase).toBe('done');
    expect(f.state.localExecution?.delivery?.rounds).toEqual([]);
  });
  it.each(['readiness', 'scope', 'same-artifact', 'stale'] as const)(
    'rejects %s before registration',
    async (reason) => {
      const f = fixture();
      if (reason === 'readiness') f.ready.mockRejectedValue(Error('run_not_closed'));
      if (reason === 'scope') f.record.source.scope.taskId = 'other';
      if (reason === 'same-artifact') f.record.comparison.status = 'matches_artifact';
      if (reason === 'stale')
        f.comparisons.verifyCurrent.mockRejectedValue(Error('delivery_stale'));
      await expect(f.service.commit(scope, f.message)).rejects.toThrow();
      expect(f.control.commitBinding).not.toHaveBeenCalled();
      expect(f.candidates.materialize).not.toHaveBeenCalled();
    },
  );
  it('rejects a source change during materialization', async () => {
    const f = fixture();
    f.comparisons.verifyCurrent
      .mockResolvedValueOnce(f.record)
      .mockRejectedValueOnce(Error('delivery_stale'));
    await expect(f.service.commit(scope, f.message)).rejects.toThrow('delivery_stale');
    expect(f.candidates.materialize).toHaveBeenCalledOnce();
    expect(f.control.commitBinding).not.toHaveBeenCalled();
  });
  it.each(['committed', 'prepared', 'prepared-written', 'conflict'] as const)(
    'does not re-execute an old %s request',
    async (stage) => {
      const f = fixture();
      f.registry.operations.push({
        actionId: 'revalidate',
        projectId: 'p',
        taskId: 't',
        sourceMessage: f.message,
        preparedRevision: 1,
        stage:
          stage === 'prepared-written' ? 'prepared' : stage === 'conflict' ? 'committed' : stage,
        inputHash: 'f'.repeat(64),
        receiptId: 'binding:revalidate',
        deliveryTransition: { kind: 'delivery-round-start-v1' },
      } as LocalBindingOperation);
      if (stage === 'prepared-written')
        f.state.localExecution?.receipts.push({
          receiptId: 'binding:revalidate',
          actionId: 'revalidate',
          inputHash: 'f'.repeat(64),
          registryRevision: 1,
        });
      if (stage === 'conflict') {
        const entry = f.registry.operations[0] as LocalBindingOperation;
        entry.sourceMessage = { ...f.message, display: `${f.message.display} changed` };
        await expect(f.service.commit(scope, f.message)).rejects.toThrow('operation_conflict');
        expect(f.control.recover).not.toHaveBeenCalled();
      } else if (stage === 'prepared')
        await expect(f.service.commit(scope, f.message)).rejects.toThrow(
          'delivery_revalidation_recovery_required',
        );
      else {
        await f.service.commit(scope, { ...f.message, ts: 2 });
        expect(f.control.recover).toHaveBeenCalledOnce();
      }
      expect(f.ready).not.toHaveBeenCalled();
      expect(f.comparisons.verifyCurrent).not.toHaveBeenCalled();
      expect(f.candidates.materialize).not.toHaveBeenCalled();
      expect(f.control.commitBinding).not.toHaveBeenCalled();
    },
  );
});
