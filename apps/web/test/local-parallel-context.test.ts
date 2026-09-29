// Proof-port doubles isolate orchestration ordering and drift rejection.
// Native Git/base/command evidence remains mandatory in integration tests.
import { type AppState, createInitialAppState } from '@agora/core-domain';
import { expect, it, vi } from 'vitest';
import { readLocalParallelContext } from '../src/server/local-parallel-context';
import { controlFingerprint } from '../src/server/wave-validation';

it('verifies all retained validation sources and uses the proved initial base', async () => {
  const state = createInitialAppState('task', 'context proof', 'project');
  state.localExecution = { git: { version: 1 } } as NonNullable<AppState['localExecution']>;
  const base = { branch: 'initial', commit: 'a'.repeat(40) };
  state.parallelExecution = {
    version: 1,
    planId: 'plan',
    initialBase: base,
    acceptedReceiptId: 'accepted',
    activeWave: { validation: { receiptId: 'pending' } },
  } as NonNullable<AppState['parallelExecution']>;
  state.phase = 'planning';
  state.messages.push({
    msgId: 'replan',
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce',
    ts: 1,
    display: 'Replan',
    payload: {
      nextRole: 'ARCHITECT',
      kind: 'parallel_replan_dispatch',
      replanSourceReceiptId: 'historical',
    },
  });
  const verify = vi.fn(async (_state: AppState, _receiptId: string) => {});
  const ports = {
    readInitialBase: vi.fn(async () => base),
    verifyReceipt: verify,
    load: async () => structuredClone(state),
  };
  expect(await readLocalParallelContext(state, ports)).toEqual({
    initialBase: base,
    controlFingerprint: controlFingerprint(state),
  });
  expect(verify.mock.calls.map((args) => args[1])).toEqual(['accepted', 'pending', 'historical']);
  verify.mockRejectedValueOnce(Error('private evidence changed'));
  await expect(readLocalParallelContext(state, ports)).rejects.toThrow('private evidence changed');
  await expect(
    readLocalParallelContext(state, {
      ...ports,
      readInitialBase: async () => ({ ...base, commit: 'b'.repeat(40) }),
    }),
  ).rejects.toThrow('local_parallel_base_changed');
  let loads = 0;
  await expect(
    readLocalParallelContext(state, {
      ...ports,
      load: async () => (++loads === 1 ? structuredClone(state) : { ...state, iterationCount: 1 }),
    }),
  ).rejects.toThrow('local_parallel_state_changed');
  delete state.messages[0]?.payload.replanSourceReceiptId;
  await expect(readLocalParallelContext(state, ports)).rejects.toThrow(
    'local_parallel_replan_source_required',
  );
});
