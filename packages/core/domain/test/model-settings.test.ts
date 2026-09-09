import { describe, expect, it } from 'vitest';
import { configureRoleModels } from '../src/model-settings';
import { normalizeRoleSpec, PHASE0_ROSTER_ENTRIES } from '../src/roster';

describe('role model settings', () => {
  it('updates a complete target set without changing the input or other role facts', () => {
    const before = structuredClone(PHASE0_ROSTER_ENTRIES);
    const all = configureRoleModels(before, ['COORDINATOR', 'CODER', 'TESTER'], {
      model: 'custom-model',
      modelConnectionId: 'connection-1',
    });
    expect(all.every((r) => r.spec.modelConnectionId === 'connection-1')).toBe(true);
    const next = configureRoleModels(all, ['CODER'], {
      model: 'other',
      modelConnectionId: 'connection-2',
    });
    expect(next[1]?.spec.model).toBe('other');
    expect(next[2]).toEqual(all[2]);
    expect(before).toEqual(PHASE0_ROSTER_ENTRIES);
    const coder = next[1];
    if (!coder) throw new Error('missing CODER');
    expect(normalizeRoleSpec(coder.spec)).toEqual(coder.spec);
    expect(configureRoleModels(next, ['CODER'], null)[1]?.spec).toEqual(before[1]?.spec);
  });
  it('rejects an invalid target or connection before any change', () => {
    const before = structuredClone(PHASE0_ROSTER_ENTRIES);
    expect(() =>
      configureRoleModels(before, ['CODER', 'UNKNOWN'], { model: 'x', modelConnectionId: 'c' }),
    ).toThrow();
    expect(() => configureRoleModels(before, ['CODER', 'CODER'], null)).toThrow();
    expect(() => configureRoleModels(before, [], null)).toThrow();
    const coordinator = before[0];
    if (!coordinator) throw new Error('missing COORDINATOR');
    expect(() => normalizeRoleSpec({ ...coordinator.spec, modelConnectionId: '../x' })).toThrow();
    expect(before).toEqual(PHASE0_ROSTER_ENTRIES);
  });
});
