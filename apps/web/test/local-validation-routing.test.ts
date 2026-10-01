// Service doubles isolate the trusted callback's mode selection. Native Git
// commands and receipt replay are exercised in their separate integration tests.
import { createInitialAppState, type Mutation } from '@agora/core-domain';
import type { WorkspaceWorkerSession } from '@agora/runtime-sandbox';
import { expect, it } from 'vitest';
import { completeLocalTesterAssignment } from '../src/server/local-validation-routing';

const session = { workspace: { rootId: 'root', grantId: 'grant' } } as WorkspaceWorkerSession;
const receipt = { op: 'set', field: 'testResults', value: { passed: true } } as Mutation;
const initial = createInitialAppState('task', 'goal', 'project');
const execution = {
  version: 1 as const,
  planId: 'plan',
  initialBase: { branch: 'base', commit: 'a'.repeat(40) },
};

it('routes a Git wave only to the Git receipt service', async () => {
  const calls: string[] = [];
  const state = {
    ...initial,
    parallelExecution: execution,
    localExecution: { git: {} },
  } as unknown as typeof initial;
  const result = await completeLocalTesterAssignment(state, 'worker', session, {
    direct: {
      complete: async () => {
        calls.push('direct');
        return [];
      },
    },
    git: {
      complete: async () => {
        calls.push('git');
        return [receipt];
      },
    },
  });
  expect(result).toEqual([receipt]);
  expect(calls).toEqual(['git']);
});

it('fails closed when a Git task has no Git receipt service', async () => {
  const state = {
    ...initial,
    parallelExecution: execution,
    localExecution: { git: {} },
  } as unknown as typeof initial;
  await expect(
    completeLocalTesterAssignment(state, 'worker', session, {
      direct: {
        complete: async () => {
          throw Error('direct must not run');
        },
      },
    }),
  ).rejects.toThrow('local_git_wave_validation_unavailable');
});

it('keeps a direct/files validation on its own receipt service', async () => {
  const state = {
    ...initial,
    localExecution: {
      workspaces: [{ workspaceId: 'source', rootId: 'root', grantId: 'grant', purpose: 'coding' }],
    },
  } as unknown as typeof initial;
  const result = await completeLocalTesterAssignment(state, 'worker', session, {
    direct: {
      complete: async (_state, _workerId, workspaceId) => {
        expect(workspaceId).toBe('source');
        return [receipt];
      },
    },
    git: {
      complete: async () => {
        throw Error('git must not run');
      },
    },
  });
  expect(result).toEqual([receipt]);
});
