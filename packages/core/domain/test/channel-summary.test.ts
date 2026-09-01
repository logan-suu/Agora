import { describe, expect, it } from 'vitest';

import { parseChannelSummary } from '../src/index';

const valid = {
  conclusion: 'Use revision CAS.',
  keyDecisions: [{ decision: 'Message first', rationale: 'First-write-stays is canonical.' }],
  openQuestions: [],
  sourceMsgIds: ['m1'],
};

describe('parseChannelSummary', () => {
  it('accepts the exact schema and returns copies', () => {
    expect(parseChannelSummary(valid, new Set(['m1']))).toEqual(valid);
  });

  it.each([
    [{ ...valid, extra: true }, 'missing or unexpected'],
    [{ ...valid, conclusion: '' }, 'conclusion'],
    [{ ...valid, keyDecisions: [{ decision: 'x', rationale: '', extra: true }] }, 'unexpected'],
    [{ ...valid, sourceMsgIds: ['m1', 'm1'] }, 'unique'],
    [{ ...valid, sourceMsgIds: ['other'] }, 'outside the source channel'],
  ])('rejects malformed or unscoped output', (value, message) => {
    expect(() => parseChannelSummary(value, new Set(['m1']))).toThrow(message);
  });
});
