// Closed JSON ownership records are pure fixtures. They grant no OS capability;
// acquisition, original effects and inverse transactions require real G5 proof.
import { expect, it } from 'vitest';
import { assertLocalRangeAdmission } from '../src/local-range-admission';
import { assertLocalRegistryTransition, parseLocalRegistry } from '../src/local-registry-records';
import { linkedRegistryFixture } from './local-linked-registry-fixture';

it('records a distinct undo owner, keeps its original input immutable, and never borrows worker identity', () => {
  const data = linkedRegistryFixture();
  const claims = data.claims.map((c) => ({
    ...c,
    status: 'released',
    closureReceiptId: 'closed-worker',
  }));
  const undo = {
    kind: 'undo',
    claimId: 'claim-undo',
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'one',
    writerEpoch: 4,
    createdActionId: 'leader-undo',
    status: 'active',
    closureReceiptId: null,
    grantRevision: 0,
    fileApplyReceiptId: `apply:${'a'.repeat(64)}`,
    inputHash: 'b'.repeat(64),
  };
  const active = parseLocalRegistry({ ...data, claims: [...claims, undo] });
  expect(active.claims.at(-1)).toEqual(undo);
  const one = active.workspaces.find((w) => w.workspaceId === 'one'),
    two = active.workspaces.find((w) => w.workspaceId === 'two');
  if (!one || !two) throw Error('missing pure workspace');
  expect(() => assertLocalRangeAdmission(active, one, [])).toThrow('workspace_undo_in_progress');
  expect(() => assertLocalRangeAdmission(active, two, [])).not.toThrow();
  expect(() => assertLocalRangeAdmission(active, two, [one])).toThrow('workspace_undo_in_progress');
  expect(() =>
    parseLocalRegistry({ ...active, claims: [...claims, { ...undo, workerId: 'worker-one' }] }),
  ).toThrow('invalid_local_registry_records');
  const released = parseLocalRegistry({
    ...active,
    revision: active.revision + 1,
    claims: [...claims, { ...undo, status: 'released', closureReceiptId: 'closed-undo' }],
  });
  expect(() => assertLocalRegistryTransition(active, released)).not.toThrow();
  expect(() => assertLocalRangeAdmission(released, one, [])).not.toThrow();
  expect(() =>
    assertLocalRegistryTransition(
      released,
      parseLocalRegistry({ ...active, revision: released.revision + 1 }),
    ),
  ).toThrow();
  expect(() =>
    assertLocalRegistryTransition(
      active,
      parseLocalRegistry({
        ...active,
        revision: active.revision + 1,
        claims: [...claims, { ...undo, inputHash: 'c'.repeat(64) }],
      }),
    ),
  ).toThrow();
});
it('rejects undo overlap with an active worker and refuses incomplete proposal scope', () => {
  const data = linkedRegistryFixture();
  const undo = {
    kind: 'undo',
    claimId: 'undo',
    projectId: 'project',
    taskId: 'task',
    workspaceId: 'one',
    writerEpoch: 4,
    createdActionId: 'leader-undo',
    status: 'active',
    closureReceiptId: null,
    grantRevision: 0,
    fileApplyReceiptId: `apply:${'a'.repeat(64)}`,
    inputHash: 'b'.repeat(64),
  };
  expect(() => parseLocalRegistry({ ...data, claims: [...data.claims, undo] })).toThrow(
    'invalid_local_registry_records',
  );
  const closed = data.claims.map((c) => ({ ...c, status: 'released', closureReceiptId: 'closed' }));
  expect(() =>
    parseLocalRegistry({ ...data, claims: [...closed, { ...undo, grantRevision: -1 }] }),
  ).toThrow();
});
