import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger, summarize, trialMatrix } from './accounting';

const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), 'agora-final-budget-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('final benchmark accounting', () => {
  it('requires an explicit audit and charges the entire reservation for unrecoverable usage', () => {
    const path = join(root(), 'budget.json');
    const ledger = new BudgetLedger(path, 20, 17);
    ledger.reserve('request', 'diagnostic', 'diagnostic', 0.5);
    ledger.settle('request', undefined);
    expect(() => ledger.reserve('next', 'formal', 'formal', 0.1)).toThrow('unknown');
    ledger.auditUnknown(
      'request',
      'Wire usage was not retained; charge the pre-request maximum as an upper bound.',
    );
    expect(ledger.spent).toBe(0.5);
    expect(JSON.parse(readFileSync(path, 'utf8')).requests[0].audit.method).toBe(
      'reservation-upper-bound',
    );
    expect(() => ledger.auditUnknown('request', 'repeat')).toThrow('unknown');
    ledger.reserve('next', 'formal', 'formal', 0.1);
  });
  it('registers exactly 54 unique rotated trials without counting shared baselines twice', () => {
    const trials = trialMatrix();
    expect(trials).toHaveLength(54);
    expect(new Set(trials.map((t) => t.id)).size).toBe(54);
    expect(trials.filter((t) => t.suite === 'public')).toHaveLength(36);
    expect(trials.slice(0, 9).map((t) => t.variant)).toEqual([
      'single',
      'multi',
      'mixed',
      'multi',
      'mixed',
      'single',
      'mixed',
      'single',
      'multi',
    ]);
  });
  it('persists reservations before calls and preserves interrupted spending across restart', () => {
    const path = join(root(), 'budget.json');
    const ledger = new BudgetLedger(path, 20, 17);
    ledger.reserve('request-1', 'trial-1', 'formal', 0.5);
    expect(JSON.parse(readFileSync(path, 'utf8')).requests[0].status).toBe('reserved');
    const resumed = new BudgetLedger(path, 20, 17);
    expect(() => resumed.reserve('request-2', 'trial-2', 'formal', 0.1)).toThrow(/unresolved/);
    expect(() => resumed.reserve('request-1', 'trial-1', 'formal', 0.5)).toThrow();
  });
  it('enforces total, formal, per-trial and concurrent reservation limits', () => {
    const ledger = new BudgetLedger(join(root(), 'budget.json'), 2, 1.5);
    ledger.reserve('a', 'trial', 'formal', 0.9);
    expect(() => ledger.reserve('b', 'trial', 'formal', 0.7)).toThrow(/budget/);
    ledger.settle('a', 0.4);
    ledger.reserve('b', 'trial', 'formal', 0.7);
    ledger.settle('b', 0.6);
    expect(() => ledger.reserve('c', 'trial', 'formal', 0.6)).toThrow(/budget/);
    ledger.reserve('d', 'probe', 'diagnostic', 0.4);
    ledger.settle('d', 0.4);
    expect(() => ledger.reserve('e', 'probe', 'diagnostic', 0.2)).toThrow(/budget/);
    const trialLimit = new BudgetLedger(join(root(), 'budget.json'), 20, 17);
    trialLimit.reserve('a', 'same-trial', 'formal', 1.1);
    expect(() => trialLimit.reserve('b', 'same-trial', 'formal', 1)).toThrow(/budget/);
  });
  it('rejects invalid usage and blocks subsequent requests after unknown cost', () => {
    const ledger = new BudgetLedger(join(root(), 'budget.json'), 20, 17);
    ledger.reserve('a', 'trial', 'formal', 0.2);
    expect(() => ledger.settle('a', -1)).toThrow(/cost/);
    ledger.settle('a', undefined);
    expect(() => ledger.reserve('b', 'trial', 'formal', 0.1)).toThrow(/unknown/);
  });
  it('counts failures and provisional runs in denominator but never as zero success latency', () => {
    const summary = summarize([
      { id: 'a', final: true, passed: true, durationMs: 100 },
      { id: 'b', final: true, passed: false, durationMs: 10 },
      { id: 'c', final: false, passed: false, durationMs: 20 },
    ]);
    expect(summary).toMatchObject({ started: 3, passed: 1, provisional: 1 });
    expect(summary.successTime).toMatchObject({ count: 1, mean: 100, variance: null });
    expect(summary.failureTime).toMatchObject({ count: 1, mean: 10 });
    expect(() =>
      summarize([
        { id: 'a', final: true, passed: true, durationMs: 1 },
        { id: 'a', final: true, passed: true, durationMs: 1 },
      ]),
    ).toThrow(/duplicate/);
  });
});

it('persists an idempotent billing-window debit separately from model requests and enforces it after restart', () => {
  const path = join(root(), 'budget.json');
  const ledger = new BudgetLedger(path, 2, 1);
  const adjustment = {
    id: 'missing-regression-window',
    category: 'diagnostic' as const,
    amountUsd: 0.8,
    method: 'billing-window-upper-bound' as const,
    evidenceSha256: 'a'.repeat(64),
    reason: 'Entire provider billing window conservatively covers the missing run.',
    at: '2026-09-10T21:30:00.000Z',
  };
  ledger.addAuditAdjustment(adjustment);
  ledger.addAuditAdjustment({ ...adjustment });
  expect(JSON.parse(readFileSync(path, 'utf8')).requests).toHaveLength(0);
  expect(JSON.parse(readFileSync(path, 'utf8')).adjustments).toHaveLength(1);
  const resumed = new BudgetLedger(path, 2, 1);
  expect(resumed.spent).toBe(0.8);
  expect(resumed.remaining('diagnostic')).toBeCloseTo(0.2);
  expect(() => resumed.reserve('paid', 'live', 'diagnostic', 0.3)).toThrow('budget');
  expect(() => resumed.addAuditAdjustment({ ...adjustment, amountUsd: 0.1 })).toThrow('conflict');
  expect(() => resumed.addAuditAdjustment({ ...adjustment, id: 'invalid', amountUsd: -1 })).toThrow(
    'audit',
  );
});

it('includes retrospective debits in both category and global caps without altering request count', () => {
  const ledger = new BudgetLedger(join(root(), 'budget.json'), 2, 1);
  ledger.addAuditAdjustment({
    id: 'formal-window',
    category: 'formal',
    amountUsd: 1.1,
    method: 'billing-window-upper-bound',
    evidenceSha256: 'b'.repeat(64),
    reason: 'Record historical spending even when its category is already exhausted.',
    at: '2026-09-10T21:30:00.000Z',
  });
  expect(ledger.remaining('formal')).toBe(0);
  expect(ledger.remaining('diagnostic')).toBeCloseTo(0.9);
  expect(() => ledger.reserve('formal', 'f', 'formal', 0.01)).toThrow('budget');
  expect(() => ledger.reserve('diagnostic', 'd', 'diagnostic', 0.95)).toThrow('budget');
});

it('freezes only the two fresh holdouts in the repaired comparison without duplicating public trials', () => {
  const trials = trialMatrix('fresh-holdout');
  expect(trials).toHaveLength(18);
  expect(new Set(trials.map((t) => t.id)).size).toBe(18);
  expect(new Set(trials.map((t) => t.task))).toEqual(
    new Set(['thermal-inspection', 'daily-availability']),
  );
  expect(trials.every((t) => t.suite === 'holdout')).toBe(true);
  for (const task of ['thermal-inspection', 'daily-availability'])
    for (const variant of ['multi', 'parallel', 'sparse'])
      expect(
        trials.filter((t) => t.task === task && t.variant === variant).map((t) => t.attempt),
      ).toEqual([1, 2, 3]);
  expect(trialMatrix()).toHaveLength(54);
});
