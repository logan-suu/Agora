import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { decide, latestCoordinationLedger } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { project } from '@agora/runtime-executor';
import { describe, expect, it } from 'vitest';

// Cross-package deterministic integration; no mocks. The full Harness/MCP/
// LocalTempSandbox G5 path is asserted by Phase 2 exit chain 2b using the same
// production Coordinator and projection code (task 4.4 / DEF-012).

function clock() {
  let id = 0;
  return { newId: () => `phase4-${++id}`, now: () => 44 };
}

describe('Phase 4 cross-phase coordination Ledger + handoff generation', () => {
  it('carries structured progress and role handoffs across PM→ARCHITECT→CODER', () => {
    const chainClock = clock();
    let state = applyMutations(createInitialAppState('phase4-ledger', 'Build a cache module'), [
      setMutation('complexity', { tier: 1, signals: { rule: 'tier1.default' } }),
    ]);

    state = applyMutations(
      state,
      decide(state, { ...chainClock, roster: DEFAULT_ROSTER }).mutations,
    );
    expect(state.nextRole).toBe('PM');
    expect(state.handoffPackets).toEqual([]);

    state = applyMutations(state, [
      mergeByIdMutation('requirements', 'req-1', {
        story: 'Cache values',
        acceptance: ['set/get round-trip'],
        nonGoals: [],
      }),
    ]);
    state = applyMutations(
      state,
      decide(state, { ...chainClock, roster: DEFAULT_ROSTER }).mutations,
    );
    expect(state.nextRole).toBe('ARCHITECT');
    expect(state.handoffPackets.map((packet) => `${packet.fromRole}->${packet.toRole}`)).toEqual([
      'PM->ARCHITECT',
    ]);

    state = applyMutations(state, [
      setMutation('architecture', { modules: ['cache'] }),
      setMutation('phase', 'planning'),
    ]);
    state = applyMutations(
      state,
      decide(state, { ...chainClock, roster: DEFAULT_ROSTER }).mutations,
    );
    expect(state.nextRole).toBe('CODER');
    expect(state.handoffPackets.map((packet) => `${packet.fromRole}->${packet.toRole}`)).toEqual([
      'PM->ARCHITECT',
      'ARCHITECT->CODER',
    ]);

    expect(latestCoordinationLedger(state)?.progress.nextSpeaker.answer).toBe('CODER');
    const coderContext = project(state, 'CODER', DEFAULT_ROSTER).slices.coordinationContext as {
      plan: { role: string }[];
      instructionOrQuestion: string | null;
    };
    expect(coderContext.plan.map((step) => step.role)).toEqual(['CODER']);
    expect(coderContext.instructionOrQuestion).toContain('CODER');
    expect(JSON.stringify(coderContext)).not.toContain('channelId');
  });
});
