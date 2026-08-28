import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { evaluateRouteWhen } from '../src/route-conditions';

describe('evaluateRouteWhen (task 2.2 conditional-routing predicates)', () => {
  it('always is unconditionally true', () => {
    expect(evaluateRouteWhen(createInitialAppState('t-1', 'g'), 'always')).toBe(true);
  });

  it('goalAmbiguous holds while requirements are empty and drops once PM distills them', () => {
    const initial = createInitialAppState('t-1', '实现 LRU 缓存');
    expect(evaluateRouteWhen(initial, 'goalAmbiguous')).toBe(true);
    const clarified = applyMutations(initial, [
      mergeByIdMutation('requirements', 'req-1', {
        story: 's',
        acceptance: ['a'],
        nonGoals: [],
      }),
    ]);
    expect(evaluateRouteWhen(clarified, 'goalAmbiguous')).toBe(false);
  });

  it('requirementsReady mirrors goalAmbiguous: true only after requirements exist', () => {
    const initial = createInitialAppState('t-1', 'g');
    expect(evaluateRouteWhen(initial, 'requirementsReady')).toBe(false);
    const clarified = applyMutations(initial, [
      mergeByIdMutation('requirements', 'req-1', { story: 's', acceptance: ['a'], nonGoals: [] }),
    ]);
    expect(evaluateRouteWhen(clarified, 'requirementsReady')).toBe(true);
  });

  it('designReady holds only after ARCHITECT has written the architecture slice', () => {
    const initial = createInitialAppState('t-1', 'g');
    expect(evaluateRouteWhen(initial, 'designReady')).toBe(false);
    const designed = applyMutations(initial, [setMutation('architecture', { modules: ['core'] })]);
    expect(evaluateRouteWhen(designed, 'designReady')).toBe(true);
  });

  it('codingDone holds when the CODER-owned subtask has been marked done', () => {
    const initial = createInitialAppState('t-1', 'g');
    expect(evaluateRouteWhen(initial, 'codingDone')).toBe(false);
    const coded = applyMutations(initial, [
      mergeByIdMutation('subtasks', 't-1-sub-0', {
        title: 'g',
        ownerRole: 'CODER',
        dependsOn: [],
        status: 'done',
      }),
    ]);
    expect(evaluateRouteWhen(coded, 'codingDone')).toBe(true);
  });

  it('testsPassed / testsFailed partition the TESTER verdict', () => {
    const base = createInitialAppState('t-1', 'g');
    const passed = applyMutations(base, [
      setMutation('testResults', { passed: true, total: 2, failed: 0, failures: [] }),
    ]);
    const failed = applyMutations(base, [
      setMutation('testResults', { passed: false, total: 2, failed: 2, failures: [] }),
    ]);
    expect(evaluateRouteWhen(passed, 'testsPassed')).toBe(true);
    expect(evaluateRouteWhen(passed, 'testsFailed')).toBe(false);
    expect(evaluateRouteWhen(failed, 'testsPassed')).toBe(false);
    expect(evaluateRouteWhen(failed, 'testsFailed')).toBe(true);
    expect(evaluateRouteWhen(base, 'testsPassed')).toBe(false);
    expect(evaluateRouteWhen(base, 'testsFailed')).toBe(false);
  });

  it('evaluates the CODER composite "designReady || testsFailed" from the roster data', () => {
    const base = createInitialAppState('t-1', 'g');
    expect(evaluateRouteWhen(base, 'designReady || testsFailed')).toBe(false);
    const failedOnly = applyMutations(base, [
      setMutation('testResults', { passed: false, total: 1, failed: 1, failures: [] }),
    ]);
    expect(evaluateRouteWhen(failedOnly, 'designReady || testsFailed')).toBe(true);
    const designedOnly = applyMutations(failedOnly, [setMutation('architecture', { m: 1 })]);
    expect(evaluateRouteWhen(designedOnly, 'designReady || testsFailed')).toBe(true);
  });

  it('throws on an unknown atom instead of silently routing', () => {
    expect(() => evaluateRouteWhen(createInitialAppState('t-1', 'g'), 'vibesGood')).toThrow(
      'unknown routeWhen condition "vibesGood"',
    );
    expect(() => evaluateRouteWhen(createInitialAppState('t-1', 'g'), '  ')).toThrow(
      'empty routeWhen condition',
    );
  });
});
