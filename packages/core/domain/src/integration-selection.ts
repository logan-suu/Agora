import { assertParallelState, canonicalJson, validationSubtaskIds } from './parallel-execution';
import { type AppState, isIntegration, isWorktreeRef } from './state';

/** Select control facts only. A runtime consumer must prove the baseline and physical sources. */
export function selectIntegrationBranch(state: AppState, integrationId: string) {
  assertParallelState(state);
  const execution = state.parallelExecution,
    wave = execution?.activeWave,
    integration = state.integration;
  if (
    state.phase !== 'integrating' ||
    state.humanGate ||
    !execution ||
    !wave ||
    wave.validation ||
    !isIntegration(integration) ||
    integration.status !== 'merging' ||
    integration.integrationId !== integrationId ||
    integration.waveId !== wave.waveId ||
    canonicalJson(integration.base) !== canonicalJson(wave.base) ||
    integration.pendingBranches.length !== wave.coderWorkerIds.length
  )
    throw Error('integration_selection_mismatch');
  const dispatches = state.messages.filter((m) => m.msgId === wave.waveId);
  const dispatch = dispatches[0];
  if (
    dispatches.length !== 1 ||
    !dispatch ||
    dispatch.fromRole !== 'COORDINATOR' ||
    dispatch.type !== 'announce' ||
    dispatch.channelId !== 'main' ||
    dispatch.payload.kind !== 'coding_wave' ||
    dispatch.payload.planId !== execution.planId
  )
    throw Error('integration_selection_mismatch');
  // This also checks the retained contributions of a canonical review repair.
  validationSubtaskIds(state, wave);
  const ranks = new Map<string, number>();
  const remaining = new Map(state.subtasks.map((s) => [s.id, s]));
  while (remaining.size) {
    let progressed = false;
    for (const [id, task] of remaining) {
      if (!task.dependsOn.every((dependency) => ranks.has(dependency))) continue;
      ranks.set(
        id,
        task.dependsOn.length
          ? 1 + Math.max(...task.dependsOn.map((d) => ranks.get(d) as number))
          : 0,
      );
      remaining.delete(id);
      progressed = true;
    }
    if (!progressed) throw Error('integration_dependency_mismatch');
  }
  for (const branch of integration.pendingBranches) {
    const index = wave.coderWorkerIds.indexOf(branch.workerId);
    const worker = state.workers.find((w) => w.workerId === branch.workerId);
    const task = state.subtasks.find((s) => s.id === branch.subtaskId);
    if (
      index < 0 ||
      wave.subtaskIds[index] !== branch.subtaskId ||
      worker?.role !== 'CODER' ||
      worker.status !== 'done' ||
      worker.subtaskId !== branch.subtaskId ||
      !task ||
      !isWorktreeRef(worker.worktree) ||
      !isWorktreeRef(task.worktree) ||
      canonicalJson(worker.worktree) !== canonicalJson(branch.worktree) ||
      canonicalJson(task.worktree) !== canonicalJson(branch.worktree) ||
      branch.worktree.baseCommit !== wave.base.commit ||
      branch.topologicalRank !== ranks.get(branch.subtaskId) ||
      task.dependsOn.some((d) => state.subtasks.find((s) => s.id === d)?.status !== 'done')
    )
      throw Error('integration_selection_mismatch');
  }
  const position = integration.mergedBranches.length;
  const branch = integration.pendingBranches[position];
  if (!branch) throw Error('integration_source_exhausted');
  return structuredClone({
    planId: execution.planId,
    waveId: wave.waveId,
    attempt: wave.attempt,
    integrationId,
    position,
    base: wave.base,
    target: integration.integrationWorktree,
    branch,
  });
}
