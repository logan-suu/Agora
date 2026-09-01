import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  type RoleSpec,
  type TestResults,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import {
  DEFAULT_ROSTER,
  SIX_ROLE_HANDOFF,
  SIX_ROLE_TOOL_SURFACE,
  SIX_ROLE_TURN_MUTATION_READERS,
} from '@agora/roles-definitions';
import {
  type Executor,
  HarnessExecutor,
  type HarnessExecutorOptions,
} from '@agora/runtime-executor';
import { createSandbox, type SandboxConfig } from '@agora/runtime-sandbox';
import { createToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { initializeRegisteredWorktree, WorktreeGitService } from '@agora/tools-git';

import type { TaskCompositionFactory } from './task-orchestration-runtime';

const TEST_RESULTS_FILE = 'test-results.json';

export interface WebTaskCompositionOptions {
  sandboxConfig?: SandboxConfig;
  executorOptions?: Pick<HarnessExecutorOptions, 'adapter' | 'provider' | 'deepseek'>;
}

/** Production D10 composition: Docker + MCP tools + Harness + six-role roster. */
export function createWebTaskCompositionFactory(
  options: WebTaskCompositionOptions = {},
): TaskCompositionFactory {
  return async ({ scope, goal, transition }) => {
    const sandbox = createSandbox(options.sandboxConfig ?? { kind: 'docker' });
    const worktree = await sandbox.createWorktree(scope.taskId, 'shared');
    const registry = new WorktreeRegistry();
    await initializeRegisteredWorktree(registry, worktree.path);
    const gitService = new WorktreeGitService(registry);
    const catalog = await createToolCatalog({
      registry,
      gitService,
      sandbox,
      getWorktree: async () => worktree,
    });
    const executors: HarnessExecutor[] = [];
    const readTestResults = async (): Promise<TestResults | undefined> => {
      try {
        const parsed = JSON.parse(
          await sandbox.read(worktree, TEST_RESULTS_FILE),
        ) as Partial<TestResults>;
        if (typeof parsed.passed !== 'boolean') return undefined;
        return {
          passed: parsed.passed,
          total: typeof parsed.total === 'number' ? parsed.total : 0,
          failed: typeof parsed.failed === 'number' ? parsed.failed : 0,
          failures: Array.isArray(parsed.failures)
            ? (parsed.failures as TestResults['failures'])
            : [],
        };
      } catch {
        return undefined;
      }
    };
    const executorOptions = options.executorOptions ?? { deepseek: true };
    const workerRuntime = new WorkerRuntime({
      roster: DEFAULT_ROSTER,
      transition,
      buildExecutor: (spec): Executor => {
        const resolved = catalog.resolve(
          spec.tools.filter((tool) => SIX_ROLE_TOOL_SURFACE.includes(tool)),
        );
        const handoff = SIX_ROLE_HANDOFF[spec.role] ?? '';
        const executorSpec: RoleSpec = {
          ...spec,
          ...(handoff === '' ? {} : { systemPrompt: spec.systemPrompt + handoff }),
        };
        const turnMutations = SIX_ROLE_TURN_MUTATION_READERS[spec.role];
        const executor = new HarnessExecutor(executorSpec, {
          ...executorOptions,
          tools: catalog.all(),
          allowTools: resolved.allowNames,
          ...(spec.role === 'TESTER' ? { readTestResults } : {}),
          ...(turnMutations === undefined
            ? {}
            : { readTurnMutations: ({ text }) => turnMutations(text) }),
        });
        executors.push(executor);
        return executor;
      },
    });
    const subtaskId = `${scope.taskId}-sub-0`;
    const initialState = applyMutations(
      createInitialAppState(scope.taskId, goal, scope.projectId),
      [
        mergeByIdMutation('subtasks', subtaskId, {
          title: goal,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'todo',
          worktree: worktree.path,
        }),
      ],
    );
    return {
      initialState,
      workerRuntime,
      roster: DEFAULT_ROSTER,
      artifactPath: worktree.path,
      dispose: async () => {
        const errors: unknown[] = [];
        for (const executor of executors) {
          await executor.dispose().catch((error: unknown) => errors.push(error));
        }
        await catalog.dispose().catch((error: unknown) => errors.push(error));
        await gitService.dispose().catch((error: unknown) => errors.push(error));
        await sandbox.teardown(scope.taskId).catch((error: unknown) => errors.push(error));
        if (errors.length > 0) {
          throw new Error(`task composition dispose failed: ${errors.map(String).join('; ')}`);
        }
      },
    };
  };
}
