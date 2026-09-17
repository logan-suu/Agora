// Admission-only port doubles: no execution, provider or filesystem capability
// is exercised here. Native and Harness chains have separate integration tests.
import { createInitialAppState } from '@agora/core-domain';
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
