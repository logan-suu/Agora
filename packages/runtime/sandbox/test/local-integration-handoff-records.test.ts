// Pure control fixtures test exact binding transitions; no physical proof is claimed.
import { createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { assertHandoffStage, handoffStages } from '../src/local-integration-handoff-records';
import { parseLocalRegistry } from '../src/local-registry-records';
import { linkedRegistryFixture } from './local-linked-registry-fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('missing fixture');
  return value;
}

function fixture() {
  const registry = linkedRegistryFixture();
  const call = {
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'initial',
    integrationId: 'integration',
    claimId: 'integration-claim',
    writerEpoch: 4,
    grantRevision: 0,
  };
  const snapshot = parseLocalRegistry({
    ...registry,
    claims: [
      ...registry.claims,
      {
        kind: 'integration',
        ...call,
        createdActionId: 'register',
        waveId: 'wave',
        planHash: 'a'.repeat(64),
        status: 'active',
        closureReceiptId: null,
      },
    ],
  });
  const state = createInitialAppState('task', 'Retain original completion', 'project');
  const registration = snapshot.operations.find((o) => o.actionId === 'register');
  if (!registration || !('nextLocalExecution' in registration)) throw Error('missing fixture');
  state.localExecution = structuredClone(registration.nextLocalExecution);
  return { call, state, snapshot, closure: 'closure:original' };
}

it('reconstructs only original active, drained and released binding states', () => {
  const f = fixture();
  const original = structuredClone(f);
  const stages = handoffStages(f.call, f.state, f.snapshot, f.closure);
  expect(stages.map((s) => s.status)).toEqual(['active', 'draining', 'released']);
  expect(stages.map((s) => s.snapshot.revision)).toEqual([4, 6, 8]);
  for (const stage of stages) {
    expect(assertHandoffStage(stages, stage.state, stage.snapshot)).toBe(stage.status);
    expect(stage.state.workers).toEqual(f.state.workers);
    expect(stage.state.messages).toEqual(f.state.messages);
  }
  expect(stages[2]?.snapshot.claims.at(-1)?.closureReceiptId).toBe(f.closure);
  expect(f).toEqual(original);
});

it.each(['state', 'claim', 'operation', 'receipt', 'revision', 'grant', 'workspace'])(
  'rejects unrelated %s drift rather than ignoring all localExecution changes',
  (field) => {
    const f = fixture(),
      stages = handoffStages(f.call, f.state, f.snapshot, f.closure);
    const current = structuredClone(stages[2]);
    if (!current) throw Error('missing stage');
    if (field === 'state') current.state.iterationCount++;
    if (field === 'claim') required(current.snapshot.claims[0]).status = 'draining';
    if (field === 'operation')
      required(current.snapshot.operations.at(-1)).inputHash = 'f'.repeat(64);
    if (field === 'receipt') required(current.state.localExecution).receipts.pop();
    if (field === 'revision') current.snapshot.revision++;
    if (field === 'grant') required(current.snapshot.grants[0]).revision++;
    if (field === 'workspace') required(current.snapshot.workspaces[0]).grantId = 'foreign';
    expect(() => assertHandoffStage(stages, current.state, current.snapshot)).toThrow(
      'integration_handoff_state_changed',
    );
  },
);

it('rejects another capability and a pre-released original claim', () => {
  const f = fixture();
  expect(() =>
    handoffStages({ ...f.call, writerEpoch: 5 }, f.state, f.snapshot, f.closure),
  ).toThrow();
  required(f.snapshot.claims.at(-1)).status = 'released';
  required(f.snapshot.claims.at(-1)).closureReceiptId = f.closure;
  expect(() => handoffStages(f.call, f.state, f.snapshot, f.closure)).toThrow();
});
