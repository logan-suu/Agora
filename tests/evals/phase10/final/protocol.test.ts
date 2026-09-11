import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BudgetLedger } from './accounting';
import { GroupRegistry } from './manifest';
import { budgetTrialId, operatorStopRequested, resolveGroupId } from './protocol';

it('separates group directories and per-attempt accounting without accepting path traversal', () => {
  expect(resolveGroupId()).toBe('phase10-final-v14');
  expect(resolveGroupId('phase10-final-v1')).toBe('phase10-final-v1');
  expect(() => resolveGroupId('../phase10-final-v2')).toThrow('group');
  const root = mkdtempSync(join(tmpdir(), 'phase10-group-'));
  try {
    const ledger = new BudgetLedger(join(root, 'budget.json'), 20, 17);
    for (const group of ['phase10-final-v1', 'phase10-final-v2']) {
      ledger.reserve(group, budgetTrialId(group, 'same-trial'), 'formal', 1.5);
      ledger.settle(group, 1.5);
    }
    expect(ledger.spent).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('honors an operator stop after the active attempt closes and preserves unstarted entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'phase10-stop-'));
  try {
    const registry = new GroupRegistry(join(root, 'group.json'), {
      schemaVersion: 1,
      trials: [{ id: 'active' }, { id: 'next' }],
      frozen: {},
    });
    expect(operatorStopRequested(root)).toBe(false);
    registry.start('active', join(root, 'run'));
    writeFileSync(join(root, 'stop-requested.json'), '{}');
    expect(registry.read().attempts[0]?.status).toBe('started');
    registry.finish('active', { lifecycle: 'final' });
    expect(operatorStopRequested(root)).toBe(true);
    expect(registry.pending()).toEqual(['next']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
