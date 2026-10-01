// Real completed linked workers and canonical integration; lifecycle facts are test-owned.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeByIdMutation, setMutation } from '@agora/core-domain';
import { GlobalScheduler, planIntegrationWave } from '@agora/core-orchestration';
import { LocalIntegrationAuthority } from '../../../packages/runtime/sandbox/src/local-integration-authority';
import { LocalIntegrationPreparation } from '../../../packages/runtime/sandbox/src/local-integration-preparation';
import { LocalIntegrationSources } from '../../../packages/runtime/sandbox/src/local-integration-sources';
import type { LocalIntegrationClaimRecord } from '../../../packages/runtime/sandbox/src/local-registry-records';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import { hash } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { firstCodingWave, type registrationContext } from './local-linked-workspace-fixture';

export async function completedCoders(
  ctx: Awaited<ReturnType<typeof registrationContext>>,
  hooks: {
    afterGrant?(): Promise<void>;
    assertControl?(): Promise<void>;
    verifyClosure?(claim: LocalIntegrationClaimRecord): Promise<string>;
    seedDirectories?: boolean;
    canonicalPlan?: boolean;
    singleWorker?: boolean;
    conflictingFile?: boolean;
  } = {},
) {
  const { manager, request, state } = await firstCodingWave(
    ctx,
    hooks.singleWorker ? { singleWorker: true } : {},
  );
  await manager.registerCodingWave(request);
  const wave = state.parallelExecution?.activeWave;
  if (!wave) throw Error('missing wave');
  const sessions = await LocalWorkspaceSessions.create({
    ...ctx,
    filesHelper: resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
    grantForAssignment: async () => ctx.grant.grantId,
    verifyGrant: async (scope, grantId) => {
      await ctx.verifyGrant(scope, grantId);
      await hooks.afterGrant?.();
    },
  });
  const scheduler = new GlobalScheduler();
  for (const [index, workerId] of wave.coderWorkerIds.entries()) {
    const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, workerId);
    try {
      const worktree = await manager.resolveAssignment({ ...ctx.scope, workerId });
      const subtaskId = wave.subtaskIds[index];
      if (!subtaskId) throw Error('missing subtask');
      const sessionId = `source-session-${index}`;
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', workerId, { status: 'running', sessionId, worktree }),
      ]);
      const session = await sessions.open({
        ...ctx.scope,
        workerId,
        role: 'CODER',
        subtaskId,
        sessionId,
        assertLease: () => scheduler.assertActive(lease),
      });
      const path = hooks.conflictingFile ? 'shared-result.txt' : `result-${index}.txt`;
      const file = await session.tools.read(`tool:${hash(`read-${index}`)}`, path);
      await session.tools.apply(
        `tool:${hash(`write-${index}`)}`,
        [
          {
            path,
            expected: file.version,
            readReceiptId: file.readReceiptId,
            content: `worker ${index}\n`,
            encoding: 'utf8',
          },
        ],
        [],
      );
      // Fixture-owned source content exercises cumulative full-tree provenance;
      // directory creation through a model tool is not claimed by this fixture.
      if (hooks.seedDirectories) {
        mkdirSync(join(worktree.path, `worker-${index}`, 'empty'), { recursive: true });
        writeFileSync(join(worktree.path, `worker-${index}`, 'nested.txt'), `nested ${index}\n`);
      }
      await session.checkpoint('complete');
      if (!session.completeWorktree) throw Error('missing completion');
      const completed = await session.completeWorktree();
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', workerId, { worktree: completed }),
        mergeByIdMutation('subtasks', subtaskId, { worktree: completed }),
      ]);
      await session.close();
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', workerId, { status: 'done' }),
      ]);
    } finally {
      await scheduler.release(lease);
    }
  }
  const current = await ctx.control.assertClosed(ctx.scope);
  const target = current.localExecution?.workspaces.find((w) => w.workspaceId === 'integration');
  const physical = (await ctx.control.snapshot()).linkedRoots?.find(
    (r) => r.workspaceId === 'integration',
  );
  if (target?.mode !== 'linked-worktree' || !physical) throw Error('missing integration');
  const authority = new LocalIntegrationAuthority({
    ...ctx,
    assertControl: async () => {
      await ctx.control.assertClosed(ctx.scope);
      await hooks.assertControl?.();
    },
    verifyClosure: async (claim) => {
      if (hooks.verifyClosure) return hooks.verifyClosure(claim);
      throw Error('closure not exercised');
    },
  });
  return { manager, sessions, wave, current, target, physical, authority };
}

export async function completedIntegration(
  ctx: Parameters<typeof completedCoders>[0],
  hooks: NonNullable<Parameters<typeof completedCoders>[1]> = {},
) {
  const { manager, sessions, wave, current, target, physical, authority } = await completedCoders(
    ctx,
    hooks,
  );
  if (hooks.canonicalPlan) {
    const prepared = await new LocalIntegrationPreparation({
      ...ctx,
      request: {
        ...ctx.scope,
        actionId: 'prepare-service-wave',
        workspaceId: 'integration',
        registration: {
          ...ctx.request,
          targets: [{ workspaceId: 'integration', purpose: 'integration' }],
        },
      },
      workspaces: manager,
      authority,
      state: ctx.store,
      assertControl: async () => {
        await ctx.control.assertClosed(ctx.scope);
        await hooks.assertControl?.();
      },
    }).prepare(
      current,
      planIntegrationWave(current, {
        waveId: wave.waveId,
        workerIds: wave.coderWorkerIds,
        baseBranch: wave.base.branch,
      }),
    );
    const integration = prepared.state.integration;
    if (!integration) throw Error('missing prepared integration');
    const sources = new LocalIntegrationSources({ authority, sessions, workspaces: manager });
    return {
      manager,
      sessions,
      wave,
      integration,
      target,
      physical,
      authority,
      call: prepared.call,
      sources,
    };
  }
  const integration = {
    integrationId: 'integration-sources',
    waveId: wave.waveId,
    base: wave.base,
    integrationWorktree: {
      path: physical.path,
      branch: target.branch,
      baseCommit: target.baseCommit,
      headCommit: target.baseCommit,
    },
    pendingBranches: wave.coderWorkerIds
      .map((workerId) => {
        const worker = current.workers.find((w) => w.workerId === workerId);
        if (!worker?.subtaskId || typeof worker.worktree !== 'object')
          throw Error('missing worker');
        return {
          workerId,
          subtaskId: worker.subtaskId,
          worktree: worker.worktree,
          topologicalRank: 0,
        };
      })
      .sort((a, b) => a.workerId.localeCompare(b.workerId)),
    mergedBranches: [],
    conflicts: [],
    status: 'merging' as const,
  };
  await ctx.store.commit(ctx.scope, [
    setMutation('phase', 'integrating'),
    setMutation('integration', integration),
  ]);
  const call = await authority.acquire({
    ...ctx.scope,
    actionId: 'claim-sources',
    workspaceId: 'integration',
    integrationId: integration.integrationId,
    expectedRevision: (await ctx.control.snapshot()).revision,
  });
  const sources = new LocalIntegrationSources({ authority, sessions, workspaces: manager });
  return { manager, sessions, wave, integration, target, physical, authority, call, sources };
}
