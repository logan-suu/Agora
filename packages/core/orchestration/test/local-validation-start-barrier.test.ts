// Execution-boundary spies isolate L2 routing order while range dispatch uses
// the real WorkerRuntime. Real native/Git preparation and
// confirmation are exercised by the Phase 12 integration fixture (R11/G5).
import { type AppState, applyMutations, type RoleSpec } from '@agora/core-domain';
import { expect, it, vi } from 'vitest';
import { planIntegrationAcknowledgement } from '../../domain/src/integration-acknowledgement';
import { planIntegrationCompletion } from '../../domain/src/integration-completion';
import { selectIntegrationBranch } from '../../domain/src/integration-selection';
import { fixture } from '../../domain/test/integration-fixture';
import { runOrchestration } from '../src/orchestrator';
import { createInitialValidationDispatchPlan } from '../src/validation-dispatch-plan';
import { WorkerRuntime } from '../src/worker-runtime';

const context = {
  initialBase: { branch: 'initial', commit: 'a'.repeat(40) },
  controlFingerprint: 'f'.repeat(64),
};
const roster: RoleSpec[] = [
  {
    role: 'TESTER',
    executor: 'harness',
    systemPrompt: '',
    tools: [],
    projection: [],
    routeWhen: 'always',
  },
];
const seed = { dispatchId: 'validation-1', dispatchTs: 10, ledgerId: 'ledger-1', ledgerTs: 11 };

function completed() {
  let state = structuredClone(fixture());
  for (const commit of ['c'.repeat(40), 'd'.repeat(40)]) {
    const integration = state.integration;
    if (!integration) throw Error('missing fixture integration');
    state = applyMutations(
      state,
      planIntegrationAcknowledgement(
        state,
        {
          projectId: state.projectId,
          taskId: state.taskId,
          integration,
          selection: selectIntegrationBranch(state, integration.integrationId),
        },
        { previousCommit: integration.integrationWorktree.headCommit as string, commit },
      ),
    );
  }
  const result = applyMutations(state, planIntegrationCompletion(state, state));
  result.complexity = { tier: 2, signals: {} };
  return result;
}

function withLocalGit(state: AppState, registered = false) {
  const copy = structuredClone(state);
  const entries = [
    {
      id: 'initial',
      purpose: 'integration' as const,
      path: '/owned/initial',
      branch: 'initial',
      baseCommit: 'a'.repeat(40),
    },
    {
      id: 'A',
      purpose: 'coding' as const,
      path: '/owned/A',
      branch: 'A',
      baseCommit: 'a'.repeat(40),
    },
    {
      id: 'B',
      purpose: 'coding' as const,
      path: '/owned/B',
      branch: 'B',
      baseCommit: 'a'.repeat(40),
    },
    ...(registered
      ? [
          {
            id: 'validation',
            purpose: 'validation' as const,
            path: '/owned/validation',
            branch: 'validation',
            baseCommit: 'd'.repeat(40),
          },
        ]
      : []),
  ];
  copy.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    workspaces: entries.map((entry) => ({
      schemaVersion: 'workspace-v1' as const,
      projectId: state.projectId,
      taskId: state.taskId,
      workspaceId: entry.id,
      rootId: 'root',
      grantId: 'grant',
      purpose: entry.purpose,
      mode: 'linked-worktree' as const,
      commonDirId: 'common',
      branch: entry.branch,
      baseCommit: entry.baseCommit,
    })),
    bindings: [
      { workerId: 'worker-A', subtaskId: 'A', workspaceId: 'A', receiptId: 'receipt-A' },
      { workerId: 'worker-B', subtaskId: 'B', workspaceId: 'B', receiptId: 'receipt-B' },
      ...(registered
        ? [
            {
              workerId: 'worker:validation-1:0',
              workspaceId: 'validation',
              receiptId: 'receipt-validation',
            },
          ]
        : []),
    ],
    receipts: entries.map((entry) => ({
      receiptId: `receipt-${entry.id}`,
      actionId: `bind-${entry.id}`,
      inputHash: 'f'.repeat(64),
      registryRevision: 1,
    })),
    git: {
      version: 1,
      initialWorkspaceId: 'initial',
      worktrees: entries.map((entry) => ({
        workspaceId: entry.id,
        path: entry.path,
        receiptId: `receipt-${entry.id}`,
      })),
    },
  };
  return copy;
}

function setup() {
  const before = withLocalGit(completed());
  const plan = createInitialValidationDispatchPlan(completed(), seed, context, roster);
  const after = withLocalGit(plan.after, true);
  const calls: string[] = [];
  const runOne = vi.fn(async (state: AppState) => {
    calls.push('worker');
    return { ...state, phase: 'done' as const };
  });
  const runtime = routingRuntime();
  vi.spyOn(runtime, 'runOne').mockImplementation(runOne);
  vi.spyOn(runtime, 'runParallel').mockImplementation(async () => {
    throw Error('unexpected parallel start');
  });
  return { before, after, calls, runOne, runtime };
}

function routingRuntime() {
  return new WorkerRuntime({
    roster,
    buildExecutor: () => {
      throw Error('unexpected executor construction');
    },
  });
}

it('requires trusted preparation before committing a first local Git TESTER dispatch', async () => {
  const f = setup();
  const transition = vi.fn(async () => {
    throw Error('unexpected ordinary commit');
  });
  await expect(
    runOrchestration(f.before, {
      workerRuntime: f.runtime,
      roster,
      parallelContext: async () => context,
      transition,
    }),
  ).rejects.toThrow('local_validation_preparation_required');
  expect(transition).not.toHaveBeenCalled();
  expect(f.runOne).not.toHaveBeenCalled();
});

it('prepares first dispatch and checks the same pending-TESTER barrier before worker runtime', async () => {
  const f = setup();
  const state = await runOrchestration(f.before, {
    workerRuntime: f.runtime,
    roster,
    parallelContext: async () => context,
    prepareLocalValidation: async (before) => {
      f.calls.push('prepare');
      expect(before).toEqual(f.before);
      return f.after;
    },
    admitLocalValidation: async (pending, workerId) => {
      f.calls.push('admit');
      expect(pending).toEqual(f.after);
      expect(workerId).toBe('worker:validation-1:0');
      return pending;
    },
  });
  expect(f.calls).toEqual(['prepare', 'admit', 'worker']);
  expect(state.phase).toBe('done');
});

it('routes recovered pending TESTER through the same barrier and rejects drift', async () => {
  const f = setup();
  await expect(
    runOrchestration(f.after, {
      workerRuntime: f.runtime,
      roster,
      parallelContext: async () => context,
    }),
  ).rejects.toThrow('local_validation_admission_required');
  expect(f.runOne).not.toHaveBeenCalled();

  await expect(
    runOrchestration(f.after, {
      workerRuntime: f.runtime,
      roster,
      parallelContext: async () => context,
      admitLocalValidation: async () => ({ ...f.after, phase: 'review' }),
    }),
  ).rejects.toThrow('local_validation_admission_changed');
  expect(f.runOne).not.toHaveBeenCalled();
});

it('registers missing native coding bindings before handing the batch to WorkerRuntime', async () => {
  const before = withLocalGit(completed());
  before.phase = 'coding';
  before.nextRole = 'CODER';
  delete before.integration;
  for (const w of before.workers) w.status = 'pending';
  const local = before.localExecution;
  if (!local) throw Error('missing local fixture');
  const bindings = local.bindings;
  local.bindings = [];
  const calls: string[] = [];
  const runParallel = vi.fn(async () => {
    calls.push('worker');
    throw Error('worker-boundary');
  });
  const runtime = routingRuntime();
  vi.spyOn(runtime, 'runParallel').mockImplementation(runParallel);
  const coderRoster = [{ ...roster[0], role: 'CODER' }] as RoleSpec[];
  await expect(
    runOrchestration(before, {
      workerRuntime: runtime,
      roster: coderRoster,
      parallelContext: async () => context,
    }),
  ).rejects.toThrow('local_coding_preparation_required');
  expect(runParallel).not.toHaveBeenCalled();
  await expect(
    runOrchestration(before, {
      workerRuntime: runtime,
      roster: coderRoster,
      parallelContext: async () => context,
      prepareLocalCoding: async (current) => {
        calls.push('register');
        return { ...current, localExecution: { ...local, bindings } };
      },
    }),
  ).rejects.toThrow('worker-boundary');
  expect(calls).toEqual(['register', 'worker']);
});
