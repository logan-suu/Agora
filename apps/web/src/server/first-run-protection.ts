/** Direct workspace protection uses the same native evidence as Phase 12.5. */
import { join } from 'node:path';
import type { GlobalScheduler } from '@agora/core-orchestration';
import { readHarnessLineageEvidence, readHarnessSafePointEvidence } from '@agora/runtime-executor';
import type { LocalBindingCoordinator } from '../../../../packages/runtime/sandbox/src/local-binding-coordinator';
import type { LocalControlObjects } from '../../../../packages/runtime/sandbox/src/local-control-objects';
import type { LocalGrantController } from '../../../../packages/runtime/sandbox/src/local-grant-controller';
import { LocalNativeRangeSources } from '../../../../packages/runtime/sandbox/src/local-native-range-sources';
import { LocalRangeReturnEvidence } from '../../../../packages/runtime/sandbox/src/local-range-return-evidence';
import { LocalRangeWorkerEvidence } from '../../../../packages/runtime/sandbox/src/local-range-worker-evidence';
import { LocalRangeWritersEvidence } from '../../../../packages/runtime/sandbox/src/local-range-writers-evidence';
import type { LocalRegistryOwner } from '../../../../packages/runtime/sandbox/src/local-registry-file';
import type { LocalVersionStore } from '../../../../packages/runtime/sandbox/src/local-version-store';
import type { LocalWorkspaceSessions } from '../../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { createLocalWorkspaceProtection } from './local-workspace-protection';
import type { TaskOrchestrationRuntime } from './task-orchestration-runtime';

type Scope = { projectId: string; taskId: string };
export async function bindFirstRunProtection(options: {
  owner: LocalRegistryOwner;
  control: LocalBindingCoordinator;
  objects: LocalControlObjects;
  grants: LocalGrantController;
  versions: LocalVersionStore;
  runtime: TaskOrchestrationRuntime;
  scheduler: GlobalScheduler;
  inspector: string;
  sessions(scope: Scope): LocalWorkspaceSessions;
}) {
  const { runtime, control, objects, versions, grants, sessions, scheduler } = options;
  const tasks = runtime.messages.store;
  const common = {
    control,
    objects,
    versions,
    tasks,
    verifyGrant: (s: Scope, id: string) => grants.assertGrant(s, id),
  };
  const identity = async (scope: Scope, role: string) => {
    // The official reader also runs inside range admission verification. Read
    // identity only here; re-entering assertClosed would recurse into itself.
    const state = await tasks.load(scope),
      registry = await control.snapshot();
    if (!state || state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    const roots = registry.roots.filter((r) => state.localExecution?.rootIds.includes(r.rootId));
    if (roots.length !== 1 || !roots[0]) throw Error('workspace_task_scope_mismatch');
    return {
      ...scope,
      role,
      cwd: roots[0].path,
      root: join(
        runtime.messages.root,
        'projects',
        scope.projectId,
        'tasks',
        scope.taskId,
        'harness-sessions',
      ),
    };
  };
  const workers = new LocalRangeWorkerEvidence({
    objects,
    tasks,
    runtime: (s) => runtime.rangeWorkerRuntime(s),
    native: (s) => sessions(s).rangeBoundary(s),
    official: async (s) => {
      const role = (await tasks.load(s))?.workers.find((w) => w.workerId === s.workerId)?.role;
      if (!role) throw Error('workspace_worker_missing');
      return readHarnessSafePointEvidence(s.safePointRef, await identity(s, role));
    },
  });
  const writers = new LocalRangeWritersEvidence({
    ...common,
    capabilities: (s) => sessions(s).rangeCapabilities(s),
    operations: (s) => sessions(s).rangeOperations(s),
    activity: (s) =>
      runtime.rangeWorkerRuntime(s)?.rangeActivity(s) ?? {
        ...s,
        activeWorkerIds: [],
        ...scheduler.activity(s),
      },
    dormantWorker: async (s) => {
      const boundary = await sessions(s).rangeBoundary({
        projectId: s.projectId,
        taskId: s.taskId,
        workerId: s.workerId,
        sessionId: s.sessionId,
        safePointRef: s.safePointRef,
      });
      if (!/^closure:[a-f0-9]{64}$/.test(boundary)) throw Error('range_worker_boundary_unverified');
      const hash = await objects.getReference(boundary.slice(8));
      if (!hash) throw Error('range_worker_boundary_unverified');
      return hash;
    },
    controlWriter: async () => {
      throw Error('direct_control_writer_unproven');
    },
  });
  const sources = new LocalNativeRangeSources({
    ...common,
    inspector: options.inspector,
    verifyLinked: async () => {
      throw Error('linked_workspace_not_prepared');
    },
    verifyWorkerClosure: (p, e) => workers.verify(p, e),
    verifyWritersClosure: (p, e, t) => writers.verify(p, e, t),
  });
  const evidence = new LocalRangeReturnEvidence({ ...common, sources, writers });
  // createLocalWorkspaceProtection registers the verifier once in the owner-shared registry.
  return createLocalWorkspaceProtection({
    ...options,
    sources,
    evidence,
    fallback: grants,
    lifecycle: {
      closeWorkers: (h, s) => workers.closeWorkers(h, s),
      proveWriters: (h, s, w) => writers.prove(h, s, w),
    },
    readFork: async (plan, fresh) =>
      readHarnessLineageEvidence(
        plan.sourceSafePointRef,
        plan.resumeSessionId,
        await identity(plan, plan.role),
        { fresh },
      ),
  });
}
