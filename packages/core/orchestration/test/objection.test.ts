import {
  appendMutation,
  applyMutations,
  createInitialAppState,
  type Message,
  mergeByIdMutation,
} from '@agora/core-domain';
import type { StepResult } from '@agora/runtime-executor';
import { describe, expect, it } from 'vitest';
import { planObjectionMutations } from '../src/objection';

function stateWithRequirement() {
  return applyMutations(createInitialAppState('t-1', 'goal'), [
    mergeByIdMutation('requirements', 'req-1', {
      story: 'Persist tasks',
      acceptance: ['survives restart'],
      nonGoals: [],
    }),
  ]);
}

function objectionResult(overrides: Partial<Message> = {}): StepResult {
  const objection = {
    claim: 'contradiction',
    target: { kind: 'requirement', id: 'req-1' },
    argument: 'An in-memory store cannot survive restart.',
  };
  const message: Message = {
    msgId: 'obj-1',
    threadId: 'obj-1',
    channelId: 'main',
    fromRole: 'PM',
    type: 'objection',
    payload: { objection },
    display: 'This conflicts with restart durability.',
    ts: 2,
    ...overrides,
  };
  return {
    kind: 'done',
    output: { objection: { id: 'obj-1', threadId: 'obj-1', ...objection } },
    reachedSafeBoundary: true,
    mutations: [appendMutation('messages', message)],
  };
}

describe('planObjectionMutations · D14 worker-step binding', () => {
  it('binds the current role and computes track from the complete task state', () => {
    const mutations = planObjectionMutations(stateWithRequirement(), 'PM', objectionResult());
    expect(mutations).toEqual([
      appendMutation('objections', {
        id: 'obj-1',
        threadId: 'obj-1',
        fromRole: 'PM',
        claim: 'contradiction',
        target: { kind: 'requirement', id: 'req-1' },
        argument: 'An in-memory store cannot survive restart.',
        track: 'blocking',
        ts: 2,
      }),
    ]);
  });

  it('returns no mutations for ordinary output', () => {
    const result = objectionResult();
    expect(planObjectionMutations(stateWithRequirement(), 'PM', { ...result, output: {} })).toEqual(
      [],
    );
  });

  it('rejects identity, role, message type, and payload mismatches', () => {
    expect(() =>
      planObjectionMutations(stateWithRequirement(), 'PM', objectionResult({ fromRole: 'CODER' })),
    ).toThrow('does not match the active role');
    expect(() =>
      planObjectionMutations(stateWithRequirement(), 'PM', objectionResult({ type: 'chat' })),
    ).toThrow('canonical objection message');
    expect(() =>
      planObjectionMutations(
        stateWithRequirement(),
        'PM',
        objectionResult({ payload: { objection: { claim: 'concern', argument: 'changed' } } }),
      ),
    ).toThrow('does not match the structured output');
  });
});
