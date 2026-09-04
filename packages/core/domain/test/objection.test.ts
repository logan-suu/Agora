import { describe, expect, it } from 'vitest';
import type { Decision, ObjectionDraft, Requirement } from '../src/index';
import { classifyObjection } from '../src/index';

const decisions: Decision[] = [
  {
    id: 'dec-1',
    topic: 'runtime',
    decision: 'Use Node 24',
    rationale: 'Host baseline',
    authority: 'leader',
    by: 'leader',
    ts: 1,
  },
];

const requirements: Requirement[] = [
  { id: 'req-1', story: 'Persist tasks', acceptance: ['survives restart'], nonGoals: [] },
];

function draft(overrides: Partial<ObjectionDraft> = {}): ObjectionDraft {
  return {
    id: 'obj-1',
    threadId: 'obj-1',
    fromRole: 'PM',
    claim: 'concern',
    argument: 'Consider a clearer name.',
    ts: 2,
    ...overrides,
  };
}

describe('classifyObjection · D14 deterministic dual track', () => {
  it('classifies a general concern as advisory without inventing a target', () => {
    expect(classifyObjection(draft(), decisions, requirements)).toEqual({
      ...draft(),
      track: 'advisory',
    });
  });

  it('classifies an explicit contradiction against a current requirement as blocking', () => {
    const input = draft({
      claim: 'contradiction',
      target: { kind: 'requirement', id: 'req-1' },
      argument: 'The proposed in-memory store cannot survive restart.',
    });
    expect(classifyObjection(input, decisions, requirements)).toEqual({
      ...input,
      target: { kind: 'requirement', id: 'req-1' },
      track: 'blocking',
    });
  });

  it('classifies an explicit contradiction against a current decision as blocking', () => {
    const input = draft({
      claim: 'contradiction',
      target: { kind: 'decision', id: 'dec-1' },
    });
    expect(classifyObjection(input, decisions, requirements).track).toBe('blocking');
  });

  it('keeps a targeted concern advisory after validating its reference', () => {
    const input = draft({ target: { kind: 'decision', id: 'dec-1' } });
    expect(classifyObjection(input, decisions, requirements).track).toBe('advisory');
  });

  it('rejects contradiction without a target and unknown or superseded targets', () => {
    expect(() =>
      classifyObjection(draft({ claim: 'contradiction' }), decisions, requirements),
    ).toThrow('contradiction requires a target');
    expect(() =>
      classifyObjection(
        draft({ target: { kind: 'requirement', id: 'req-missing' } }),
        decisions,
        requirements,
      ),
    ).toThrow('unknown requirement');

    const overridden: Decision[] = [
      ...decisions,
      {
        ...decisions[0],
        id: 'dec-2',
        decision: 'Use Node 26',
        supersedes: 'dec-1',
        ts: 3,
      } as Decision,
    ];
    expect(() =>
      classifyObjection(
        draft({ target: { kind: 'decision', id: 'dec-1' } }),
        overridden,
        requirements,
      ),
    ).toThrow('is no longer current');
  });

  it('rejects malformed drafts and model-supplied track/status fields', () => {
    const malformed = [
      draft({ id: '' }),
      draft({ threadId: '' }),
      draft({ fromRole: '' }),
      draft({ argument: '' }),
      draft({ ts: Number.NaN }),
      { ...draft(), track: 'blocking' },
      { ...draft(), status: 'open' },
      { ...draft(), target: { kind: 'decision', id: '' } },
    ];
    for (const input of malformed) {
      expect(() => classifyObjection(input as ObjectionDraft, decisions, requirements)).toThrow(
        'invalid objection',
      );
    }
  });
});
