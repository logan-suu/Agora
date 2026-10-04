// Capability ports model native approval for control-flow unit coverage only.
// The integration suite must use actual native grants and filesystem checks.

import { createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { firstRunScope, firstRunStartEligible } from '../src/server/first-run-policy';

it('derives stable scoped identities and rejects path-like operation IDs', () => {
  expect(firstRunScope('dcb035af-200e-4dd8-89b9-8b5e3d2637d1')).toEqual(
    firstRunScope('dcb035af-200e-4dd8-89b9-8b5e3d2637d1'),
  );
  expect(() => firstRunScope('../x')).toThrow();
});
it('permits only a prepared first start, never a prior worker or completed task', () => {
  const state = createInitialAppState('t', 'goal', 'p');
  expect(firstRunStartEligible(state)).toBe(false);
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    workspaces: [],
    bindings: [],
    receipts: [],
  };
  expect(firstRunStartEligible(state)).toBe(true);
  state.phase = 'done';
  expect(firstRunStartEligible(state)).toBe(false);
});
