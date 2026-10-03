/** Read-only ownership eligibility before official child construction. This is
 * not a native capability or a replacement for current role/version evidence. */
import type { AppState } from '@agora/core-domain';
import { type LocalRegistryRecords, localRecordHash } from './local-registry-records';
export function assertLocalRangeResumeOwnership(
  state: AppState,
  original: LocalRegistryRecords,
  current: LocalRegistryRecords,
  workerId: string,
) {
  const worker = state.workers.find((w) => w.workerId === workerId),
    binding = state.localExecution?.bindings.find((b) => b.workerId === workerId),
    workspace = state.localExecution?.workspaces.find(
      (w) => w.workspaceId === binding?.workspaceId,
    );
  if (worker?.status !== 'paused' || state.humanGate) throw Error('range_resume_not_admissible');
  if (['PM', 'COORDINATOR'].includes(worker.role)) {
    if (binding) throw Error('range_resume_ownership_changed');
    return;
  }
  if (!workspace) throw Error('range_resume_ownership_changed');
  const belongs = (c: LocalRegistryRecords['claims'][number]) =>
      c.projectId === state.projectId &&
      c.taskId === state.taskId &&
      c.workerId === workerId &&
      c.workspaceId === workspace.workspaceId,
    before = original.claims.filter(belongs),
    now = current.claims.filter(belongs),
    writer =
      worker.role === 'CODER' || (worker.role === 'TESTER' && workspace.mode === 'linked-worktree');
  if (
    writer
      ? before.length !== 1 ||
        now.length !== 1 ||
        before[0]?.status !== 'active' ||
        now[0]?.status !== 'active' ||
        localRecordHash(before[0]) !== localRecordHash(now[0])
      : before.length !== 0 || now.length !== 0
  )
    throw Error('range_resume_ownership_changed');
}
