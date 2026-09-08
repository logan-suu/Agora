import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  type AppState,
  applyMutations,
  createInitialAppState,
  currentReviewDispatch,
  isReviewBinding,
  mergeByIdMutation,
  type RoleSpec,
  type TestResults,
  validationReceipt,
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
  projectForAssignment,
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

import type { ArchivedArtifact, TaskCompositionFactory } from './task-orchestration-runtime';
import {
  assertCoderWorktreeReady,
  controlFingerprint,
  PARALLEL_TESTER_HANDOFF,
  WaveValidationService,
} from './wave-validation';

const TEST_RESULTS_FILE = 'test-results.json';

export interface ArtifactArchivePlanEntry {
  id: string;
  sourcePath: string;
  archivedPath: string;
  relativePath: string;
  worktree?: WorktreeRef;
}

export interface ArtifactArchivePlan {
  destination: string;
  bundled: boolean;
  entries: readonly ArtifactArchivePlanEntry[];
}

interface ArtifactArchiveReceipt {
  version: 1;
  kind: 'agora-artifact-archive';
  path: string;
  worktrees: readonly { sourcePath: string; archivedPath: string }[];
}

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
    const validationService = new WaveValidationService(
      sandbox,
      activeGitService,
      join(taskRoot, 'artifacts'),
    );
    const assignmentStates = new Map<string, AppState>();
    const catalogs = new Map<string, ToolCatalog>();
    const worktrees = new Map<string, WorktreeRef>();
    // A run can fail before its first worker is admitted. In that case the
    // canonical repository is still the smallest valid artifact source; using
    // taskRoot would recursively copy `artifacts/` into itself.
    const resumedArtifactPath =
      resume?.state.integration?.integrationWorktree.path ??
      [...(resume?.state.subtasks ?? [])].reverse().find((entry) => entry.worktree !== undefined)
        ?.worktree;
    const fallbackArtifactPath =
      legacyWorktree?.path ??
      (typeof resumedArtifactPath === 'string' ? resumedArtifactPath : resumedArtifactPath?.path) ??
      join(taskRoot, 'repository');
    let artifactPath = fallbackArtifactPath;
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
      const assignedState = assignmentStates.get(workerId) ?? resume?.state;
      const parallelTester =
        assignedState?.parallelExecution?.activeWave?.validation?.workerId === workerId;
      const logicalTools = parallelTester
        ? [...spec.tools.filter((tool) => tool !== 'test.run'), 'git']
        : spec.tools;
      const resolved = catalog.resolve(
        logicalTools.filter((tool) => SIX_ROLE_TOOL_SURFACE.includes(tool)),
      );
      const handoff = parallelTester
        ? PARALLEL_TESTER_HANDOFF
        : (SIX_ROLE_HANDOFF[spec.role] ?? '');
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
        ...(spec.role === 'TESTER' && assignedState?.parallelExecution === undefined
          ? { readTestResults: () => readTestResults(worktree) }
          : {}),
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
              projectForAssignment(
                resume.state,
                {
                  workerId: plan.workerId,
                  role: spec.role,
                  ...(worker.subtaskId === undefined ? {} : { subtaskId: worker.subtaskId }),
                },
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
      assignmentStates.set(assignment.workerId, state);
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
      if (ref === undefined && state.parallelExecution !== undefined) {
        const wave = state.parallelExecution.activeWave;
        if (assignment.role === 'CODER') {
          if (!wave?.coderWorkerIds.includes(assignment.workerId))
            throw new Error('CODER is not assigned to the current wave');
          ref = await activeWorkspace.createWorkerWorktree(assignment.workerId, wave.base.commit);
        } else if (wave?.validation?.workerId === assignment.workerId) {
          ref = await activeWorkspace.createWorkerWorktree(
            assignment.workerId,
            wave.validation.inputCommit,
          );
        } else if (assignment.role === 'REVIEWER') {
          const binding = currentReviewDispatch(state)?.payload.reviewBinding;
          if (!isReviewBinding(binding)) throw new Error('reviewer has no validation binding');
          const receipt = validationReceipt(state, binding.validationReceiptId);
          await validationService.verifyReceiptHead(state, binding.validationReceiptId);
          ref = receipt.worktree;
        }
      }
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
        completeAssignment: async (state, assignment, worktree) => {
          if (state.parallelExecution !== undefined && assignment.role === 'CODER') {
            if (worktree === undefined)
              throw new Error('CODER must finish with a clean committed worktree');
            await assertCoderWorktreeReady(activeGitService, worktree);
          }
          if (state.parallelExecution?.activeWave?.validation?.workerId === assignment.workerId) {
            if (worktree === undefined)
              throw new Error('validation worker is missing its worktree');
            return validationService.complete(state, assignment.workerId, worktree);
          }
          return [];
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
      applyMutations(
        createInitialAppState(scope.taskId, goal, scope.projectId),
        workspace === undefined
          ? [
              mergeByIdMutation('subtasks', subtaskId, {
                title: goal,
                ownerRole: 'CODER',
                dependsOn: [],
                status: 'todo',
                ...(legacyWorktreeRef === undefined ? {} : { worktree: legacyWorktreeRef }),
              }),
            ]
          : [],
      );
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
      ...(workspace === undefined
        ? {}
        : {
            parallelContext: async (state: AppState) => {
              const execution = state.parallelExecution;
              if (execution?.acceptedReceiptId !== undefined)
                await validationService.verifyReceiptHead(state, execution.acceptedReceiptId);
              const pendingReceipt = execution?.activeWave?.validation?.receiptId;
              if (pendingReceipt !== undefined)
                await validationService.verifyReceiptHead(state, pendingReceipt);
              if (state.phase === 'planning' && execution !== undefined) {
                const dispatch = [...state.messages]
                  .reverse()
                  .find(
                    (message) =>
                      message.fromRole === 'COORDINATOR' &&
                      message.type === 'announce' &&
                      message.payload.nextRole === 'ARCHITECT',
                  );
                if (dispatch?.payload.kind === 'parallel_replan_dispatch') {
                  const sourceId = dispatch.payload.replanSourceReceiptId;
                  if (typeof sourceId !== 'string')
                    throw new Error('architecture replan has no validation source');
                  await validationService.verifyReceiptHead(state, sourceId);
                }
              }
              return {
                initialBase: execution?.initialBase ?? {
                  branch: await activeGitService.canonicalBranch(),
                  commit: await activeGitService.canonicalHead(),
                },
                controlFingerprint: controlFingerprint(state),
              };
            },
          }),
      ...(integrationService === undefined
        ? {}
        : {
            integrate: async (state: typeof initialState) => {
              const workerIds =
                state.parallelExecution?.activeWave?.coderWorkerIds ??
                state.integration?.pendingBranches.map((entry) => entry.workerId) ??
                state.workers
                  .filter((worker) => worker.status === 'done' && worker.subtaskId !== undefined)
                  .map((worker) => worker.workerId);
              const result = await integrationService.integrateWave(state, {
                waveId:
                  state.parallelExecution?.activeWave?.waveId ??
                  state.integration?.waveId ??
                  `wave-${state.iterationCount}`,
                workerIds,
                baseBranch:
                  state.parallelExecution?.activeWave?.base.branch ??
                  (await activeGitService.canonicalBranch()),
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
        const existingReceipt = await readArtifactArchiveReceipt(destination);
        if (existingReceipt !== undefined) return existingReceipt;
        const state = await loadState();
        if (state?.phase === 'done' && state.parallelExecution?.acceptedReceiptId !== undefined)
          await validationService?.verifyReceiptHead(
            state,
            state.parallelExecution.acceptedReceiptId,
          );
        const plan = buildArtifactArchivePlan(state, fallbackArtifactPath, destination);
        return materializeArtifactArchive(plan);
      },
      dispose: () => releaseRuntimeResources(true),
    };
  };
}

export function buildArtifactArchivePlan(
  state: AppState | undefined,
  fallbackPath: string,
  destination: string,
): ArtifactArchivePlan {
  const candidates: Array<{
    id: string;
    sortKey: string;
    sourcePath: string;
    worktree?: WorktreeRef;
  }> = [];
  const add = (
    id: string,
    worktree: WorktreeRef | string | undefined,
    subtaskId = '',
    workerId = '',
  ): void => {
    if (worktree === undefined) return;
    candidates.push({
      id,
      sortKey: `${subtaskId}\u0000${workerId}\u0000${id}`,
      sourcePath: typeof worktree === 'string' ? worktree : worktree.path,
      ...(typeof worktree === 'string' ? {} : { worktree }),
    });
  };

  if (state?.parallelExecution?.acceptedReceiptId !== undefined && state.phase === 'done') {
    const receipt = validationReceipt(state, state.parallelExecution.acceptedReceiptId);
    add(`validation:${receipt.dispatchId}`, receipt.worktree);
  } else if (state?.integration?.status === 'done') {
    add(`integration:${state.integration.integrationId}`, state.integration.integrationWorktree);
  } else {
    if (state?.integration !== undefined) {
      add(`integration:${state.integration.integrationId}`, state.integration.integrationWorktree);
      for (const branch of state.integration.pendingBranches) {
        add(
          `pending:${branch.workerId}:${branch.subtaskId}`,
          branch.worktree,
          branch.subtaskId,
          branch.workerId,
        );
      }
    }
    for (const subtask of state?.subtasks ?? []) {
      const workerId = state?.workers
        .filter((worker) => worker.subtaskId === subtask.id)
        .map((worker) => worker.workerId)
        .sort()[0];
      add(`subtask:${subtask.id}`, subtask.worktree, subtask.id, workerId ?? '');
    }
    for (const worker of state?.workers ?? []) {
      add(
        `worker:${worker.workerId}`,
        worker.worktree,
        worker.subtaskId ?? '\uffff',
        worker.workerId,
      );
    }
  }
  if (candidates.length === 0) add('canonical', fallbackPath);

  const unique = [...candidates]
    .sort((left, right) => compareCodeUnits(left.sortKey, right.sortKey))
    .filter(
      (candidate, index, all) =>
        all.findIndex((entry) => entry.sourcePath === candidate.sourcePath) === index,
    );
  const bundled = unique.length > 1;
  return {
    destination,
    bundled,
    entries: unique.map((entry, index) => {
      const relativePath = bundled
        ? join(
            'worktrees',
            `${String(index).padStart(3, '0')}-${createHash('sha256')
              .update(entry.id)
              .digest('hex')
              .slice(0, 12)}`,
          )
        : '';
      const { sortKey: _sortKey, ...publicEntry } = entry;
      return {
        ...publicEntry,
        relativePath,
        archivedPath: relativePath.length === 0 ? destination : join(destination, relativePath),
      };
    }),
  };
}

export async function materializeArtifactArchive(
  plan: ArtifactArchivePlan,
): Promise<ArchivedArtifact> {
  await mkdir(dirname(plan.destination), { recursive: true });
  const temporary = `${plan.destination}.${randomUUID()}.tmp`;
  const receiptPath = artifactArchiveReceiptPath(plan.destination);
  const receiptTemporary = `${receiptPath}.${randomUUID()}.tmp`;
  const archived = archivedArtifactFromPlan(plan);
  try {
    if (plan.bundled) {
      await mkdir(join(temporary, 'worktrees'), { recursive: true });
      for (const entry of plan.entries) {
        await cp(entry.sourcePath, join(temporary, entry.relativePath), { recursive: true });
      }
      await writeFile(
        join(temporary, 'artifact-manifest.json'),
        `${JSON.stringify(
          {
            version: 1,
            kind: 'parallel-worktree-bundle',
            entries: plan.entries.map((entry) => ({
              id: entry.id,
              path: entry.relativePath,
              ...(entry.worktree === undefined
                ? {}
                : {
                    branch: entry.worktree.branch,
                    baseCommit: entry.worktree.baseCommit,
                    ...(entry.worktree.headCommit === undefined
                      ? {}
                      : { headCommit: entry.worktree.headCommit }),
                  }),
            })),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } else {
      const entry = plan.entries[0];
      if (entry === undefined) throw new Error('artifact archive plan is empty');
      await cp(entry.sourcePath, temporary, { recursive: true });
    }
    await rename(temporary, plan.destination);
    await writeFile(
      receiptTemporary,
      `${JSON.stringify(
        {
          version: 1,
          kind: 'agora-artifact-archive',
          ...archived,
        } satisfies ArtifactArchiveReceipt,
        null,
        2,
      )}\n`,
      'utf8',
    );
    await rename(receiptTemporary, receiptPath);
    return archived;
  } catch (error) {
    await Promise.all([
      rm(temporary, { recursive: true, force: true }),
      rm(receiptTemporary, { force: true }),
    ]);
    throw error;
  }
}

export async function readArtifactArchiveReceipt(
  destination: string,
): Promise<ArchivedArtifact | undefined> {
  let raw: string;
  try {
    raw = await readFile(artifactArchiveReceiptPath(destination), 'utf8');
  } catch (error) {
    if (isMissingPath(error)) {
      if (await pathExists(destination)) {
        throw new Error('existing artifact archive is missing its immutable receipt');
      }
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('artifact archive receipt is not valid JSON');
  }
  if (
    !hasExactKeys(parsed, ['version', 'kind', 'path', 'worktrees']) ||
    parsed.version !== 1 ||
    parsed.kind !== 'agora-artifact-archive' ||
    parsed.path !== destination ||
    !isAbsolute(parsed.path) ||
    !Array.isArray(parsed.worktrees) ||
    parsed.worktrees.length === 0
  ) {
    throw new Error('artifact archive receipt is invalid');
  }
  const worktrees: Array<{ sourcePath: string; archivedPath: string }> = [];
  const sourcePaths = new Set<string>();
  const archivedPaths = new Set<string>();
  const canonicalDestination = await realpath(destination);
  for (const value of parsed.worktrees) {
    if (
      !hasExactKeys(value, ['sourcePath', 'archivedPath']) ||
      typeof value.sourcePath !== 'string' ||
      typeof value.archivedPath !== 'string' ||
      !isAbsolute(value.sourcePath) ||
      !isPathWithin(destination, value.archivedPath) ||
      sourcePaths.has(value.sourcePath) ||
      archivedPaths.has(value.archivedPath)
    ) {
      throw new Error('artifact archive receipt contains an invalid worktree mapping');
    }
    const canonicalArchivedPath = await realpath(value.archivedPath);
    if (!isPathWithin(canonicalDestination, canonicalArchivedPath)) {
      throw new Error('artifact archive receipt contains an escaped worktree mapping');
    }
    sourcePaths.add(value.sourcePath);
    archivedPaths.add(value.archivedPath);
    worktrees.push({ sourcePath: value.sourcePath, archivedPath: value.archivedPath });
  }
  return { path: parsed.path, worktrees };
}

function archivedArtifactFromPlan(plan: ArtifactArchivePlan): ArchivedArtifact {
  return {
    path: plan.destination,
    worktrees: plan.entries.map((entry) => ({
      sourcePath: entry.sourcePath,
      archivedPath: entry.archivedPath,
    })),
  };
}

function artifactArchiveReceiptPath(destination: string): string {
  return `${destination}.receipt.json`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}

function isPathWithin(parent: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const offset = relative(parent, candidate);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
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
