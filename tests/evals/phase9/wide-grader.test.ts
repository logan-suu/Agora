import { expect, it } from 'vitest';
import { passesWideProcess } from './wide-grader';

const first = ['A', 'B', 'C', 'D'];
const repaired = [
  { receiptId: 'failed-1', passed: false },
  { receiptId: 'accepted-2', passed: true },
];

it('accepts an evidenced repair while retaining the failed validation in history', () => {
  expect(passesWideProcess([first, ['E']], repaired, 'accepted-2')).toBe(true);
  expect(passesWideProcess([first, ['E'], ['A'], ['E']], repaired, 'accepted-2')).toBe(true);
  expect(repaired[0]?.passed).toBe(false);
});

it('requires an existing successful final accepted receipt, not just some past pass', () => {
  expect(passesWideProcess([first, ['E']], [], undefined)).toBe(false);
  expect(passesWideProcess([first, ['E']], repaired, 'missing')).toBe(false);
  expect(passesWideProcess([first, ['E']], repaired, 'failed-1')).toBe(false);
  expect(
    passesWideProcess(
      [first, ['E']],
      [...repaired, { receiptId: 'later-failed', passed: false }],
      'accepted-2',
    ),
  ).toBe(false);
});

it('rejects a split initial wave, unknown assignments, duplicates, and a missing dependent rerun', () => {
  for (const waves of [
    [['A'], ['B'], ['C'], ['D'], ['E']],
    [first, ['X'], ['E']],
    [first, ['A', 'A'], ['E']],
    [first, ['E'], ['A']],
    [first, ['A', 'E']],
  ])
    expect(passesWideProcess(waves, repaired, 'accepted-2')).toBe(false);
});
