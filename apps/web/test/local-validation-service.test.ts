// Port doubles isolate control-flow failures; real native evidence is covered by
// the Phase 12 grant integration fixture, not substituted by these tests.
import { createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';

it('invalidates local validation when requirements, architecture or conventions change', async () => {
  const { localControlFingerprint } = await import('../src/server/local-validation');
  const state = createInitialAppState('task', 'Build a cache', 'project');
  const original = localControlFingerprint(state);
  const next = structuredClone(state);
  next.goal = 'Build a different cache';
  expect(localControlFingerprint(next)).not.toBe(original);
  next.goal = state.goal;
  next.conventions = { style: 'different' };
  expect(localControlFingerprint(next)).not.toBe(original);
  delete next.conventions;
  next.iterationCount++;
  expect(localControlFingerprint(next)).toBe(original);
});
