import { describe, expect, it } from 'vitest';
import type { LocalExecutionV1 } from '../src/local-execution';
import { assertLocalExecutionState, isLocalExecutionV1 } from '../src/local-execution';
import { applyMutations, setMutation } from '../src/reducer';
import { type AppState, createInitialAppState } from '../src/state';

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('missing test fixture');
  return value;
}

const local = () => ({
  schemaVersion: 'local-execution-v1' as const,
  rootIds: ['root'],
  workspaces: [
    {
      schemaVersion: 'workspace-v1' as const,
      projectId: 'project',
      taskId: 'task',
      workspaceId: 'workspace',
      rootId: 'root',
      grantId: 'grant',
      purpose: 'coding' as const,
      mode: 'direct' as const,
      baselineManifestId: 'manifest',
    },
  ],
  bindings: [
    { workerId: 'coder', subtaskId: 'code', workspaceId: 'workspace', receiptId: 'receipt' },
  ],
  receipts: [
    { receiptId: 'receipt', actionId: 'action', inputHash: 'a'.repeat(64), registryRevision: 1 },
  ],
});
const state = () => ({
  ...createInitialAppState('task', 'fixed local task', 'project'),
  workers: [
    {
      workerId: 'coder',
      subtaskId: 'code',
      role: 'CODER',
      executor: 'harness' as const,
      status: 'pending' as const,
      startedTs: 0,
    },
  ],
  subtasks: [
    { id: 'code', title: 'fixed code', ownerRole: 'CODER', status: 'todo' as const, dependsOn: [] },
  ],
});

describe('canonical local execution references', () => {
  it('allows a task-scoped reader without inventing a coder subtask, and keeps absence immutable', () => {
    const value: LocalExecutionV1 = local();
    const candidate: AppState = state();
    first(value.workspaces).purpose = 'validation';
    delete first(value.bindings).subtaskId;
    const worker = first(candidate.workers);
    worker.role = 'TESTER';
    delete worker.subtaskId;
    expect(isLocalExecutionV1(value)).toBe(true);
    const bound = applyMutations(candidate, [setMutation('localExecution', value)]);
    const changed = structuredClone(value);
    first(changed.bindings).subtaskId = 'code';
    const reassigned = { ...bound, workers: [{ ...worker, subtaskId: 'code' }] };
    expect(() => applyMutations(reassigned, [setMutation('localExecution', changed)])).toThrow();
    first(value.workspaces).purpose = 'coding';
    expect(() => applyMutations(candidate, [setMutation('localExecution', value)])).toThrow();
  });
  it('accepts a scoped registration without interpreting it as live authority', () => {
    const value = local();
    expect(isLocalExecutionV1(value)).toBe(true);
    const next = applyMutations(state(), [setMutation('localExecution', value)]);
    expect(next.localExecution).toEqual(value);
    expect(state()).not.toHaveProperty('localExecution');
    first(value.receipts).inputHash = 'b'.repeat(64);
    expect(next.localExecution?.receipts[0]?.inputHash).toBe('a'.repeat(64));
  });
  it.each(['projectId', 'taskId', 'rootId'])('rejects cross-scope workspace %s', (key) => {
    const value = local();
    Object.assign(first(value.workspaces), { [key]: 'other' });
    expect(() => applyMutations(state(), [setMutation('localExecution', value)])).toThrow();
  });
  it.each(['workerId', 'subtaskId', 'workspaceId', 'receiptId'])(
    'rejects a dangling %s binding',
    (key) => {
      const value = local();
      Object.assign(first(value.bindings), { [key]: 'missing' });
      expect(() => applyMutations(state(), [setMutation('localExecution', value)])).toThrow();
    },
  );
  it('refuses worker reassignment under an existing binding', () => {
    const initial = applyMutations(state(), [setMutation('localExecution', local())]);
    expect(() =>
      assertLocalExecutionState({
        ...initial,
        workers: [{ ...first(initial.workers), subtaskId: 'different' }],
      }),
    ).toThrow();
  });
  it.each(['rootIds', 'workspaces', 'bindings', 'receipts'])(
    'retains historical %s when closing authority elsewhere',
    (key) => {
      const initial = applyMutations(state(), [setMutation('localExecution', local())]);
      expect(() =>
        applyMutations(initial, [setMutation('localExecution', { ...local(), [key]: [] })]),
      ).toThrow();
      expect(() => applyMutations(initial, [setMutation('localExecution', undefined)])).toThrow();
    },
  );
  it('rejects reusing an action or receipt for different input', () => {
    const initial = applyMutations(state(), [setMutation('localExecution', local())]);
    const value = local();
    first(value.receipts).inputHash = 'b'.repeat(64);
    expect(() => applyMutations(initial, [setMutation('localExecution', value)])).toThrow();
    const duplicate = local();
    duplicate.receipts.push({ ...first(duplicate.receipts), receiptId: 'different' });
    expect(isLocalExecutionV1(duplicate)).toBe(false);
  });
  it('rejects old worktree authority both on load and reducer writes', () => {
    const initial = state();
    initial.workers[0] = {
      ...first(initial.workers),
      worktree: '/legacy',
    } as (typeof initial.workers)[0];
    expect(() => applyMutations(initial, [setMutation('localExecution', local())])).toThrow();
    expect(() =>
      assertLocalExecutionState({
        ...state(),
        localExecution: local(),
        subtasks: [{ ...first(state().subtasks), worktree: '/legacy' }],
      }),
    ).toThrow();
  });
  it('requires a files version for direct workspace test evidence', () => {
    const initial = applyMutations(state(), [setMutation('localExecution', local())]);
    const results = { passed: true, total: 1, failed: 0, failures: [] };
    expect(() => applyMutations(initial, [setMutation('testResults', results)])).toThrow();
    expect(() =>
      applyMutations(initial, [
        setMutation('testResults', {
          ...results,
          workspaceVersion: {
            kind: 'git',
            commit: 'a'.repeat(40),
            manifestId: 'manifest',
            manifestHash: 'b'.repeat(64),
          },
        }),
      ]),
    ).toThrow();
    expect(
      applyMutations(initial, [
        setMutation('testResults', {
          ...results,
          workspaceVersion: { kind: 'files', manifestId: 'manifest', manifestHash: 'b'.repeat(64) },
        }),
      ]).testResults?.passed,
    ).toBe(true);
    expect(() =>
      applyMutations(state(), [
        setMutation('testResults', {
          ...results,
          workspaceVersion: { kind: 'files', manifestId: 'manifest', manifestHash: 'b'.repeat(64) },
        }),
      ]),
    ).toThrow();
  });
  it('rejects non-JSON data without running its accessors', () => {
    let reads = 0;
    const value = local();
    Object.defineProperty(value, 'bindings', {
      get: () => {
        reads++;
        return [];
      },
      enumerable: true,
    });
    expect(isLocalExecutionV1(value)).toBe(false);
    expect(reads).toBe(0);
  });
});
