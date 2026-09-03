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
  inspectHarnessSafePoint,
  project,
} from '@agora/runtime-executor';
import {
  createSandbox,
  isRecoverableSandboxManager,
  type SandboxConfig,
  type SandboxManager,
  type Worktree,
} from '@agora/runtime-sandbox';
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
    resume,
  }) => {
    const sandbox = options.sandbox ?? createSandbox(options.sandboxConfig ?? { kind: 'docker' });
    const dataRoot = resolve(options.dataRoot ?? join(process.cwd(), '.data'));
    let worktree: Worktree;
    if (resume === undefined) {
      worktree = await sandbox.createWorktree(scope.taskId, 'shared');
    } else {
      const paths = [
        ...new Set(
          resume.state.subtasks
            .map((subtask) => subtask.worktree)
            .filter((path): path is string => path !== undefined),
        ),
      ];
      if (paths.length !== 1) {
        throw new Error('humanGate resume requires exactly one persisted task worktree');
      }
      if (!isRecoverableSandboxManager(sandbox)) {
        throw new Error('configured SandboxManager does not support D4 resume');
      }
      worktree = { path: paths[0] as string, branch: `${scope.taskId}-shared` };
      await sandbox.resume(scope.taskId, [{ role: 'shared', worktree }]);
    }
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
      if (resume !== undefined && isRecoverableSandboxManager(sandbox)) {
        await sandbox.suspend(scope.taskId).catch(() => undefined);
      } else {
        await sandbox.teardown(scope.taskId).catch(() => undefined);
      }
      throw error;
    }
    const activeCatalog = catalog;
    const activeGitService = gitService;
    const executors: HarnessExecutor[] = [];
    let latestExecutor: HarnessExecutor | undefined;
    let latestRole: string | undefined;
    let resourcesReleased = false;
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
    const sessionRoot = join(
      dataRoot,
      'projects',
      scope.projectId,
      'tasks',
      scope.taskId,
      'harness-sessions',
    );
    const createExecutor = (spec: RoleSpec, resumeSessionId?: string): HarnessExecutor => {
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
        sessionPersistence: {
          root: sessionRoot,
          cwd: worktree.path,
          projectId: scope.projectId,
          taskId: scope.taskId,
          ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        },
        ...(spec.role === 'TESTER' ? { readTestResults } : {}),
        ...(turnMutations === undefined
          ? {}
          : { readTurnMutations: ({ text }) => turnMutations(text) }),
      });
      executors.push(executor);
      latestExecutor = executor;
      latestRole = spec.role;
      return executor;
    };
    let restored: { role: string; executor: HarnessExecutor } | undefined;
    if (resume !== undefined && resume.receipt.safePointRefs.length > 0) {
      if (resume.receipt.safePointRefs.length !== 1) {
        throw new Error('Phase 8 sequential resume expects exactly one Harness safe point');
      }
      const ref = resume.receipt.safePointRefs[0] as string;
      const identity = inspectHarnessSafePoint(ref);
      if (
        identity.projectId !== scope.projectId ||
        identity.taskId !== scope.taskId ||
        identity.cwd !== worktree.path
      ) {
        throw new Error('persisted humanGate safe point does not match the task composition');
      }
      const roster = (await loadRoster?.()) ?? DEFAULT_ROSTER;
      const spec = roster.find((entry) => entry.role === identity.role);
      if (spec === undefined) throw new Error(`safe point role "${identity.role}" is not enabled`);
      const executor = createExecutor(spec, resume.receipt.resumeSessionId);
      await executor.loadSafePoint(ref);
      executor.injectInbox(
        project(
          resume.state,
          spec.role,
          roster,
          await buildChannelContext(resume.state, spec.role),
        ),
      );
      restored = { role: spec.role, executor };
    }
    const workerRuntime = new WorkerRuntime({
      roster: DEFAULT_ROSTER,
      ...(loadRoster === undefined ? {} : { loadRoster }),
      transition,
      ...(transitionStep === undefined ? {} : { transitionStep }),
      handleOutput,
      buildChannelContext,
      buildExecutor: (spec): Executor => {
        if (restored?.role === spec.role) {
          const executor = restored.executor;
          restored = undefined;
          latestExecutor = executor;
          latestRole = spec.role;
          return executor;
        }
        return createExecutor(spec);
      },
    });
    const subtaskId = `${scope.taskId}-sub-0`;
    const initialState =
      resume?.state ??
      applyMutations(createInitialAppState(scope.taskId, goal, scope.projectId), [
        mergeByIdMutation('subtasks', subtaskId, {
          title: goal,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'todo',
          worktree: worktree.path,
        }),
      ]);
    const releaseRuntimeResources = async (terminal: boolean): Promise<void> => {
      if (resourcesReleased) return;
      resourcesReleased = true;
      const errors: unknown[] = [];
      for (const executor of executors) {
        await executor.dispose().catch((error: unknown) => errors.push(error));
      }
      await activeCatalog.dispose().catch((error: unknown) => errors.push(error));
      await activeGitService.dispose().catch((error: unknown) => errors.push(error));
      const release = terminal
        ? sandbox.teardown(scope.taskId)
        : isRecoverableSandboxManager(sandbox)
          ? sandbox.suspend(scope.taskId)
          : Promise.reject(new Error('configured SandboxManager does not support D4 suspend'));
      await release.catch((error: unknown) => errors.push(error));
      if (errors.length > 0) {
        throw new Error(
          `task composition ${terminal ? 'dispose' : 'suspend'} failed: ${errors.map(String).join('; ')}`,
        );
      }
    };
    return {
      initialState,
      workerRuntime,
      roster: DEFAULT_ROSTER,
      ...(loadRoster === undefined ? {} : { loadRoster }),
      artifactPath: worktree.path,
      saveSafePoints: async () => {
        if (latestExecutor === undefined || latestRole === undefined) return [];
        return [await latestExecutor.saveSafePoint()];
      },
      suspend: async () => {
        workerRuntime.paused = true;
        await releaseRuntimeResources(false);
      },
      archiveArtifact: async () => {
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
      dispose: () => releaseRuntimeResources(true),
    };
  };
}
