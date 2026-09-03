import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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
import { createSandbox, type SandboxConfig, type SandboxManager } from '@agora/runtime-sandbox';
import { createToolCatalog, type ToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { initializeRegisteredWorktree, WorktreeGitService } from '@agora/tools-git';

import type { TaskCompositionFactory } from './task-orchestration-runtime';

const TEST_RESULTS_FILE = 'test-results.json';

export interface WebTaskCompositionOptions {
  sandboxConfig?: SandboxConfig;
  sandbox?: SandboxManager;
  dataRoot?: string;
  executorOptions?: Pick<HarnessExecutorOptions, 'adapter' | 'provider' | 'deepseek'>;
}

/** Production D10 composition: Docker + MCP tools + Harness + six-role roster. */
export function createWebTaskCompositionFactory(
  options: WebTaskCompositionOptions = {},
): TaskCompositionFactory {
  return async ({
    scope,
    goal,
    transition,
    transitionStep,
    handleOutput,
    buildChannelContext,
    loadRoster,
  }) => {
    const sandbox = options.sandbox ?? createSandbox(options.sandboxConfig ?? { kind: 'docker' });
    const worktree = await sandbox.createWorktree(scope.taskId, 'shared');
    const registry = new WorktreeRegistry();
    let gitService: WorktreeGitService | undefined;
    let catalog: ToolCatalog | undefined;
    try {
      await initializeRegisteredWorktree(registry, worktree.path);
      gitService = new WorktreeGitService(registry);
      catalog = await createToolCatalog({
        registry,
        gitService,
        sandbox,
        getWorktree: async () => worktree,
      });
    } catch (error) {
      await catalog?.dispose().catch(() => undefined);
      await gitService?.dispose().catch(() => undefined);
      await sandbox.teardown(scope.taskId).catch(() => undefined);
      throw error;
    }
    const activeCatalog = catalog;
    const activeGitService = gitService;
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
      ...(loadRoster === undefined ? {} : { loadRoster }),
      transition,
      ...(transitionStep === undefined ? {} : { transitionStep }),
      handleOutput,
      buildChannelContext,
      buildExecutor: (spec): Executor => {
        const resolved = activeCatalog.resolve(
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
          tools: activeCatalog.all(),
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
      ...(loadRoster === undefined ? {} : { loadRoster }),
      artifactPath: worktree.path,
      archiveArtifact: async () => {
        const dataRoot = resolve(options.dataRoot ?? join(process.cwd(), '.data'));
        const destination = join(
          dataRoot,
          'projects',
          scope.projectId,
          'tasks',
          scope.taskId,
          'artifacts',
          'worktree',
        );
        try {
          await access(destination);
          return destination;
        } catch {
          // The first terminalization creates the immutable Phase 5 artifact snapshot.
        }
        await mkdir(dirname(destination), { recursive: true });
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          await cp(worktree.path, temporary, { recursive: true });
          await rename(temporary, destination);
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          throw error;
        }
        return destination;
      },
      dispose: async () => {
        const errors: unknown[] = [];
        for (const executor of executors) {
          await executor.dispose().catch((error: unknown) => errors.push(error));
        }
        await activeCatalog.dispose().catch((error: unknown) => errors.push(error));
        await activeGitService.dispose().catch((error: unknown) => errors.push(error));
        await sandbox.teardown(scope.taskId).catch((error: unknown) => errors.push(error));
        if (errors.length > 0) {
          throw new Error(`task composition dispose failed: ${errors.map(String).join('; ')}`);
        }
      },
    };
  };
}
