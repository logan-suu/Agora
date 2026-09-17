/** Explicit composition for already approved local acceptance tasks. Preparing
 * the registry/toolchain remains host-owned; this factory never grants a root. */
import {
  type AppState,
  currentLocalCompletionEvidence,
  currentReviewDispatch,
  localValidationReceipt,
  type RoleSpec,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import {
  GlobalScheduler,
  validateHumanGateWorkerResumes,
  WorkerRuntime,
} from '@agora/core-orchestration';
import {
  DEFAULT_ROSTER,
  SIX_ROLE_FORMAT_REPAIR,
  SIX_ROLE_TURN_MUTATION_READERS,
} from '@agora/roles-definitions';
import {
  type HarnessExecutor,
  type HarnessExecutorOptions,
  inspectHarnessSafePoint,
  projectForAssignment,
} from '@agora/runtime-executor';
import type {
  BoundWorkspaceTools,
  WorkspaceControlSession,
  WorkspaceWorkerAdmission,
  WorkspaceWorkerSession,
} from '@agora/runtime-sandbox';
import type { LocalWorkspaceSessions } from '../../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { LocalValidationService } from './local-validation';
import {
  createLocalControlExecutor,
  createLocalWorkspaceExecutor,
} from './local-workspace-executor';
import type { ModelSettingsService } from './model-settings';
import type { TaskCompositionFactory } from './task-orchestration-runtime';

type Scope = { projectId: string; taskId: string };
type Prepared = { local: LocalWorkspaceSessions; cwd: string; sessionRoot: string };
type Options = {
  loadState(scope: Scope): Promise<AppState | undefined>;
  bindCompletionVerifier(verify: (scope: Scope, state: AppState) => Promise<void>): void;
  prepare(
    scope: Scope,
    versionForAssignment: (
      admission: WorkspaceWorkerAdmission,
    ) => Promise<WorkspaceVersionV1 | undefined>,
  ): Promise<Prepared>;
  scheduler?: GlobalScheduler;
  model?: string;
  modelSettings?: ModelSettingsService;
  executorOptions?: Pick<
    HarnessExecutorOptions,
    'adapter' | 'provider' | 'deepseek' | 'compatible' | 'approval' | 'maxToolCallsPerTurn'
  >;
};
const key = (scope: Scope) => JSON.stringify([scope.projectId, scope.taskId]);
const localHandoff: Record<string, string> = {
  PM: 'Return one raw JSON array of requirements: {"id":"req-1","story":"...","acceptance":["..."],"nonGoals":["..."]}. Preserve scope; do not invent features.',
  ARCHITECT:
    'Return one raw JSON object with exactly architecture and conventions as sibling objects. architecture.executionPlan must be {"version":1,"subtasks":[{"id":"A","title":"Implementation","dependsOn":[]}]}. Only CODER implementation tasks belong in the plan; record testing expectations in conventions. Preserve existing tests.',
  REVIEWER:
    'Return a raw JSON array with exactly one verdict entry {"id":"unique-review-id","kind":"verdict","verdict":"approved"|"changes_requested","issueScope":"implementation"|"architecture","summary":"..."}. Other comment entries may follow. Use a new stable id matching [A-Za-z0-9][A-Za-z0-9._:-]*. Root-cause review requires changes_requested. Preserve existing cumulative tests and report missing capabilities explicitly. Approval only proposes completion to the Leader.',
  TESTER:
    'Inspect the acceptance criteria and the fixed snapshot. The trusted runtime runs all supported tests after your turn and writes the canonical test result. You cannot set testResults or create validation receipts. Report gaps or missing tests explicitly; do not repair business code or weaken tests.',
};
function requireState(state: AppState | undefined, scope: Scope) {
  if (
    !state?.localExecution ||
    state.projectId !== scope.projectId ||
    state.taskId !== scope.taskId ||
    state.localExecution.rootIds.length !== 1
  )
    throw Error('local_task_authorization_required');
  return state;
}
function latestValidation(state: AppState) {
  const dispatch = [...state.messages]
    .reverse()
    .find(
      (m) =>
        m.fromRole === 'COORDINATOR' &&
        m.channelId === 'main' &&
        m.type === 'announce' &&
        m.payload.nextRole === 'TESTER',
    );
  if (!dispatch) throw Error('local_review_requires_validation');
  return `workspace-validation:${dispatch.msgId}`;
}
/** The deferred port is inert during Agent factory Fork. It can only call tools
 * after WorkerRuntime has acquired a new lease and supplied its fresh session. */
function deferredTools() {
  let target: BoundWorkspaceTools | undefined;
  const get = () => {
    if (!target) throw Error('workspace_worker_capability_closed');
    return target;
  };
  return {
    tools: {
      inspect: (id) => get().inspect(id),
      read: (id, path) => get().read(id, path),
      apply: (id, changes, dependencies) => get().apply(id, changes, dependencies),
      run: (id, request) => get().run(id, request),
      generated: (id, receiptId, path) => {
        const read = get().generated;
        if (!read) throw Error('workspace_generation_unavailable');
        return read(id, receiptId, path);
      },
    } satisfies BoundWorkspaceTools,
    bind(tools: BoundWorkspaceTools) {
      if (target) throw Error('local_resume_already_bound');
      target = tools;
    },
    close() {
      target = undefined;
    },
  };
}
export function createLocalTaskCompositionFactory(options: Options): TaskCompositionFactory {
  const scheduler = options.scheduler ?? new GlobalScheduler();
  const prepared = new Map<string, Promise<Prepared>>();
  const load = async (scope: Scope) => requireState(await options.loadState(scope), scope);
  const get = async (scope: Scope) => {
    await load(scope);
    const id = key(scope);
    let pending = prepared.get(id);
    if (!pending) {
      pending = options
        .prepare(scope, async (admission) => {
          if (admission.projectId !== scope.projectId || admission.taskId !== scope.taskId)
            throw Error('workspace_task_scope_mismatch');
          if (admission.role !== 'REVIEWER') return undefined;
          const state = await load(scope);
          return localValidationReceipt(state, latestValidation(state)).workspaceVersion;
        })
        .then(async (runtime) => {
          await runtime.local.ensureReady();
          return runtime;
        });
      prepared.set(id, pending);
      void pending.catch(() => {
        if (prepared.get(id) === pending) prepared.delete(id);
      });
    }
    return pending;
  };
  options.bindCompletionVerifier(async (scope, state) => {
    const bootstrap = await get(scope);
    await new LocalValidationService(bootstrap.local, () => load(scope)).verifyCompletion(state);
  });
  return async (input) => {
    const { scope, resume } = input;
    const initialState = requireState(await input.loadState(), scope);
    if (initialState.goal !== input.goal) throw Error('local_task_goal_mismatch');
    const bootstrap = await get(scope);
    const validation = new LocalValidationService(bootstrap.local, () => load(scope));
    await bootstrap.local.recoverCompletion(scope);
    if (resume?.receipt.option === 'approve_completion')
      await validation.verifyCompletion(initialState);
    const modelBinding = await options.modelSettings?.freeze(
      scope,
      input.goal,
      resume !== undefined,
    );
    const routes =
      modelBinding === undefined
        ? undefined
        : await options.modelSettings?.executorRoutes(modelBinding);
    const executors: { executor: HarnessExecutor; dispose(): Promise<void> }[] = [];
    const forks = new Map<
      string,
      { executor: HarnessExecutor; role: string; deferred?: ReturnType<typeof deferredTools> }
    >();
    let latest: HarnessExecutor | undefined;
    let closed = false;
    let artifactPath = bootstrap.cwd;
    const executorOptions = (source: RoleSpec, resumeSessionId?: string) => {
      const route =
        routes?.get(source.role) ??
        (modelBinding?.defaultModel ? { model: modelBinding.defaultModel } : undefined);
      if (routes && !route) throw Error('task deployment model binding is unavailable');
      const spec = {
        ...source,
        systemPrompt: `${source.systemPrompt}\n\n${localHandoff[source.role] ?? ''}`,
        ...(route ? { model: route.model } : options.model ? { model: options.model } : {}),
      };
      const reader = SIX_ROLE_TURN_MUTATION_READERS[source.role];
      const configured: HarnessExecutorOptions = {
        ...(route?.compatible
          ? {
              compatible: route.compatible,
              ...(options.executorOptions?.approval
                ? { approval: options.executorOptions.approval }
                : {}),
            }
          : (options.executorOptions ?? { deepseek: true })),
        sessionPersistence: {
          root: bootstrap.sessionRoot,
          cwd: bootstrap.cwd,
          ...scope,
          ...(resumeSessionId ? { resumeSessionId } : {}),
        },
        ...(reader
          ? {
              readTurnMutations: ({ text }) => reader(text),
              validateTurnOutput: ({ text }) => {
                reader(text);
              },
              ...(SIX_ROLE_FORMAT_REPAIR[source.role]
                ? { outputFormatHint: SIX_ROLE_FORMAT_REPAIR[source.role] }
                : {}),
            }
          : {}),
      };
      return { spec, options: configured };
    };
    const remember = <T extends { executor: HarnessExecutor; dispose(): Promise<void> }>(
      entry: T,
    ) => {
      executors.push(entry);
      latest = entry.executor;
      return entry.executor;
    };
    const dispose = async () => {
      if (closed) return;
      const results = await Promise.allSettled(executors.map((entry) => entry.dispose()));
      for (const fork of forks.values()) fork.deferred?.close();
      const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
      if (failures.length) throw new AggregateError(failures, 'local_composition_cleanup_failed');
      closed = true;
    };
    try {
      if (resume) {
        const plans = validateHumanGateWorkerResumes(
          initialState,
          resume.actionId,
          resume.receipt.safePointRefs,
          resume.receipt.workerResumes,
        );
        if (!plans && resume.receipt.safePointRefs.length)
          throw Error('local_resume_worker_binding_required');
        const roster = (await input.loadRoster?.()) ?? DEFAULT_ROSTER;
        for (const plan of plans ?? []) {
          const worker = initialState.workers.find((w) => w.workerId === plan.workerId);
          const identity = inspectHarnessSafePoint(plan.sourceSafePointRef);
          const spec = roster.find((r) => r.role === worker?.role);
          if (
            !worker ||
            !spec ||
            identity.projectId !== scope.projectId ||
            identity.taskId !== scope.taskId ||
            identity.cwd !== bootstrap.cwd ||
            identity.role !== worker.role
          )
            throw Error('local_resume_identity_mismatch');
          const configured = executorOptions(spec, plan.resumeSessionId);
          let executor: HarnessExecutor;
          let deferred: ReturnType<typeof deferredTools> | undefined;
          if (['PM', 'COORDINATOR'].includes(spec.role))
            executor = remember(
              createLocalControlExecutor({
                ...configured,
                session: { kind: 'control', sessionId: plan.resumeSessionId },
              }),
            );
          else {
            const binding = initialState.localExecution?.bindings.find(
              (b) => b.workerId === worker.workerId,
            );
            const workspace = initialState.localExecution?.workspaces.find(
              (w) => w.workspaceId === binding?.workspaceId,
            );
            if (!workspace) throw Error('local_workspace_assignment_missing');
            deferred = deferredTools();
            executor = remember(
              await createLocalWorkspaceExecutor({
                ...configured,
                session: { workspace, sessionId: plan.resumeSessionId, tools: deferred.tools },
              }),
            );
          }
          await executor.loadSafePoint(plan.sourceSafePointRef);
          executor.injectInbox(
            projectForAssignment(
              initialState,
              {
                workerId: worker.workerId,
                role: worker.role,
                ...(worker.subtaskId ? { subtaskId: worker.subtaskId } : {}),
              },
              roster,
              await input.buildChannelContext(initialState, worker.role),
            ),
          );
          forks.set(worker.workerId, {
            executor,
            role: worker.role,
            ...(deferred ? { deferred } : {}),
          });
        }
      }
      const restore = (
        workerId: string,
        role: string,
        session: WorkspaceWorkerSession | WorkspaceControlSession,
      ) => {
        const fork = forks.get(workerId);
        if (!fork) return undefined;
        if (fork.role !== role) throw Error('local_resume_identity_mismatch');
        if ('workspace' in session) fork.deferred?.bind(session.tools);
        latest = fork.executor;
        return fork.executor;
      };
      const workerRuntime = new WorkerRuntime(
        {
          roster: DEFAULT_ROSTER,
          ...(input.loadRoster ? { loadRoster: input.loadRoster } : {}),
          loadState: input.loadState,
          transition: input.transition,
          ...(input.transitionStep ? { transitionStep: input.transitionStep } : {}),
          handleOutput: input.handleOutput,
          buildChannelContext: input.buildChannelContext,
          ...(resume?.receipt.workerResumes
            ? {
                resumingWorkers: resume.receipt.workerResumes.map((p) => ({
                  workerId: p.workerId,
                  resumeSessionId: p.resumeSessionId,
                })),
              }
            : {}),
          localWorkspace: bootstrap.local,
          buildExecutor: () => {
            throw Error('local_legacy_executor_forbidden');
          },
          buildLocalControlExecutor: (spec, assignment, session) =>
            restore(assignment.workerId, spec.role, session) ??
            remember(createLocalControlExecutor({ ...executorOptions(spec), session })),
          buildLocalExecutor: async (spec, assignment, session) => {
            if (spec.role === 'REVIEWER') {
              const state = await load(scope);
              const receiptId = latestValidation(state);
              await validation.verify(state, receiptId);
              if (currentReviewDispatch(state)?.payload.workspaceReviewBinding)
                currentLocalCompletionEvidence(state);
            }
            return (
              restore(assignment.workerId, spec.role, session) ??
              remember(await createLocalWorkspaceExecutor({ ...executorOptions(spec), session }))
            );
          },
          completeLocalAssignment: async (state, assignment, session) => {
            if (assignment.role !== 'TESTER') return [];
            const source = [...(state.localExecution?.workspaces ?? [])]
              .reverse()
              .find(
                (w) =>
                  w.purpose === 'coding' &&
                  w.rootId === session.workspace.rootId &&
                  w.grantId === session.workspace.grantId,
              );
            if (!source) throw Error('local_validation_source_not_ready');
            return validation.complete(state, assignment.workerId, source.workspaceId, session);
          },
        },
        scheduler,
      );
      return {
        initialState: await load(scope),
        workerRuntime,
        roster: DEFAULT_ROSTER,
        ...(input.loadRoster ? { loadRoster: input.loadRoster } : {}),
        get artifactPath() {
          return artifactPath;
        },
        saveSafePoints: async () => (latest ? [await latest.saveSafePoint()] : []),
        suspend: dispose,
        dispose,
        archiveArtifact: async () => {
          const artifact = await validation.archive(await load(scope), bootstrap.local);
          artifactPath = artifact.path;
          return { path: artifact.path, worktrees: [] };
        },
      };
    } catch (error) {
      try {
        await dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'local_composition_setup_and_cleanup_failed');
      }
      throw error;
    }
  };
}
