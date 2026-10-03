import type { WorkspaceRefV1 } from './local-workspace';
import { type AppState, isWorktreeRef } from './state';

/** CODER dependencies come from canonical assignments, never model read sets.
 * Other roles and incomplete dependency mappings retain the full task scope. */
export function canonicalWorkspaceDependencies(
  state: AppState,
  workerId: string,
): WorkspaceRefV1[] {
  const local = state.localExecution;
  if (!local) throw Error('workspace_binding_missing');
  const worker = state.workers.find((w) => w.workerId === workerId);
  const own = local.bindings.find((b) => b.workerId === workerId);
  if (!worker || !own || worker.role !== 'CODER' || !worker.subtaskId) return local.workspaces;
  const selected = new Set([own.workspaceId]);
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (seen.has(id)) return true;
    visiting.add(id);
    const subtask = state.subtasks.find((s) => s.id === id);
    if (!subtask) return false;
    for (const dependency of subtask.dependsOn) {
      const current = state.subtasks.find((s) => s.id === dependency);
      if (!current) return false;
      const bindings = local.bindings.filter(
        (b) =>
          b.subtaskId === dependency &&
          state.workers.some(
            (w) => w.workerId === b.workerId && w.role === 'CODER' && w.subtaskId === dependency,
          ),
      );
      const reference = current.worktree;
      const candidates =
        reference === undefined
          ? bindings
          : bindings.filter((b) => {
              const workspace = local.workspaces.find((w) => w.workspaceId === b.workspaceId);
              const mapping = local.git?.worktrees.find((w) => w.workspaceId === b.workspaceId);
              return (
                isWorktreeRef(reference) &&
                workspace?.mode === 'linked-worktree' &&
                mapping?.path === reference.path &&
                workspace.branch === reference.branch &&
                workspace.baseCommit === reference.baseCommit
              );
            });
      const workspaceIds = new Set(candidates.map((b) => b.workspaceId));
      if (workspaceIds.size !== 1 || !visit(dependency)) return false;
      const workspaceId = candidates[0]?.workspaceId;
      if (!workspaceId || !local.workspaces.some((w) => w.workspaceId === workspaceId))
        return false;
      selected.add(workspaceId);
    }
    visiting.delete(id);
    seen.add(id);
    return true;
  };
  return visit(worker.subtaskId)
    ? local.workspaces.filter((w) => selected.has(w.workspaceId))
    : local.workspaces;
}
