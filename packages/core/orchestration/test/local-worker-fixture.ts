// Unit-only lifecycle port and executor doubles; never used as G5 evidence.
import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  PHASE0_ROSTER,
  setMutation,
} from '@agora/core-domain';
import type { StepContext } from '@agora/runtime-executor';
import type { BoundWorkspaceTools, WorkspaceWorkerSession } from '@agora/runtime-sandbox';
import { type Assignment, GlobalScheduler, WorkerRuntime } from '../src/index';

export function createLocalRuntimeFixture(
  options: {
    trustedCompletion?: boolean;
    checkpointFailure?: boolean;
    role?: 'CODER' | 'TESTER' | 'COORDINATOR';
  } = {},
) {
  let state = createInitialAppState('local-worker', 'g');
  const assignment: Assignment =
    options.role && options.role !== 'CODER'
      ? { workerId: 'worker', role: options.role }
      : { workerId: 'worker', role: 'CODER', subtaskId: 'work' };
  state = applyMutations(state, [
    mergeByIdMutation('subtasks', 'work', {
      id: 'work',
      title: 'Fixed unit task',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'todo',
      createdBy: 'leader',
    }),
    setMutation('localExecution', {
      schemaVersion: 'local-execution-v1',
      rootIds: ['root'],
      workspaces: [],
      bindings: [],
      receipts: [],
    }),
  ]);
  const events: string[] = [];
  const scheduler = new GlobalScheduler();
  const executor = {
    stepCalls: [] as StepContext[],
    async step(context: StepContext) {
      this.stepCalls.push(context);
      return { kind: 'done' as const, output: {}, reachedSafeBoundary: true, mutations: [] };
    },
    async saveSafePoint() {
      return 'safe:local';
    },
    async loadSafePoint() {},
    injectInbox() {},
  };
  const runtime = new WorkerRuntime(
    {
      roster: PHASE0_ROSTER,
      loadState: async () => state,
      transition: async (_old, mutations) => {
        state = applyMutations(state, mutations);
        return state;
      },
      buildExecutor: () => {
        throw Error('legacy executor must not be built');
      },
      resolveWorktree: async () => {
        throw Error('direct mode must not resolve a Git worktree');
      },
      localWorkspace: {
        async openControl(admission) {
          admission.assertLease();
          events.push('open-control');
          let closed = false;
          return {
            kind: 'control' as const,
            sessionId: admission.sessionId,
            async checkpoint(reason) {
              admission.assertLease();
              if (closed) throw Error('closed fixture capability');
              events.push(`checkpoint:${reason}`);
            },
            async close() {
              if (closed) return;
              admission.assertLease();
              events.push('close');
              closed = true;
            },
          };
        },
        async open(admission) {
          if (admission.role === 'COORDINATOR') throw Error('control role cannot open file tools');
          admission.assertLease();
          events.push('open');
          const workspace = {
            schemaVersion: 'workspace-v1' as const,
            projectId: state.projectId,
            taskId: state.taskId,
            workspaceId: 'workspace',
            rootId: 'root',
            grantId: 'grant',
            purpose: assignment.role === 'CODER' ? ('coding' as const) : ('validation' as const),
            mode: 'direct' as const,
            baselineManifestId: 'manifest',
          };
          if (!state.localExecution) throw Error('missing local state');
          state = applyMutations(state, [
            setMutation('localExecution', {
              ...state.localExecution,
              workspaces: [workspace],
              bindings: [
                {
                  workerId: 'worker',
                  ...(assignment.subtaskId === undefined
                    ? {}
                    : { subtaskId: assignment.subtaskId }),
                  workspaceId: 'workspace',
                  receiptId: 'binding',
                },
              ],
              receipts: [
                {
                  receiptId: 'binding',
                  actionId: 'register',
                  inputHash: 'a'.repeat(64),
                  registryRevision: 2,
                },
              ],
            }),
          ]);
          let closed = false;
          return {
            sessionId: admission.sessionId,
            workspace,
            tools: {} as BoundWorkspaceTools,
            async checkpoint(reason) {
              admission.assertLease();
              if (closed) throw Error('closed fixture capability');
              events.push(`checkpoint:${reason}`);
              if (options.checkpointFailure) throw Error('workspace_file_recovery_required');
            },
            async close() {
              if (closed) return;
              admission.assertLease();
              events.push('close');
              closed = true;
            },
          } satisfies WorkspaceWorkerSession;
        },
      },
      buildLocalControlExecutor: () => {
        events.push('build-control');
        return executor;
      },
      completeLocalAssignment: async (_state, _assignment, session) => {
        if (options.trustedCompletion) {
          events.push('trusted-verification');
          await session.checkpoint('step');
        }
        return [];
      },
      buildLocalExecutor: () => {
        events.push('build');
        return executor;
      },
    },
    scheduler,
  );
  return { runtime, state: () => state, assignment, events, scheduler, executor };
}
