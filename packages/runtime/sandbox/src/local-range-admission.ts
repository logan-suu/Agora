/** Shared barrier for all trusted admission paths, including future writers. */
import type { WorkspaceRefV1 } from '@agora/core-domain';
import { type LocalRangePhysical, localRangesOverlap } from './local-range-records';
import type { LocalRegistryRecords } from './local-registry-records';

export function localWorkspacePhysical(
  registry: LocalRegistryRecords,
  workspace: WorkspaceRefV1,
): LocalRangePhysical {
  const root =
    workspace.mode === 'linked-worktree'
      ? registry.linkedRoots?.find(
          (r) =>
            r.workspaceId === workspace.workspaceId &&
            r.projectId === workspace.projectId &&
            r.taskId === workspace.taskId,
        )
      : registry.roots.find(
          (r) => r.rootId === workspace.rootId && r.projectId === workspace.projectId,
        );
  if (!root) throw Error('workspace_scope_mismatch');
  return { path: root.path, identity: `${root.dev}:${root.inode}`, chain: root.chain };
}

export { canonicalWorkspaceDependencies as localWorkerDependencies } from '@agora/core-domain';

export function localUndoOccupiedRanges(registry: LocalRegistryRecords): LocalRangePhysical[] {
  return registry.claims
    .filter((c) => c.kind === 'undo' && c.status !== 'released')
    .map((c) => {
      const workspace = registry.workspaces.find(
        (w) =>
          w.projectId === c.projectId && w.taskId === c.taskId && w.workspaceId === c.workspaceId,
      );
      if (!workspace) throw Error('workspace_scope_mismatch');
      return localWorkspacePhysical(registry, workspace);
    });
}

export function assertLocalRangeAdmission(
  registry: LocalRegistryRecords,
  workspace: WorkspaceRefV1,
  dependencies: readonly WorkspaceRefV1[],
): void {
  const holds = registry.rangeHolds?.filter((h) => h.stage !== 'released') ?? [];
  const undo = localUndoOccupiedRanges(registry);
  if (!holds.length && !undo.length) return;
  const physical = [workspace, ...dependencies].map((w) => localWorkspacePhysical(registry, w));
  if (undo.some((p) => physical.some((input) => localRangesOverlap(p, input))))
    throw Error('workspace_undo_in_progress');
  if (holds.some((h) => physical.some((p) => localRangesOverlap(h.plan.physical, p))))
    throw Error('file_taken_over');
}
