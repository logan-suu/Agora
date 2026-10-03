/** Canonical, conservative read/dependency analysis. Model supplied path lists
 * only choose the requested target; they never prove independent execution. */
import { type AppState, assertLocalExecutionState } from '@agora/core-domain';
import { localWorkerDependencies, localWorkspacePhysical } from './local-range-admission';
import {
  type LocalRangePhysical,
  type LocalRangePlan,
  localRangesOverlap,
} from './local-range-records';
import { type LocalRegistryRecords, localRecordHash } from './local-registry-records';
export interface LocalRangeTargets {
  schemaVersion: 'local-range-targets-v1';
  physical: LocalRangePhysical;
  tasks: { projectId: string; taskId: string; stateHash: string; workspaceIds: string[] }[];
  workers: {
    projectId: string;
    taskId: string;
    workerId: string;
    sessionId: string | null;
    status: string;
    assignmentHash: string;
    dependencyWorkspaceIds: string[];
  }[];
  claims: LocalRegistryRecords['claims'];
  cohort: LocalRangePlan['cohort'];
}
/** HEAD and lifecycle status are version facts. Scope, assignment, branch/base
 * and the canonical dependency mapping remain fixed while a cohort closes. */
export function localRangeAssignmentHash(state: AppState, workerId: string): string {
  const worker = state.workers.find((w) => w.workerId === workerId);
  if (!worker) throw Error('range_control_source_invalid');
  const worktree = worker.worktree;
  return localRecordHash({
    workerId,
    role: worker.role,
    subtaskId: worker.subtaskId ?? null,
    worktree:
      typeof worktree === 'object' && worktree !== null
        ? { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit }
        : (worktree ?? null),
    bindings: state.localExecution?.bindings.filter((b) => b.workerId === workerId) ?? [],
    dependencies: state.localExecution ? localWorkerDependencies(state, workerId) : [],
  });
}

export function deriveLocalRangeTargets(
  registry: LocalRegistryRecords,
  states: readonly AppState[],
  physical: LocalRangePhysical,
): LocalRangeTargets {
  const byTask = new Map<string, AppState>();
  for (const state of states) {
    assertLocalExecutionState(state);
    const key = `${state.projectId}/${state.taskId}`;
    if (byTask.has(key) || !state.localExecution) throw Error('range_control_source_invalid');
    byTask.set(key, state);
  }
  const affected = registry.workspaces.filter((w) =>
    localRangesOverlap(physical, localWorkspacePhysical(registry, w)),
  );
  const tasks: LocalRangeTargets['tasks'] = [],
    workers: LocalRangeTargets['workers'] = [],
    cohort: LocalRangePlan['cohort'] = [];
  for (const task of new Set(registry.workspaces.map((w) => `${w.projectId}/${w.taskId}`))) {
    const state = byTask.get(task);
    if (!state?.localExecution) throw Error('range_control_source_invalid');
    const registered = registry.workspaces.filter(
      (w) => w.projectId === state.projectId && w.taskId === state.taskId,
    );
    for (const workspace of registered)
      if (
        !state.localExecution.workspaces.some(
          (w) => localRecordHash(w) === localRecordHash(workspace),
        )
      )
        throw Error('range_control_source_invalid');
    const ownAffected = affected.filter(
      (w) => w.projectId === state.projectId && w.taskId === state.taskId,
    );
    const selected = [] as LocalRangeTargets['workers'];
    for (const worker of state.workers) {
      const dependencies = localWorkerDependencies(state, worker.workerId);
      if (
        !dependencies.some((w) => localRangesOverlap(physical, localWorkspacePhysical(registry, w)))
      )
        continue;
      const assignmentHash = localRangeAssignmentHash(state, worker.workerId);
      const item = {
        projectId: state.projectId,
        taskId: state.taskId,
        workerId: worker.workerId,
        sessionId: worker.sessionId ?? null,
        status: worker.status,
        assignmentHash,
        dependencyWorkspaceIds: dependencies.map((w) => w.workspaceId).sort(),
      };
      selected.push(item);
      if (worker.status === 'running') {
        if (!worker.sessionId || state.humanGate) throw Error('range_hold_scope_or_gate_conflict');
        cohort.push({
          projectId: state.projectId,
          taskId: state.taskId,
          workerId: worker.workerId,
          sessionId: worker.sessionId,
          assignmentHash,
        });
      }
    }
    if (ownAffected.length || selected.length) {
      tasks.push({
        projectId: state.projectId,
        taskId: state.taskId,
        stateHash: localRecordHash(state),
        workspaceIds: ownAffected.map((w) => w.workspaceId).sort(),
      });
      workers.push(...selected);
    }
  }
  const order = (
    a: { projectId: string; taskId: string; workerId?: string },
    b: { projectId: string; taskId: string; workerId?: string },
  ) =>
    `${a.projectId}/${a.taskId}/${a.workerId ?? ''}`.localeCompare(
      `${b.projectId}/${b.taskId}/${b.workerId ?? ''}`,
      'en',
    );
  tasks.sort(order);
  workers.sort(order);
  cohort.sort(order);
  const claims = registry.claims.filter((c) =>
    affected.some(
      (w) =>
        w.workspaceId === c.workspaceId && w.projectId === c.projectId && w.taskId === c.taskId,
    ),
  );
  return {
    schemaVersion: 'local-range-targets-v1',
    physical: structuredClone(physical),
    tasks,
    workers,
    claims: structuredClone(claims),
    cohort,
  };
}
