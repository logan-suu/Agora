import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  type AppState,
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  type RoleSpec,
  type TestResults,
  type WorktreeRef,
} from '@agora/core-domain';
import {
  GlobalScheduler,
  IntegrationService,
  validateHumanGateWorkerResumes,
  WorkerRuntime,
} from '@agora/core-orchestration';
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
  DockerSandbox,
  isRecoverableSandboxManager,
  type SandboxConfig,
  type SandboxManager,
  WorkspaceAdapter,
  type Worktree,
} from '@agora/runtime-sandbox';
import { createToolCatalog, type ToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import {
  encodeGitIsolationKey,
  initializeRegisteredWorktree,
  WorktreeGitService,
} from '@agora/tools-git';

import type { TaskCompositionFactory } from './task-orchestration-runtime';

const TEST_RESULTS_FILE = 'test-results.json';

export interface WebTaskCompositionOptions {
  sandboxConfig?: SandboxConfig;
  sandbox?: SandboxManager;
  dataRoot?: string;
  executorOptions?: Pick<HarnessExecutorOptions, 'adapter' | 'provider' | 'deepseek'>;
  scheduler?: GlobalScheduler;
}

/** Production D10 composition: Docker + MCP tools + Harness + six-role roster. */
export function createWebTaskCompositionFactory(
  options: WebTaskCompositionOptions = {},
): TaskCompositionFactory {
  const scheduler = options.scheduler ?? new GlobalScheduler();
  return async ({
    scope,
    goal,
    loadState,
    transition,
    transitionStep,
    handleOutput,
    buildChannelContext,
    loadRoster,
    resume,
  }) => {
    const dataRoot = resolve(options.dataRoot ?? join(process.cwd(), '.data'));
    const taskRoot = join(dataRoot, 'projects', scope.projectId, 'tasks', scope.taskId);
    await mkdir(taskRoot, { recursive: true });
    const registry = new WorktreeRegistry();
    const sandboxConfig = options.sandboxConfig ?? { kind: 'docker' as const };
    const useWorkspaceAdapter = options.sandbox === undefined && sandboxConfig.kind === 'docker';
    let gitService: WorktreeGitService;
    let workspace: WorkspaceAdapter | undefined;
    let legacyWorktree: Worktree | undefined;
    let legacyWorktreeRef: WorktreeRef | undefined;
    let sandbox: SandboxManager;
    if (useWorkspaceAdapter) {
      const { kind: _kind, ...dockerOptions } = sandboxConfig;
      const execution = new DockerSandbox({
        ...dockerOptions,
        baseDir: dockerOptions.baseDir ?? dataRoot,
      });
      gitService = new WorktreeGitService(
        registry,
        join(taskRoot, 'repository'),
        join(taskRoot, 'worktrees'),
      );
      workspace = new WorkspaceAdapter({
        projectId: scope.projectId,
        taskId: scope.taskId,
        taskRoot,
        git: gitService,
        execution,
        encodeIsolationKey: encodeGitIsolationKey,
      });
      sandbox = workspace;
    } else {
      sandbox = options.sandbox ?? createSandbox(sandboxConfig);
      if (resume === undefined) {
        legacyWorktree = await sandbox.createWorktree(scope.taskId, 'shared');
      } else {
        const persistedWorktrees = resume.state.subtasks
          .map((subtask) => subtask.worktree)
          .filter((value): value is NonNullable<typeof value> => value !== undefined);
        const paths = [
          ...new Set(
            persistedWorktrees.map((value) => (typeof value === 'string' ? value : value.path)),
          ),
        ];
        if (paths.length !== 1) {
          throw new Error('legacy humanGate resume requires exactly one persisted task worktree');
        }
        if (!isRecoverableSandboxManager(sandbox)) {
          throw new Error('configured SandboxManager does not support D4 resume');
        }
        const firstPersisted = persistedWorktrees[0];
        legacyWorktree = {
          path: paths[0] as string,
          branch:
            typeof firstPersisted === 'object' ? firstPersisted.branch : `${scope.taskId}-shared`,
        };
        await sandbox.resume(scope.taskId, [{ role: 'shared', worktree: legacyWorktree }]);
      }
      gitService = new WorktreeGitService(registry);
      try {
        await initializeRegisteredWorktree(registry, (legacyWorktree as Worktree).path);
        const legacyHead = await gitService.headOf((legacyWorktree as Worktree).path);
        legacyWorktreeRef = {
          path: (legacyWorktree as Worktree).path,
          branch: await gitService.branchOf((legacyWorktree as Worktree).path),
          baseCommit: legacyHead,
          headCommit: legacyHead,
        };
      } catch (error) {
        await gitService.dispose().catch(() => undefined);
        await sandbox.teardown(scope.taskId).catch(() => undefined);
        throw error;
      }
    }
    const activeGitService = gitService;
    const catalogs = new Map<string, ToolCatalog>();
    const worktrees = new Map<string, WorktreeRef>();
    // A run can fail before its first worker is admitted. In that case the
    // canonical repository is still the smallest valid artifact source; using
    // taskRoot would recursively copy `artifacts/` into itself.
    const resumedArtifactPath =
      resume?.state.integration?.integrationWorktree.path ??
      [...(resume?.state.subtasks ?? [])].reverse().find((entry) => entry.worktree !== undefined)
        ?.worktree;
    let artifactPath =
      legacyWorktree?.path ??
      (typeof resumedArtifactPath === 'string' ? resumedArtifactPath : resumedArtifactPath?.path) ??
      join(taskRoot, 'repository');
    const executors: HarnessExecutor[] = [];
    let latestExecutor: HarnessExecutor | undefined;
    let latestRole: string | undefined;
    let resourcesReleased = false;
    const readTestResults = async (worktree: Worktree): Promise<TestResults | undefined> => {
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
    const ensureCatalog = async (workerId: string, worktree: Worktree): Promise<ToolCatalog> => {
      const existing = catalogs.get(workerId);
      if (existing !== undefined) return existing;
      const catalog = await createToolCatalog({
        registry,
        gitService: activeGitService,
        sandbox,
        getWorktree: async () => worktree,
      });
      catalogs.set(workerId, catalog);
      return catalog;
    };
    if (legacyWorktree !== undefined) {
      try {
        await ensureCatalog('legacy:shared', legacyWorktree);
      } catch (error) {
        await activeGitService.dispose().catch(() => undefined);
        await sandbox.teardown(scope.taskId).catch(() => undefined);
        throw error;
      }
    }
    const createExecutor = (
      spec: RoleSpec,
      workerId: string,
      worktree: Worktree,
      resumeSessionId?: string,
    ): HarnessExecutor => {
      const catalog = catalogs.get(workerId);
      if (catalog === undefined)
        throw new Error(`tool catalog is unavailable for worker "${workerId}"`);
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
        sessionPersistence: {
          root: sessionRoot,
          cwd: worktree.path,
          projectId: scope.projectId,
          taskId: scope.taskId,
          ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        },
        ...(spec.role === 'TESTER' ? { readTestResults: () => readTestResults(worktree) } : {}),
        ...(turnMutations === undefined
          ? {}
          : { readTurnMutations: ({ text }) => turnMutations(text) }),
      });
      executors.push(executor);
      latestExecutor = executor;
      latestRole = spec.role;
      return executor;
    };
    const releaseRuntimeResources = async (terminal: boolean): Promise<void> => {
      if (resourcesReleased) return;
      const errors: unknown[] = [];
      for (const executor of executors) {
        await executor.dispose().catch((error: unknown) => errors.push(error));
      }
      for (const catalog of catalogs.values()) {
        await catalog.dispose().catch((error: unknown) => errors.push(error));
      }
      if (workspace === undefined) {
        await activeGitService.dispose().catch((error: unknown) => errors.push(error));
      }
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
      resourcesReleased = true;
    };
    const restoredExecutors = new Map<string, { role: string; executor: HarnessExecutor }>();
    let legacyResumeRole: string | undefined;
    let legacyResumeWorkerId: string | undefined;
    try {
      if (resume !== undefined && workspace !== undefined) {
        const workerBindings = resume.state.workers.flatMap((worker) => {
          if (worker.worktree === undefined) return [];
          if (typeof worker.worktree === 'string') {
            throw new Error(`worker "${worker.workerId}" has an unmigrated legacy worktree`);
          }
          return [{ isolationKey: worker.workerId, worktree: worker.worktree }];
        });
        const bindings = [...workerBindings];
        if (resume.state.integration !== undefined) {
          bindings.unshift({
            isolationKey: `integration:${resume.state.integration.integrationId}`,
            worktree: resume.state.integration.integrationWorktree,
          });
        }
        if (bindings.length > 0) {
          // Several sequential observer workers may reference the same produced
          // or integrated worktree. Recover the physical path once under its
          // owning isolation key, then create per-worker tool catalogs against
          // that already-bound path.
          const seenPaths = new Set<string>();
          const physicalBindings = bindings.filter((binding) => {
            if (seenPaths.has(binding.worktree.path)) return false;
            seenPaths.add(binding.worktree.path);
            return true;
          });
          await workspace.recoverWorktrees(physicalBindings);
          for (const binding of bindings) {
            worktrees.set(binding.isolationKey, binding.worktree);
            await ensureCatalog(binding.isolationKey, binding.worktree);
          }
        }
      }
      if (
        resume !== undefined &&
        (resume.receipt.safePointRefs.length > 0 || resume.receipt.workerResumes !== undefined)
      ) {
        const roster = (await loadRoster?.()) ?? DEFAULT_ROSTER;
        const workerResumes = resume.receipt.workerResumes;
        if (workerResumes === undefined) {
          if (resume.receipt.safePointRefs.length !== 1) {
            throw new Error('Phase 8 sequential resume expects exactly one Harness safe point');
          }
          const ref = resume.receipt.safePointRefs[0] as string;
          const fallback = legacyWorktree;
          if (fallback === undefined) {
            throw new Error('legacy resume receipt cannot target a Phase 9 workspace');
          }
          const identity = assertSafePointComposition(ref, scope, fallback.path);
          const spec = roster.find((entry) => entry.role === identity.role);
          if (spec === undefined)
            throw new Error(`safe point role "${identity.role}" is not enabled`);
          const executor = createExecutor(
            spec,
            'legacy:shared',
            fallback,
            resume.receipt.resumeSessionId,
          );
          await executor.loadSafePoint(ref);
          executor.injectInbox(
            project(
              resume.state,
              spec.role,
              roster,
              await buildChannelContext(resume.state, spec.role),
            ),
          );
          legacyResumeRole = spec.role;
          restoredExecutors.set(`legacy-role:${spec.role}`, { role: spec.role, executor });
        } else {
          validateHumanGateWorkerResumes(
            resume.state,
            resume.actionId,
            resume.receipt.safePointRefs,
            workerResumes,
          );
          for (const plan of workerResumes) {
            const worker = resume.state.workers.find((entry) => entry.workerId === plan.workerId);
            if (worker === undefined) {
              throw new Error(`resume worker "${plan.workerId}" is missing from task state`);
            }
            const workerWorktree: Worktree =
              workspace === undefined
                ? (legacyWorktree as Worktree)
                : typeof worker.worktree === 'object'
                  ? worker.worktree
                  : (() => {
                      throw new Error(
                        `resume worker "${plan.workerId}" has no structured worktree`,
                      );
                    })();
            const identity = assertSafePointComposition(
              plan.sourceSafePointRef,
              scope,
              workerWorktree.path,
            );
            if (identity.role !== worker.role) {
              throw new Error(
                `resume worker "${plan.workerId}" role conflicts with its safe point`,
              );
            }
            const spec = roster.find((entry) => entry.role === worker.role);
            if (spec === undefined) {
              throw new Error(`safe point role "${identity.role}" is not enabled`);
            }
            const executor = createExecutor(
              spec,
              workspace === undefined ? 'legacy:shared' : plan.workerId,
              workerWorktree,
              plan.resumeSessionId,
            );
            await executor.loadSafePoint(plan.sourceSafePointRef);
            executor.injectInbox(
              project(
                resume.state,
                spec.role,
                roster,
                await buildChannelContext(resume.state, spec.role),
              ),
            );
            restoredExecutors.set(plan.workerId, { role: spec.role, executor });
          }
        }
      }
    } catch (error) {
      await releaseRuntimeResources(false).catch(() => undefined);
      throw error;
    }
    const activeWorkspace = workspace;
    const resolveWorkerWorktree = async (
      state: AppState,
      assignment: { workerId: string; role: string; subtaskId?: string },
    ): Promise<WorktreeRef> => {
      if (activeWorkspace === undefined) {
        if (legacyWorktreeRef === undefined)
          throw new Error('legacy worktree reference is missing');
        return legacyWorktreeRef;
      }
      const persisted = state.workers.find(
        (entry) => entry.workerId === assignment.workerId,
      )?.worktree;
      if (typeof persisted === 'string') {
        throw new Error(`worker "${assignment.workerId}" has an unmigrated legacy worktree`);
      }
      let ref = persisted ?? activeWorkspace.worktreeFor(assignment.workerId);
      // TESTER and REVIEWER inspect the already-produced subtask (or the
      // dedicated integration result after the Phase 9 topology is wired).
      // Allocating a fresh branch here would silently hide CODER output.
      if (ref === undefined && assignment.role !== 'CODER') {
        const candidate =
          state.integration?.status === 'done'
            ? state.integration.integrationWorktree
            : (state.subtasks.find((entry) => entry.id === assignment.subtaskId)?.worktree ??
              [...state.subtasks].reverse().find((entry) => entry.worktree !== undefined)
                ?.worktree);
        if (typeof candidate === 'string') {
          throw new Error(`worker "${assignment.workerId}" cannot inherit a legacy worktree`);
        }
        ref = candidate;
      }
      if (ref === undefined) {
        await activeWorkspace.createWorktree(scope.taskId, assignment.workerId);
        ref = activeWorkspace.worktreeFor(assignment.workerId);
      }
      if (ref === undefined)
        throw new Error(`failed to allocate worktree for ${assignment.workerId}`);
      worktrees.set(assignment.workerId, ref);
      artifactPath = ref.path;
      await ensureCatalog(assignment.workerId, ref);
      return ref;
    };
    const workerRuntime = new WorkerRuntime(
      {
        roster: DEFAULT_ROSTER,
        ...(resume?.receipt.workerResumes === undefined
          ? {}
          : {
              resumingWorkers: resume.receipt.workerResumes.map((entry) => ({
                workerId: entry.workerId,
                resumeSessionId: entry.resumeSessionId,
              })),
            }),
        ...(loadRoster === undefined ? {} : { loadRoster }),
        loadState,
        ...(resume === undefined
          ? {}
          : {
              sessionIdForAssignment: (assignment: { workerId: string; role: string }) => {
                const planned = resume.receipt.workerResumes?.find(
                  (entry) => entry.workerId === assignment.workerId,
                );
                if (planned !== undefined) return planned.resumeSessionId;
                if (legacyResumeRole !== assignment.role) return undefined;
                if (legacyResumeWorkerId === undefined) legacyResumeWorkerId = assignment.workerId;
                return legacyResumeWorkerId === assignment.workerId
                  ? resume.receipt.resumeSessionId
                  : undefined;
              },
            }),
        transition,
        ...(transitionStep === undefined ? {} : { transitionStep }),
        handleOutput,
        buildChannelContext,
        resolveWorktree: resolveWorkerWorktree,
        refreshWorktree: async (ref: WorktreeRef) => {
          const refreshed =
            activeWorkspace === undefined
              ? { ...ref, headCommit: await activeGitService.headOf(ref.path) }
              : await activeWorkspace.refreshWorktree(ref);
          const owner = [...worktrees].find(([, value]) => value.branch === ref.branch)?.[0];
          if (owner !== undefined) worktrees.set(owner, refreshed);
          artifactPath = refreshed.path;
          return refreshed;
        },
        buildExecutor: (spec, assignment, assignedWorktree): Executor => {
          const restored =
            restoredExecutors.get(assignment.workerId) ??
            restoredExecutors.get(`legacy-role:${spec.role}`);
          if (restored !== undefined) {
            if (restored.role !== spec.role) {
              throw new Error(
                `restored worker "${assignment.workerId}" role conflicts with its assignment`,
              );
            }
            const executor = restored.executor;
            restoredExecutors.delete(assignment.workerId);
            restoredExecutors.delete(`legacy-role:${spec.role}`);
            latestExecutor = executor;
            latestRole = spec.role;
            return executor;
          }
          const worktree = assignedWorktree ?? legacyWorktree;
          if (worktree === undefined) {
            throw new Error(`worker "${assignment.workerId}" has no execution worktree`);
          }
          return createExecutor(
            spec,
            workspace === undefined ? 'legacy:shared' : assignment.workerId,
            worktree,
          );
        },
      },
      scheduler,
    );
    const subtaskId = `${scope.taskId}-sub-0`;
    const initialState =
      resume?.state ??
      applyMutations(createInitialAppState(scope.taskId, goal, scope.projectId), [
        mergeByIdMutation('subtasks', subtaskId, {
          title: goal,
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'todo',
          ...(legacyWorktreeRef === undefined ? {} : { worktree: legacyWorktreeRef }),
        }),
      ]);
    const integrationService =
      workspace === undefined ? undefined : new IntegrationService(workspace, transition);
    return {
      initialState,
      workerRuntime,
      roster: DEFAULT_ROSTER,
      ...(loadRoster === undefined ? {} : { loadRoster }),
      get artifactPath() {
        return artifactPath;
      },
      ...(integrationService === undefined
        ? {}
        : {
            integrate: async (state: typeof initialState) => {
              const workerIds =
                state.integration?.pendingBranches.map((entry) => entry.workerId) ??
                state.workers
                  .filter((worker) => worker.status === 'done' && worker.subtaskId !== undefined)
                  .map((worker) => worker.workerId);
              const result = await integrationService.integrateWave(state, {
                waveId: state.integration?.waveId ?? `wave-${state.iterationCount}`,
                workerIds,
                baseBranch: await activeGitService.canonicalBranch(),
              });
              if (result.state.integration !== undefined) {
                artifactPath = result.state.integration.integrationWorktree.path;
              }
              return result;
            },
          }),
      saveSafePoints: async () => {
        if (latestExecutor === undefined || latestRole === undefined) return [];
        return [await latestExecutor.saveSafePoint()];
      },
      suspend: async () => {
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
          const state = await loadState();
          const source = state?.integration?.integrationWorktree.path ?? artifactPath;
          await cp(source, temporary, { recursive: true });
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

function assertSafePointComposition(
  ref: string,
  scope: { projectId: string; taskId: string },
  worktreePath: string,
): ReturnType<typeof inspectHarnessSafePoint> {
  const identity = inspectHarnessSafePoint(ref);
  if (
    identity.projectId !== scope.projectId ||
    identity.taskId !== scope.taskId ||
    identity.cwd !== worktreePath
  ) {
    throw new Error('persisted humanGate safe point does not match the task composition');
  }
  return identity;
}
