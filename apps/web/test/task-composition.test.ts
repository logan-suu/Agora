// Mock reason (R11): the first test injects only the SandboxManager port to force
// deterministic setup failure. Recovery cleanup uses the real LocalTempSandbox.
import { applyMutations, createInitialAppState, mergeByIdMutation } from '@agora/core-domain';
import type {
  IntegrationResult,
  RunResult,
  SandboxManager,
  Worktree,
} from '@agora/runtime-sandbox';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { describe, expect, it } from 'vitest';

import { createWebTaskCompositionFactory } from '../src/server/task-composition';

class MissingWorktreeSandbox implements SandboxManager {
  teardownCalls = 0;

  async createWorktree(taskId: string, role: string): Promise<Worktree> {
    return { branch: `${taskId}-${role}`, path: `/missing/${taskId}` };
  }

  async read(): Promise<string> {
    throw new Error('not used');
  }

  async write(): Promise<void> {
    throw new Error('not used');
  }

  async run(): Promise<RunResult> {
    throw new Error('not used');
  }

  async integrate(): Promise<IntegrationResult> {
    throw new Error('not used');
  }

  async teardown(): Promise<void> {
    this.teardownCalls += 1;
  }
}

class RecordingLocalSandbox extends LocalTempSandbox {
  suspendCalls = 0;

  override async suspend(taskId: string): Promise<void> {
    this.suspendCalls += 1;
    await super.suspend(taskId);
  }
}

describe('createWebTaskCompositionFactory', () => {
  it('tears down an allocated sandbox worktree when setup fails', async () => {
    const sandbox = new MissingWorktreeSandbox();
    const createComposition = createWebTaskCompositionFactory({ sandbox });

    await expect(
      createComposition({
        scope: { projectId: 'project-a', taskId: 'task-a' },
        goal: 'Build safely',
        transition: async (state) => state,
        handleOutput: async () => {},
        buildChannelContext: async () => [],
      }),
    ).rejects.toThrow();
    expect(sandbox.teardownCalls).toBe(1);
  });

  it('releases a resumed sandbox when safe-point restoration fails', async () => {
    const sandbox = new RecordingLocalSandbox();
    const scope = { projectId: 'project-a', taskId: 'task-resume-cleanup' };
    const worktree = await sandbox.createWorktree(scope.taskId, 'shared');
    const state = applyMutations(
      createInitialAppState(scope.taskId, 'Resume safely', scope.projectId),
      [
        mergeByIdMutation('subtasks', 'resume-subtask', {
          title: 'Resume safely',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
          worktree: worktree.path,
        }),
      ],
    );
    const createComposition = createWebTaskCompositionFactory({ sandbox });

    await expect(
      createComposition({
        scope,
        goal: state.goal,
        transition: async (current) => current,
        handleOutput: async () => {},
        buildChannelContext: async () => [],
        resume: {
          state,
          actionId: 'restore-failure',
          receipt: {
            gateId: 'human-gate:restore-failure',
            option: 'retry',
            safePointRefs: ['not-a-safe-point'],
            resumeSessionId: 'human-gate-resume:restore-failure',
          },
        },
      }),
    ).rejects.toThrow(/safe point/i);
    expect(sandbox.suspendCalls).toBe(1);
    await sandbox.teardown(scope.taskId);
  });
});
