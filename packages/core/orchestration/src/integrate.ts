import { createHash } from 'node:crypto';

import {
  type AppState,
  type HumanGateRequest,
  type Integration,
  type IntegrationBranch,
  type Mutation,
  mergeByIdMutation,
  setMutation,
  type WorktreeRef,
} from '@agora/core-domain';

export interface IntegrationWorkspacePort {
  createIntegrationWorktree(
    waveId: string,
    integrationId: string,
    baseCommit: string,
  ): Promise<WorktreeRef>;
  refreshWorktree(ref: WorktreeRef): Promise<WorktreeRef>;
  integrate(base: string, branches: string[]): Promise<{ merged: boolean; conflicts: string[] }>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  resetIntegration(ref: WorktreeRef, baseCommit: string): Promise<WorktreeRef>;
}

export interface IntegrateWaveInput {
  waveId: string;
  workerIds: readonly string[];
  baseBranch?: string;
  now?: number;
}

export interface IntegrateWaveResult {
  state: AppState;
  gateRequest?: HumanGateRequest;
}

export type IntegrationTransition = (
  state: AppState,
  mutations: readonly Mutation[],
) => Promise<AppState>;

export class IntegrationService {
  constructor(
    private readonly workspace: IntegrationWorkspacePort,
    private readonly transition: IntegrationTransition,
  ) {}

  async integrateWave(state: AppState, input: IntegrateWaveInput): Promise<IntegrateWaveResult> {
    const branches = plannedBranches(state, input.workerIds);
    const baseCommit = commonBaseCommit(branches);
    const baseBranch = input.baseBranch ?? 'main';
    const integrationId = integrationIdentity(state.taskId, input.waveId, baseCommit, branches);
    let current = state;
    let integration = current.integration;

    if (
      integration === undefined ||
      (integration.status === 'idle' && integration.integrationId !== integrationId)
    ) {
      if (integration !== undefined && integration.base.commit !== baseCommit) {
        throw new Error('reworked integration wave changed its original base commit');
      }
      const integrationWorktree = await this.workspace.createIntegrationWorktree(
        input.waveId,
        integrationId,
        baseCommit,
      );
      integration = {
        integrationId,
        waveId: input.waveId,
        base: { branch: baseBranch, commit: baseCommit },
        integrationWorktree,
        pendingBranches: branches,
        mergedBranches: [],
        conflicts: [],
        status: 'merging',
      };
      current = await this.transition(current, [setMutation('integration', integration)]);
    } else {
      assertSamePlan(integration, integrationId, input.waveId, baseBranch, baseCommit, branches);
      if (integration.status === 'done') return { state: current };
      if (integration.status === 'conflict') {
        return { state: current, gateRequest: conflictGate(integration, input.now ?? Date.now()) };
      }
      if (integration.status === 'idle') {
        const reset = await this.workspace.resetIntegration(
          integration.integrationWorktree,
          integration.base.commit,
        );
        integration = { ...integration, integrationWorktree: reset, status: 'merging' };
        current = await this.transition(current, [setMutation('integration', integration)]);
      }
    }

    for (const branch of integration.pendingBranches) {
      if (integration.mergedBranches.some((entry) => entry.workerId === branch.workerId)) continue;
      const workerHead = await this.workspace.refreshWorktree(branch.worktree);
      if (workerHead.headCommit !== branch.worktree.headCommit) {
        throw new Error(`worker branch HEAD drifted for ${branch.workerId}`);
      }
      const target = await this.workspace.refreshWorktree(integration.integrationWorktree);
      const expectedHead =
        integration.mergedBranches.at(-1)?.mergeCommit ?? integration.base.commit;
      if (target.headCommit === undefined) {
        throw new Error('integration worktree HEAD is unavailable');
      }
      if (target.headCommit !== expectedHead) {
        const alreadyMerged =
          (await this.workspace.isAncestor(expectedHead, target.headCommit)) &&
          (await this.workspace.isAncestor(
            branch.worktree.headCommit as string,
            target.headCommit,
          ));
        if (!alreadyMerged)
          throw new Error('integration worktree HEAD drifted from persisted progress');
        integration = appendMerged(integration, branch, target.headCommit);
        current = await this.transition(current, [setMutation('integration', integration)]);
        continue;
      }

      const merged = await this.workspace.integrate(integration.integrationWorktree.branch, [
        branch.worktree.branch,
      ]);
      if (!merged.merged) {
        integration = {
          ...integration,
          conflicts: [
            {
              workerId: branch.workerId,
              subtaskId: branch.subtaskId,
              branch: branch.worktree.branch,
              headCommit: branch.worktree.headCommit as string,
              files: [...merged.conflicts],
            },
          ],
          status: 'conflict',
        };
        current = await this.transition(current, [
          setMutation('integration', integration),
          mergeByIdMutation('subtasks', branch.subtaskId, { status: 'blocked' }),
        ]);
        return { state: current, gateRequest: conflictGate(integration, input.now ?? Date.now()) };
      }
      const after = await this.workspace.refreshWorktree(integration.integrationWorktree);
      if (after.headCommit === undefined) throw new Error('merged integration HEAD is unavailable');
      if (
        !(await this.workspace.isAncestor(branch.worktree.headCommit as string, after.headCommit))
      ) {
        throw new Error(`integration result does not contain worker branch ${branch.workerId}`);
      }
      integration = appendMerged(integration, branch, after.headCommit);
      current = await this.transition(current, [setMutation('integration', integration)]);
    }

    const resultCommit = integration.mergedBranches.at(-1)?.mergeCommit ?? integration.base.commit;
    integration = { ...integration, resultCommit, status: 'done' };
    current = await this.transition(current, [setMutation('integration', integration)]);
    return { state: current };
  }
}

function plannedBranches(state: AppState, workerIds: readonly string[]): IntegrationBranch[] {
  if (workerIds.length === 0 || new Set(workerIds).size !== workerIds.length) {
    throw new Error('integration wave requires unique workerIds');
  }
  return workerIds
    .map((workerId) => {
      const worker = state.workers.find((entry) => entry.workerId === workerId);
      if (worker === undefined || worker.status !== 'done' || worker.subtaskId === undefined) {
        throw new Error(`worker "${workerId}" is not a completed subtask worker`);
      }
      const subtask = state.subtasks.find((entry) => entry.id === worker.subtaskId);
      if (subtask === undefined) throw new Error(`worker "${workerId}" subtask is missing`);
      const unfinishedDependency = subtask.dependsOn.find(
        (dependencyId) =>
          state.subtasks.find((entry) => entry.id === dependencyId)?.status !== 'done',
      );
      if (unfinishedDependency !== undefined) {
        throw new Error(
          `worker "${workerId}" subtask dependency is not done: ${unfinishedDependency}`,
        );
      }
      if (typeof worker.worktree === 'string' || typeof subtask.worktree === 'string') {
        throw new Error(`worker "${workerId}" has an unmigrated legacy worktree`);
      }
      if (worker.worktree === undefined || subtask.worktree === undefined) {
        throw new Error(`worker "${workerId}" has no worktree`);
      }
      if (!sameWorktree(worker.worktree, subtask.worktree)) {
        throw new Error(`worker "${workerId}" worktree conflicts with its subtask`);
      }
      if (worker.worktree.headCommit === undefined) {
        throw new Error(`worker "${workerId}" has no submitted headCommit`);
      }
      return {
        workerId,
        subtaskId: subtask.id,
        worktree: structuredClone(worker.worktree),
        topologicalRank: topologicalRank(state, subtask.id, new Set()),
      };
    })
    .sort(
      (left, right) =>
        left.topologicalRank - right.topologicalRank || left.workerId.localeCompare(right.workerId),
    );
}

function sameWorktree(left: WorktreeRef, right: WorktreeRef): boolean {
  return (
    left.path === right.path &&
    left.branch === right.branch &&
    left.baseCommit === right.baseCommit &&
    left.headCommit === right.headCommit
  );
}

function topologicalRank(state: AppState, subtaskId: string, visiting: Set<string>): number {
  if (visiting.has(subtaskId)) throw new Error('subtask dependency graph contains a cycle');
  const subtask = state.subtasks.find((entry) => entry.id === subtaskId);
  if (subtask === undefined) throw new Error(`subtask "${subtaskId}" is missing`);
  if (subtask.dependsOn.length === 0) return 0;
  const next = new Set(visiting).add(subtaskId);
  return (
    1 + Math.max(...subtask.dependsOn.map((dependency) => topologicalRank(state, dependency, next)))
  );
}

function commonBaseCommit(branches: readonly IntegrationBranch[]): string {
  const baseCommit = branches[0]?.worktree.baseCommit;
  if (
    baseCommit === undefined ||
    branches.some((entry) => entry.worktree.baseCommit !== baseCommit)
  ) {
    throw new Error('integration branches must share one baseCommit');
  }
  return baseCommit;
}

function integrationIdentity(
  taskId: string,
  waveId: string,
  baseCommit: string,
  branches: readonly IntegrationBranch[],
): string {
  const digest = createHash('sha256')
    .update(
      `${taskId}\u0000${waveId}\u0000${baseCommit}\u0000${branches.map((entry) => entry.workerId).join('\u0000')}`,
    )
    .digest('hex');
  return `integration-${digest.slice(0, 24)}`;
}

function appendMerged(
  integration: Integration,
  branch: IntegrationBranch,
  mergeCommit: string,
): Integration {
  return {
    ...integration,
    integrationWorktree: { ...integration.integrationWorktree, headCommit: mergeCommit },
    mergedBranches: [
      ...integration.mergedBranches,
      {
        workerId: branch.workerId,
        subtaskId: branch.subtaskId,
        branch: branch.worktree.branch,
        headCommit: branch.worktree.headCommit as string,
        mergeCommit,
      },
    ],
  };
}

function assertSamePlan(
  integration: Integration,
  integrationId: string,
  waveId: string,
  baseBranch: string,
  baseCommit: string,
  branches: readonly IntegrationBranch[],
): void {
  if (
    integration.integrationId !== integrationId ||
    integration.waveId !== waveId ||
    integration.base.branch !== baseBranch ||
    integration.base.commit !== baseCommit ||
    JSON.stringify(integration.pendingBranches) !== JSON.stringify(branches)
  ) {
    throw new Error('persisted Integration conflicts with requested wave');
  }
}

function conflictGate(integration: Integration, triggerTs: number): HumanGateRequest {
  return {
    triggerMsgId: integration.integrationId,
    triggerTs,
    reason: `integration_conflict:${integration.integrationId}`,
    options: ['request_rework'],
    phase: 'integrating',
  };
}
