import { expect, it } from 'vitest';
import { ExperimentBudget, usageCost } from './metrics';

it('prices cache hits separately without counting reasoning output twice', () => {
  expect(
    usageCost(
      { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
      true,
    ),
  ).toBeCloseTo(1.774);
  expect(
    usageCost({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, false),
  ).toBeCloseTo(0.22);
});
it('refuses unknown usage and reserves all concurrent requests before admitting more', () => {
  const budget = new ExperimentBudget(1);
  const first = budget.reserve(0.6);
  expect(() => budget.reserve(0.6)).toThrow(/budget/);
  budget.finish(first, 0.1);
  const second = budget.reserve(0.6);
  budget.finish(second, undefined);
  expect(() => budget.reserve(0.1)).toThrow(/unknown/);
  expect(budget.costUsd).toBe('unknown');
});

it('rejects invalid limits, reservations and settlements', () => {
  expect(() => new ExperimentBudget(-1)).toThrow();
  const budget = new ExperimentBudget(1);
  expect(() => budget.reserve(-1)).toThrow();
  expect(() => budget.reserve(Number.NaN)).toThrow();
  const reservation = budget.reserve(0.5);
  expect(() => budget.finish(reservation, -1)).toThrow();
});

it.each([-100, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects unreliable cache-write usage %s',
  (cacheWriteTokens) => {
    const budget = new ExperimentBudget(1);
    const reservation = budget.reserve(0.6);
    const cost = usageCost(
      { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens },
      true,
    );
    expect(cost).toBeUndefined();
    budget.finish(reservation, cost);
    expect(budget.costUsd).toBe('unknown');
    expect(() => budget.reserve(0.1)).toThrow(/unknown/);
  },
);
