// A control-store double isolates registration ordering and immutable identity.
// Real registry/Git/native admission remains a separate Task 12.4 integration gate.
import {
  type AppState,
  applyMutations,
  createInitialAppState,
  setMutation,
} from '@agora/core-domain';
import { expect, it } from 'vitest';
import type { LocalBindingCoordinator } from '../src/local-binding-coordinator';
import { LocalGitReviewerBinding } from '../src/local-git-reviewer-binding';
import type { LocalBindingOperation } from '../src/local-registry-records';

const commit = 'a'.repeat(40);
const head = 'b'.repeat(40);
const fingerprint = 'f'.repeat(64);
const ref = {
  path: '/private/tmp/owned-validation',
  branch: 'validation',
  baseCommit: commit,
  headCommit: head,
};
const version = {
  kind: 'git' as const,
  commit: head,
  manifestId: `manifest:${'c'.repeat(64)}`,
  manifestHash: 'c'.repeat(64),
};
const workspace = {
  schemaVersion: 'workspace-v1' as const,
  projectId: 'project',
  taskId: 'task',
  workspaceId: 'validation',
  rootId: 'root',
  grantId: 'grant',
  purpose: 'validation' as const,
  mode: 'linked-worktree' as const,
  commonDirId: 'common',
  branch: ref.branch,
  baseCommit: ref.baseCommit,
};
const initialWorkspace = {
  ...workspace,
  workspaceId: 'initial',
  purpose: 'integration' as const,
  branch: 'initial',
};

function setup() {
  const scope = { projectId: 'project', taskId: 'task', workerId: 'worker:review:0' };
  const state: AppState = {
    ...createInitialAppState('task', 'goal', 'project'),
    phase: 'review',
    nextRole: 'REVIEWER',
    architecture: {
      executionPlan: { version: 1, subtasks: [{ id: 'A', title: 'Answer', dependsOn: [] }] },
    },
    subtasks: [{ id: 'A', title: 'Answer', ownerRole: 'CODER', dependsOn: [], status: 'done' }],
    parallelExecution: {
      version: 1,
      planId: 'plan',
      initialBase: { branch: 'initial', commit },
      acceptedReceiptId: 'wave-validation:dispatch',
    },
    testResults: { passed: true, total: 1, failed: 0, failures: [], workspaceVersion: version },
    workers: [
      {
        workerId: 'worker:dispatch:0',
        role: 'TESTER',
        executor: 'harness',
        status: 'done',
        startedTs: 1,
        worktree: ref,
      },
      {
        workerId: scope.workerId,
        role: 'REVIEWER',
        executor: 'harness',
        status: 'pending',
        startedTs: 2,
      },
    ],
    messages: [
      {
        msgId: 'plan',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        display: 'Plan',
        ts: 0,
        payload: {
          kind: 'execution_plan',
          plan: { version: 1, subtasks: [{ id: 'A', title: 'Answer', dependsOn: [] }] },
        },
      },
      {
        msgId: 'dispatch',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        display: 'Validate',
        ts: 1,
        payload: {
          kind: 'wave_validation_dispatch',
          planId: 'plan',
          waveId: 'wave',
          attempt: 1,
          integrationId: 'integration',
          inputCommit: commit,
          subtaskIds: ['A'],
        },
      },
      {
        msgId: 'wave-validation:dispatch',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        display: 'Validated',
        ts: 2,
        payload: {
          kind: 'wave_validation',
          version: 1,
          planId: 'plan',
          waveId: 'wave',
          attempt: 1,
          dispatchId: 'dispatch',
          workerId: 'worker:dispatch:0',
          integrationId: 'integration',
          inputCommit: commit,
          worktree: ref,
          subtaskIds: ['A'],
          controlFingerprint: fingerprint,
          results: { passed: true, total: 1, failed: 0, failures: [] },
          evidence: {
            path: 'validation/dispatch.json',
            sha256: 'd'.repeat(64),
            exitCode: 0,
            timedOut: false,
          },
        },
      },
      {
        msgId: 'review',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        display: 'Review',
        ts: 3,
        payload: {
          kind: 'parallel_review_dispatch',
          nextRole: 'REVIEWER',
          workerIds: [scope.workerId],
          reviewCommentCursor: 0,
          reviewBinding: {
            planId: 'plan',
            validationReceiptId: 'wave-validation:dispatch',
            commit: head,
            controlFingerprint: fingerprint,
          },
        },
      },
    ],
    localExecution: {
      schemaVersion: 'local-execution-v1',
      rootIds: ['root'],
      workspaces: [initialWorkspace, workspace],
      bindings: [
        { workerId: 'worker:dispatch:0', workspaceId: 'validation', receiptId: 'source-binding' },
      ],
      receipts: [
        {
          receiptId: 'initial-binding',
          actionId: 'initial',
          inputHash: 'd'.repeat(64),
          registryRevision: 1,
        },
        {
          receiptId: 'source-binding',
          actionId: 'source',
          inputHash: 'e'.repeat(64),
          registryRevision: 2,
        },
      ],
      git: {
        version: 1,
        initialWorkspaceId: 'initial',
        worktrees: [
          {
            workspaceId: 'initial',
            path: '/private/tmp/owned-initial',
            receiptId: 'initial-binding',
          },
          { workspaceId: 'validation', path: ref.path, receiptId: 'source-binding' },
        ],
      },
    },
  };
  const registry = {
    revision: 4,
    roots: [],
    grants: [
      {
        grantId: 'grant',
        projectId: 'project',
        rootId: 'root',
        status: 'active',
        actions: ['read'],
        leaderMessageId: 'leader-grant',
      },
    ],
    workspaces: [initialWorkspace, workspace],
    claims: [{ workerId: 'worker:dispatch:0', workspaceId: 'validation', status: 'released' }],
    linkedRoots: [
      {
        workspaceId: 'initial',
        path: '/private/tmp/owned-initial',
        bindingReceiptId: 'initial-binding',
      },
      { workspaceId: 'validation', path: ref.path, bindingReceiptId: 'source-binding' },
    ],
    operations: [
      { actionId: 'initial', receiptId: 'initial-binding', stage: 'committed' },
      { actionId: 'source', receiptId: 'source-binding', stage: 'committed' },
    ] as (Partial<LocalBindingOperation> &
      Pick<LocalBindingOperation, 'actionId' | 'receiptId' | 'stage'>)[],
  };
  let current = state;
  let commits = 0;
  let recoveries = 0;
  const control = {
    snapshot: async () => structuredClone(registry),
    assertClosed: async () => structuredClone(current),
    commitBinding: async (request: Parameters<LocalBindingCoordinator['commitBinding']>[0]) => {
      commits++;
      expect(request.records.workspaces).toEqual([initialWorkspace, workspace]);
      expect(request.records.claims).toEqual(registry.claims);
      expect(request.sourceMessageId).toBe('leader-grant');
      expect(request.actionId).toBe('review-binding:review');
      const receiptId = `binding:${request.actionId}`;
      const updated: AppState = {
        ...current,
        localExecution: {
          ...request.nextLocalExecution,
          receipts: [
            ...request.nextLocalExecution.receipts,
            {
              receiptId,
              actionId: request.actionId,
              inputHash: 'a'.repeat(64),
              registryRevision: registry.revision + 1,
            },
          ],
        },
      };
      current = applyMutations(current, [setMutation('localExecution', updated.localExecution)]);
      registry.revision += 2;
      registry.operations.push({ actionId: request.actionId, receiptId, stage: 'committed' });
      return {};
    },
    recover: async (actionId: string, inputHash: string) => {
      recoveries++;
      const operation = registry.operations.find((item) => item.actionId === actionId);
      if (operation?.stage !== 'prepared' || operation.inputHash !== inputHash)
        throw Error('operation_conflict');
      const next = operation.nextLocalExecution;
      if (!next) throw Error('operation_conflict');
      current = applyMutations(current, [setMutation('localExecution', next)]);
      operation.stage = 'committed';
      registry.revision++;
      return operation;
    },
  } as unknown as Pick<
    LocalBindingCoordinator,
    'snapshot' | 'assertClosed' | 'commitBinding' | 'recover'
  >;
  let proofs = 0;
  const service = new LocalGitReviewerBinding({
    control,
    verifyGrant: async (_scope, id) => {
      expect(id).toBe('grant');
    },
    verifyCandidate: async () => {
      proofs++;
      return version;
    },
  });
  return {
    scope,
    service,
    registry,
    get state() {
      return current;
    },
    set state(value: AppState) {
      current = value;
    },
    get commits() {
      return commits;
    },
    get recoveries() {
      return recoveries;
    },
    get proofs() {
      return proofs;
    },
  };
}

it('registers a reviewer-specific receipt on the validated workspace without a new claim', async () => {
  const f = setup();
  await expect(f.service.register(f.scope)).resolves.toEqual(workspace);
  expect(f.commits).toBe(1);
  expect(f.proofs).toBe(2);
  expect(f.state.localExecution?.bindings.at(-1)).toEqual({
    workerId: f.scope.workerId,
    workspaceId: workspace.workspaceId,
    receiptId: 'binding:review-binding:review',
  });
  expect(f.registry.workspaces).toEqual([initialWorkspace, workspace]);
  expect(f.registry.claims).toHaveLength(1);
  await expect(f.service.register(f.scope)).resolves.toEqual(workspace);
  expect(f.commits).toBe(1);
});

it('rejects a mismatched reviewer and a changed TESTER worktree before registration', async () => {
  const f = setup();
  await expect(f.service.register({ ...f.scope, workerId: 'worker:other:0' })).rejects.toThrow(
    'local_git_review_registration_invalid',
  );
  f.state = {
    ...f.state,
    workers: f.state.workers.map((worker) =>
      worker.role === 'TESTER'
        ? { ...worker, worktree: { ...ref, headCommit: 'c'.repeat(40) } }
        : worker,
    ),
  };
  await expect(f.service.register(f.scope)).rejects.toThrow('local_git_review_source_invalid');
  expect(f.commits).toBe(0);
});

it('rejects a prepared registry transaction before another binding write', async () => {
  const f = setup();
  f.registry.operations.push({ actionId: 'unclosed', receiptId: 'old', stage: 'prepared' });
  await expect(f.service.register(f.scope)).rejects.toThrow('review_binding_recovery_required');
  expect(f.commits).toBe(0);
});

it('recovers only the same prepared REVIEWER binding, then reproves its candidate', async () => {
  const f = setup();
  const actionId = 'review-binding:review';
  const receiptId = `binding:${actionId}`;
  const inputHash = 'a'.repeat(64);
  const nextLocalExecution = structuredClone(f.state.localExecution);
  if (!nextLocalExecution) throw Error('missing local state');
  nextLocalExecution.bindings.push({
    workerId: f.scope.workerId,
    workspaceId: 'validation',
    receiptId,
  });
  nextLocalExecution.receipts.push({
    receiptId,
    actionId,
    inputHash,
    registryRevision: f.registry.revision + 1,
  });
  f.registry.operations.push({
    actionId,
    inputHash,
    receiptId,
    projectId: f.scope.projectId,
    taskId: f.scope.taskId,
    preparedRevision: f.registry.revision + 1,
    stage: 'prepared',
    previousLocalHash: 'c'.repeat(64),
    nextLocalExecution,
    sourceMessageId: 'leader-grant',
  });
  await expect(f.service.register(f.scope)).resolves.toEqual(workspace);
  expect(f.recoveries).toBe(1);
  expect(f.commits).toBe(0);
  expect(f.proofs).toBe(1);
  await expect(f.service.register(f.scope)).resolves.toEqual(workspace);
  expect(f.recoveries).toBe(1);
});
