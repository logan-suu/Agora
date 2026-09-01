// Mock reason (R11): this test injects only the SandboxManager port to force a
// deterministic setup failure before any Docker container or Harness is created.
import type {
  IntegrationResult,
  RunResult,
  SandboxManager,
  Worktree,
} from '@agora/runtime-sandbox';
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
      }),
    ).rejects.toThrow();
    expect(sandbox.teardownCalls).toBe(1);
  });
});
