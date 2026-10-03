// Synthetic canonical records isolate dependency/physical analysis. No native
// access or quiescence evidence is granted by these fixtures.
import {
  assertLocalExecutionState,
  createInitialAppState,
  type LocalExecutionV1,
} from '@agora/core-domain';
import { expect, it } from 'vitest';
import { localWorkspacePhysical } from '../src/local-range-admission';
import { deriveLocalRangeTargets, localRangeAssignmentHash } from '../src/local-range-targets';
import { parseLocalRegistry } from '../src/local-registry-records';
import { linkedRegistryFixture } from './local-linked-registry-fixture';

function fixture() {
  const registry = parseLocalRegistry(linkedRegistryFixture());
  const state = createInitialAppState('task', 'test', 'project');
  const op = registry.operations.find((o) => 'nextLocalExecution' in o);
  if (!op || !('nextLocalExecution' in op)) throw Error('missing fixture binding');
  state.localExecution = structuredClone(op.nextLocalExecution) as LocalExecutionV1;
  state.workers = registry.claims
    .filter((c) => c.kind === undefined)
    .map((c) => ({
      workerId: c.workerId ?? 'invalid-fixture-worker',
      role: c.workspaceId === 'tester' ? 'TESTER' : 'CODER',
      executor: 'harness',
      status: 'running',
      sessionId: `session:${c.workerId}`,
      startedTs: 1,
      ...(c.workspaceId === 'tester' ? {} : { subtaskId: c.workspaceId }),
    }));
  state.subtasks = ['one', 'two'].map((id) => ({
    id,
    title: id,
    ownerRole: 'CODER',
    dependsOn: [],
    status: 'todo',
  }));
  for (const b of state.localExecution.bindings)
    if (b.workerId !== 'worker-tester') b.subtaskId = b.workspaceId;
  // Update the synthetic registry's exact canonical binding snapshot as well.
  op.nextLocalExecution = structuredClone(state.localExecution);
  const workspace = registry.workspaces.find((w) => w.workspaceId === 'one');
  if (!workspace) throw Error('missing target');
  return { registry, state, physical: localWorkspacePhysical(registry, workspace) };
}
it('keeps a proven independent linked CODER out of the cohort while full-read TESTER is held', () => {
  const f = fixture();
  const targets = deriveLocalRangeTargets(f.registry, [f.state], f.physical);
  expect(targets.cohort.map((w) => w.workerId)).toEqual(['worker-one', 'worker-tester']);
  expect(targets.claims.map((c) => c.claimId)).toEqual(['claim-one']);
});
it('includes a transitive dependent with a different physical worktree', () => {
  const f = fixture();
  const dependent = f.state.subtasks.find((s) => s.id === 'two');
  if (!dependent) throw Error('missing dependent');
  dependent.dependsOn = ['one'];
  expect(
    deriveLocalRangeTargets(f.registry, [f.state], f.physical).cohort.map((w) => w.workerId),
  ).toContain('worker-two');
});
it('treats cyclic or incomplete dependency mappings as full reads', () => {
  const f = fixture();
  const dependent = f.state.subtasks.find((s) => s.id === 'two');
  if (!dependent) throw Error('missing dependent');
  dependent.dependsOn = ['missing'];
  expect(
    deriveLocalRangeTargets(f.registry, [f.state], f.physical).cohort.map((w) => w.workerId),
  ).toContain('worker-two');
  dependent.dependsOn = ['two'];
  expect(
    deriveLocalRangeTargets(f.registry, [f.state], f.physical).cohort.map((w) => w.workerId),
  ).toContain('worker-two');
});
it('refuses missing task sources and a live D4 gate rather than forging a range pause', () => {
  const f = fixture();
  expect(() => deriveLocalRangeTargets(f.registry, [], f.physical)).toThrow(
    'range_control_source_invalid',
  );
  f.state.humanGate = {
    gateId: 'gate',
    kind: 'blocking_objection',
    question: 'hold',
    options: [],
    safePointRefs: [],
  } as unknown as NonNullable<typeof f.state.humanGate>;
  expect(() => deriveLocalRangeTargets(f.registry, [f.state], f.physical)).toThrow(
    'range_hold_scope_or_gate_conflict',
  );
});

it('keeps assignment identity stable across an observed HEAD update, while detecting dependency or workspace reassignment', () => {
  const f = fixture(),
    worker = f.state.workers.find((w) => w.workerId === 'worker-one');
  if (!worker) throw Error('missing fixture worker');
  worker.worktree = {
    path: '/fixture/one',
    branch: 'worker-one',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
  };
  const before = localRangeAssignmentHash(f.state, worker.workerId);
  worker.worktree.headCommit = 'c'.repeat(40);
  expect(localRangeAssignmentHash(f.state, worker.workerId)).toBe(before);
  worker.worktree.branch = 'another';
  expect(localRangeAssignmentHash(f.state, worker.workerId)).not.toBe(before);
});

it('includes dependencies from the current canonical rework binding instead of the first historical binding', () => {
  const f = fixture();
  const local = f.state.localExecution;
  if (!local?.git || !f.registry.linkedRoots) throw Error('missing fixture local state');
  const old = local.workspaces.find((w) => w.workspaceId === 'one');
  if (!old) throw Error('missing old workspace');
  const current = { ...old, workspaceId: 'new-one', branch: 'agora-new-one' };
  local.workspaces.push(current);
  local.bindings.push({
    workerId: 'new-worker-one',
    subtaskId: 'one',
    workspaceId: 'new-one',
    receiptId: 'binding:register',
  });
  local.git.worktrees.push({
    workspaceId: 'new-one',
    path: '/new-one',
    receiptId: 'binding:register',
  });
  const original = f.state.workers.find((w) => w.workerId === 'worker-one');
  if (!original) throw Error('missing original worker');
  original.status = 'done';
  const worktree = {
    path: '/new-one',
    branch: 'agora-new-one',
    baseCommit: 'b'.repeat(40),
    headCommit: 'c'.repeat(40),
  };
  f.state.workers.push({
    ...original,
    workerId: 'new-worker-one',
    sessionId: 'session:new-worker-one',
    worktree,
  });
  const dependency = f.state.subtasks.find((s) => s.id === 'one');
  const downstream = f.state.subtasks.find((s) => s.id === 'two');
  if (!dependency || !downstream) throw Error('missing dependency');
  dependency.status = 'done';
  dependency.worktree = worktree;
  downstream.dependsOn = ['one'];
  f.registry.workspaces.push(current);
  const oldRoot = f.registry.linkedRoots.find((r) => r.workspaceId === 'one');
  if (!oldRoot) throw Error('missing original root');
  f.registry.linkedRoots.push({
    ...oldRoot,
    workspaceId: 'new-one',
    path: '/new-one',
    inode: '99',
    chain: [
      { path: '/', identity: '1:1' },
      { path: '/new-one', identity: '1:99' },
    ],
    staging: { path: '/new-one/.agora-operations', identity: '1:100' },
  });
  expect(() => assertLocalExecutionState(f.state)).not.toThrow();
  const targets = deriveLocalRangeTargets(
    f.registry,
    [f.state],
    localWorkspacePhysical(f.registry, current),
  );
  expect(targets.cohort.map((w) => w.workerId)).toContain('worker-two');
  const oldTargets = deriveLocalRangeTargets(f.registry, [f.state], f.physical);
  expect(oldTargets.cohort.map((w) => w.workerId)).not.toContain('worker-two');
  delete dependency.worktree;
  const unknown = deriveLocalRangeTargets(
    f.registry,
    [f.state],
    localWorkspacePhysical(f.registry, current),
  );
  expect(unknown.cohort.map((w) => w.workerId)).toContain('worker-two');
});
