// Admission-only port doubles: no execution, provider or filesystem capability
// is exercised here. Native and Harness chains have separate integration tests.
import {
  type AppState,
  createInitialAppState,
  type WaveValidationReceipt,
} from '@agora/core-domain';
import { expect, it } from 'vitest';
import type { TaskCompositionFactory } from '../src/server/task-orchestration-runtime';

it('rejects unbound tasks before preparing any local runtime capability', async () => {
  const { createLocalTaskCompositionFactory } = await import(
    '../src/server/local-task-composition'
  );
  const state = createInitialAppState('task', 'fixed task', 'project');
  let prepared = false;
  const factory = createLocalTaskCompositionFactory({
    loadState: async () => state,
    bindCompletionVerifier: () => {},
    prepare: async () => {
      prepared = true;
      throw Error('unexpected preparation');
    },
  });
  const input: Parameters<TaskCompositionFactory>[0] = {
    scope: { projectId: 'project', taskId: 'task' },
    goal: state.goal,
    loadState: async () => state,
    transition: async () => {
      throw Error('unexpected transition');
    },
    handleOutput: async () => {},
    buildChannelContext: async () => [],
  };
  await expect(factory(input)).rejects.toThrow('local_task_authorization_required');
  expect(prepared).toBe(false);
});

it('routes an approved local binding before allocating any legacy sandbox', async () => {
  const { createWebTaskCompositionFactory } = await import('../src/server/task-composition');
  const state = {
    ...createInitialAppState('task', 'fixed task', 'project'),
    localExecution: {
      schemaVersion: 'local-execution-v1' as const,
      rootIds: ['root'],
      workspaces: [],
      bindings: [],
      receipts: [],
    },
  };
  const input: Parameters<TaskCompositionFactory>[0] = {
    scope: { projectId: 'project', taskId: 'task' },
    goal: state.goal,
    loadState: async () => state,
    transition: async () => {
      throw Error('unexpected mutation');
    },
    handleOutput: async () => {},
    buildChannelContext: async () => [],
  };
  await expect(createWebTaskCompositionFactory()(input)).rejects.toThrow(
    'local_task_composition_unavailable',
  );
  let invoked = 0;
  await expect(
    createWebTaskCompositionFactory({
      localFactory: async (received) => {
        expect(received).toBe(input);
        invoked++;
        throw Error('local factory sentinel');
      },
    })(input),
  ).rejects.toThrow('local factory sentinel');
  expect(invoked).toBe(1);
});

it('fails closed before model setup when the startup boundary probe fails', async () => {
  const { createLocalTaskCompositionFactory } = await import(
    '../src/server/local-task-composition'
  );
  const state = {
    ...createInitialAppState('task', 'fixed task', 'project'),
    localExecution: {
      schemaVersion: 'local-execution-v1' as const,
      rootIds: ['root'],
      workspaces: [],
      bindings: [],
      receipts: [],
    },
  };
  let freezes = 0;
  const factory = createLocalTaskCompositionFactory({
    loadState: async () => state,
    bindCompletionVerifier: () => {},
    prepare: async () => ({
      local: {
        ensureReady: async () => {
          throw Error('sandbox_unavailable');
        },
      } as unknown as import('../../../packages/runtime/sandbox/src/local-workspace-sessions').LocalWorkspaceSessions,
      cwd: '/fixed-project',
      sessionRoot: '/fixed-sessions',
    }),
    modelSettings: {
      freeze: async () => {
        freezes++;
        throw Error('model setup must not run');
      },
    } as unknown as NonNullable<
      Parameters<typeof createLocalTaskCompositionFactory>[0]['modelSettings']
    >,
  });
  await expect(
    factory({
      scope: { projectId: 'project', taskId: 'task' },
      goal: state.goal,
      loadState: async () => state,
      transition: async () => {
        throw Error('unexpected state change');
      },
      handleOutput: async () => {},
      buildChannelContext: async () => [],
    }),
  ).rejects.toThrow('sandbox_unavailable');
  expect(freezes).toBe(0);
});

it('refuses to verify Git completion through the direct/files verifier', async () => {
  const { createLocalTaskCompositionFactory } = await import(
    '../src/server/local-task-composition'
  );
  const state = {
    ...createInitialAppState('task', 'fixed task', 'project'),
    localExecution: {
      schemaVersion: 'local-execution-v1' as const,
      rootIds: ['root'],
      workspaces: [],
      bindings: [],
      receipts: [],
    },
    parallelExecution: {
      version: 1 as const,
      planId: 'plan',
      initialBase: { branch: 'base', commit: 'a'.repeat(40) },
    },
  } as AppState;
  let verify:
    | ((scope: { projectId: string; taskId: string }, state: AppState) => Promise<void>)
    | undefined;
  let prepared = false;
  createLocalTaskCompositionFactory({
    loadState: async () => state,
    bindCompletionVerifier: (callback) => {
      verify = callback;
    },
    prepare: async () => {
      prepared = true;
      throw Error('direct preparation must not run');
    },
  });
  if (!verify) throw Error('completion verifier was not bound');
  await expect(verify({ projectId: 'project', taskId: 'task' }, state)).rejects.toThrow(
    'local_git_completion_proof_required',
  );
  expect(prepared).toBe(false);
});

it('keeps Git review proof closed when the host has no private evidence root', async () => {
  const { createLocalTaskCompositionFactory } = await import(
    '../src/server/local-task-composition'
  );
  const state = {
    ...createInitialAppState('task', 'fixed task', 'project'),
    localExecution: {
      schemaVersion: 'local-execution-v1',
      rootIds: ['root'],
      workspaces: [],
      bindings: [],
      receipts: [],
      git: { version: 1 as const, initialWorkspaceId: 'workspace', worktrees: [] },
    },
  } as AppState;
  let verify:
    | ((
        state: AppState,
        workerId: string,
      ) => Promise<import('@agora/core-domain').WorkspaceVersionV1>)
    | undefined;
  let versionForAssignment:
    | ((
        admission: import('@agora/runtime-sandbox').WorkspaceWorkerAdmission,
      ) => Promise<import('@agora/core-domain').WorkspaceVersionV1 | undefined>)
    | undefined;
  let verifyAccepted:
    | ((
        state: AppState,
        receipt: WaveValidationReceipt,
        version: import('@agora/core-domain').WorkspaceVersionV1,
      ) => Promise<void>)
    | undefined;
  const factory = createLocalTaskCompositionFactory({
    loadState: async () => state,
    bindCompletionVerifier: () => {},
    prepare: async (_scope, version, proof, accepted) => {
      versionForAssignment = version;
      verify = proof;
      verifyAccepted = accepted;
      return {
        local: {
          ensureReady: async () => {},
          recoverCompletion: async () => {},
        } as unknown as import('../../../packages/runtime/sandbox/src/local-workspace-sessions').LocalWorkspaceSessions,
        cwd: '/fixed-project',
        sessionRoot: '/fixed-sessions',
      };
    },
  });
  await expect(
    factory({
      scope: { projectId: 'project', taskId: 'task' },
      goal: state.goal,
      loadState: async () => state,
      transition: async () => state,
      handleOutput: async () => {},
      buildChannelContext: async () => [],
    }),
  ).rejects.toThrow('local_git_parallel_context_required');
  if (!verify || !versionForAssignment || !verifyAccepted) throw Error('Git proof port missing');
  await expect(verify(state, 'worker:review:0')).rejects.toThrow(
    'local_git_review_proof_unavailable',
  );
  await expect(
    versionForAssignment({
      projectId: 'project',
      taskId: 'task',
      workerId: 'worker:review:0',
      role: 'REVIEWER',
      sessionId: 'session:review',
      assertLease: () => {},
    }),
  ).rejects.toThrow('local_git_review_proof_unavailable');
  await expect(
    verifyAccepted(state, {} as WaveValidationReceipt, {
      kind: 'git',
      commit: 'a'.repeat(40),
      manifestId: `manifest:${'b'.repeat(64)}`,
      manifestHash: 'b'.repeat(64),
    }),
  ).rejects.toThrow('local_git_accepted_proof_unavailable');
});
