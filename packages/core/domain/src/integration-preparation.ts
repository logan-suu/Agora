import { readCodingWorkerLineage } from './coding-worker-lineage';
import { selectIntegrationBranch } from './integration-selection';
import { canonicalJson } from './parallel-execution';
import { applyMutations, type Mutation, setMutation } from './reducer';
import type { AppState, Integration, WorktreeRef } from './state';

export type IntegrationWavePlan = Pick<
  Integration,
  'integrationId' | 'waveId' | 'base' | 'pendingBranches'
>;

/** Stable identity input shared by orchestration and native admission; hashing stays outside L1. */
export const integrationIdentityInput = (
  taskId: string,
  waveId: string,
  baseCommit: string,
  branches: readonly Integration['pendingBranches'][number][],
) =>
  `${taskId}\u0000${waveId}\u0000${baseCommit}\u0000${branches.map((entry) => entry.workerId).join('\u0000')}`;

/** Current-wave control preparation only. Physical registration and claims need runtime proof. */
export function planIntegrationPreparation(
  state: AppState,
  before: AppState,
  plan: IntegrationWavePlan,
  target: WorktreeRef,
): Mutation[] {
  const execution = before.parallelExecution;
  const acceptedLineage = execution?.acceptedReceiptId
    ? readCodingWorkerLineage(before)
    : undefined;
  const expectedBase = acceptedLineage?.base ?? execution?.initialBase;
  if (
    Object.keys(plan).sort().join(',') !== 'base,integrationId,pendingBranches,waveId' ||
    before.phase !== 'coding' ||
    before.integration !== undefined ||
    before.humanGate ||
    !execution ||
    execution.activeWave?.attempt !== 1 ||
    execution.activeWave.waveId !== plan.waveId ||
    canonicalJson(expectedBase) !== canonicalJson(plan.base) ||
    target.baseCommit !== plan.base.commit ||
    target.headCommit !== plan.base.commit ||
    plan.pendingBranches.some(
      (branch) => branch.worktree.path === target.path || branch.worktree.branch === target.branch,
    )
  )
    throw Error('integration_preparation_mismatch');
  const integration: Integration = {
    ...structuredClone(plan),
    integrationWorktree: structuredClone(target),
    mergedBranches: [],
    conflicts: [],
    status: 'merging',
  };
  const changes = [setMutation('phase', 'integrating'), setMutation('integration', integration)];
  const after = applyMutations(before, changes);
  selectIntegrationBranch(after, plan.integrationId);
  if (canonicalJson(state) === canonicalJson(after)) return [];
  if (canonicalJson(state) !== canonicalJson(before))
    throw Error('integration_preparation_mismatch');
  return changes;
}
