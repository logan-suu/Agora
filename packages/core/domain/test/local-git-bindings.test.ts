import { describe, expect, it } from 'vitest';
import { assertLocalExecutionState } from '../src/local-execution';
import { applyMutations, setMutation } from '../src/reducer';
import { type AppState, createInitialAppState } from '../src/state';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('missing fixture value');
  return value;
}

const commit = 'a'.repeat(40);
function fixture() {
  const workspace = (workspaceId: string, purpose: 'coding' | 'validation' | 'integration') => ({
    schemaVersion: 'workspace-v1' as const,
    projectId: 'project',
    taskId: 'task',
    workspaceId,
    rootId: 'root',
    grantId: 'grant',
    mode: 'linked-worktree' as const,
    purpose,
    commonDirId: 'common',
    branch: workspaceId,
    baseCommit: commit,
  });
  const refs = ['initial', 'coding', 'validation'].map((workspaceId) => ({
    workspaceId,
    path: `/owned/${workspaceId}`,
    receiptId: 'registration',
  }));
  const tree = (workspaceId: string) => ({
    path: `/owned/${workspaceId}`,
    branch: workspaceId,
    baseCommit: commit,
    headCommit: commit,
  });
  const local = {
    schemaVersion: 'local-execution-v1' as const,
    rootIds: ['root'],
    workspaces: [
      workspace('initial', 'integration'),
      workspace('coding', 'coding'),
      workspace('validation', 'validation'),
    ],
    bindings: [
      { workerId: 'coder', subtaskId: 'code', workspaceId: 'coding', receiptId: 'registration' },
      { workerId: 'tester', workspaceId: 'validation', receiptId: 'registration' },
    ],
    receipts: [
      {
        receiptId: 'registration',
        actionId: 'register',
        inputHash: 'b'.repeat(64),
        registryRevision: 1,
      },
    ],
    git: { version: 1 as const, initialWorkspaceId: 'initial', worktrees: refs },
  };
  const state: AppState = {
    ...createInitialAppState('task', 'parallel local work', 'project'),
    messages: [
      {
        msgId: 'plan',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        ts: 0,
        payload: {
          kind: 'execution_plan',
          plan: { version: 1, subtasks: [{ id: 'code', title: 'Code', dependsOn: [] }] },
        },
        display: 'Plan',
      },
    ],
    workers: [
      {
        workerId: 'coder',
        subtaskId: 'code',
        role: 'CODER',
        executor: 'harness',
        status: 'done',
        startedTs: 0,
        worktree: tree('coding'),
      },
      {
        workerId: 'tester',
        role: 'TESTER',
        executor: 'harness',
        status: 'pending',
        startedTs: 0,
        worktree: tree('validation'),
      },
    ],
    subtasks: [
      {
        id: 'code',
        title: 'Code',
        ownerRole: 'CODER',
        status: 'in_progress',
        dependsOn: [],
        worktree: tree('coding'),
      },
    ],
    localExecution: local,
    parallelExecution: { version: 1, planId: 'plan', initialBase: { branch: 'initial', commit } },
    integration: {
      integrationId: 'integration',
      waveId: 'wave',
      base: { branch: 'initial', commit },
      integrationWorktree: tree('initial'),
      pendingBranches: [
        { workerId: 'coder', subtaskId: 'code', worktree: tree('coding'), topologicalRank: 0 },
      ],
      mergedBranches: [],
      conflicts: [],
      status: 'merging',
    },
  };
  return { state, local, tree };
}

describe('registered local Git references', () => {
  it('admits D17 references only through their registered immutable workspace mapping', () => {
    const { state } = fixture();
    expect(() => assertLocalExecutionState(state)).not.toThrow();
    expect(applyMutations(state, []).localExecution).toEqual(state.localExecution);
  });
  it.each(['path', 'branch', 'baseCommit'])(
    'rejects a worker %s outside its registration',
    (field) => {
      const { state, tree } = fixture();
      required(state.workers[0]).worktree = {
        ...tree('coding'),
        [field]: field === 'baseCommit' ? 'c'.repeat(40) : 'other',
      };
      expect(() => assertLocalExecutionState(state)).toThrow('local_git_reference_mismatch');
    },
  );
  it('cannot borrow another worker workspace, even within the same task', () => {
    const { state, tree } = fixture();
    required(state.workers[0]).worktree = tree('validation');
    expect(() => assertLocalExecutionState(state)).toThrow('local_git_reference_mismatch');
  });
  it('keeps the initial cumulative baseline immutable', () => {
    const { state, local } = fixture();
    required(state.parallelExecution).initialBase.commit = 'd'.repeat(40);
    expect(() => assertLocalExecutionState(state)).toThrow('local_git_initial_base_mismatch');
    const original = fixture();
    expect(() =>
      applyMutations(original.state, [
        setMutation('localExecution', {
          ...local,
          git: { ...local.git, initialWorkspaceId: 'coding' },
        }),
      ]),
    ).toThrow();
  });
  it.each(['workspaceId', 'path', 'receiptId'])(
    'cannot rewrite a historical mapping %s',
    (field) => {
      const { state, local } = fixture();
      const changed = structuredClone(local);
      Object.assign(required(changed.git.worktrees[0]), { [field]: 'different' });
      expect(() => applyMutations(state, [setMutation('localExecution', changed)])).toThrow();
      const { git: _git, ...direct } = local;
      expect(() => applyMutations(state, [setMutation('localExecution', direct)])).toThrow();
    },
  );
  it('rejects an unmapped integration source and a tester-owned subtask tree', () => {
    const { state, tree } = fixture();
    required(required(state.integration).pendingBranches[0]).workerId = 'tester';
    expect(() => assertLocalExecutionState(state)).toThrow('local_git_reference_mismatch');
    const other = fixture();
    required(other.state.subtasks[0]).worktree = tree('validation');
    expect(() => assertLocalExecutionState(other.state)).toThrow('local_git_reference_mismatch');
  });
  it.each(['/owned/../coding', 'relative', '/owned//coding', '/owned/coding/'])(
    'rejects noncanonical mapping path %s',
    (path) => {
      const { state, local } = fixture();
      required(local.git.worktrees[1]).path = path;
      expect(() => assertLocalExecutionState(state)).toThrow();
    },
  );
  it('rejects duplicate paths and unregistered receipts', () => {
    const { state, local } = fixture();
    required(local.git.worktrees[1]).path = required(local.git.worktrees[0]).path;
    expect(() => assertLocalExecutionState(state)).toThrow();
    const other = fixture();
    required(other.local.git.worktrees[1]).receiptId = 'unknown';
    expect(() => assertLocalExecutionState(other.state)).toThrow();
  });
  it('checks historical validation worktree references, not only active workers', () => {
    const { state, tree } = fixture();
    state.messages.push({
      msgId: 'validation',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      ts: 1,
      payload: {
        kind: 'wave_validation',
        workerId: 'tester',
        worktree: { ...tree('validation'), path: '/foreign' },
      },
      display: 'validation',
    });
    expect(() => assertLocalExecutionState(state)).toThrow('local_git_reference_mismatch');
  });
});
