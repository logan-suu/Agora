// Pure canonical ownership fixtures do not grant a root, session or G5 pass.
import { createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { assertLocalRangeResumeOwnership } from '../src/local-range-resume-ownership';
import { parseLocalRegistry } from '../src/local-registry-records';
import { linkedRegistryFixture } from './local-linked-registry-fixture';

it('requires the original active writer claim and rejects release, replacement and changed epoch before a Fork', () => {
  const original = parseLocalRegistry(linkedRegistryFixture()),
    state = createInitialAppState('task', 'test', 'project');
  const operation = original.operations.filter((o) => 'nextLocalExecution' in o).at(-1);
  if (!operation) throw Error('missing fixture operation');
  state.localExecution = operation.nextLocalExecution;
  state.workers = [
    { workerId: 'worker-one', role: 'CODER', status: 'paused', executor: 'harness', startedTs: 1 },
  ];
  expect(() =>
    assertLocalRangeResumeOwnership(state, original, original, 'worker-one'),
  ).not.toThrow();
  for (const patch of [
    { status: 'released', closureReceiptId: 'closed' },
    { writerEpoch: 5 },
    { claimId: 'replacement' },
  ]) {
    const current = parseLocalRegistry({
      ...original,
      claims: original.claims.map((c) => (c.workerId === 'worker-one' ? { ...c, ...patch } : c)),
    });
    expect(() => assertLocalRangeResumeOwnership(state, original, current, 'worker-one')).toThrow(
      'range_resume_ownership_changed',
    );
  }
});
it('keeps readonly/control identities distinct from write ownership', () => {
  const data = linkedRegistryFixture(),
    registry = parseLocalRegistry({
      ...data,
      claims: data.claims.filter((c) => c.workerId !== 'worker-tester'),
    }),
    state = createInitialAppState('task', 'test', 'project');
  const operation = registry.operations.filter((o) => 'nextLocalExecution' in o).at(-1);
  if (!operation) throw Error('missing fixture operation');
  state.localExecution = operation.nextLocalExecution;
  state.workers = [
    {
      workerId: 'worker-tester',
      role: 'REVIEWER',
      status: 'paused',
      executor: 'harness',
      startedTs: 1,
    },
  ];
  expect(() =>
    assertLocalRangeResumeOwnership(state, registry, registry, 'worker-tester'),
  ).not.toThrow();
  const tester = state.workers[0];
  if (!tester) throw Error('missing fixture worker');
  tester.role = 'TESTER';
  expect(() => assertLocalRangeResumeOwnership(state, registry, registry, 'worker-tester')).toThrow(
    'range_resume_ownership_changed',
  );
  state.workers = [
    { workerId: 'control', role: 'PM', status: 'paused', executor: 'harness', startedTs: 1 },
  ];
  expect(() => assertLocalRangeResumeOwnership(state, registry, registry, 'control')).not.toThrow();
});
