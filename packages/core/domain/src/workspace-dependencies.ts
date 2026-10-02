import type { WorkspaceRefV1 } from './local-workspace';
import type { AppState } from './state';

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
      const binding = local.bindings.find((b) => b.subtaskId === dependency);
      if (!binding || !visit(dependency)) return false;
      selected.add(binding.workspaceId);
    }
    visiting.delete(id);
    seen.add(id);
    return true;
  };
  return visit(worker.subtaskId)
    ? local.workspaces.filter((w) => selected.has(w.workspaceId))
    : local.workspaces;
}
