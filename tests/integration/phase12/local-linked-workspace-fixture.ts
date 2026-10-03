// Real local grant, registry and linked-worktree test setup; no substituted infrastructure.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeByIdMutation } from '@agora/core-domain';
import {
  binary,
  type fixture,
  hash,
  manifestBytes,
  metadataHelper,
} from '../../../packages/runtime/sandbox/test/local-git-fixture';

export async function registeredFixture(
  f: Parameters<Parameters<typeof fixture>[0]>[0],
  run: (ctx: Awaited<ReturnType<typeof registrationContext>>) => Promise<void>,
  blank = false,
  remove = false,
  goal = 'Real linked registration',
  coderOnly = false,
) {
  const { acquireState } = await import('../../../apps/desktop/src/storage');
  const owner = await acquireState(join(f.base, 'state'));
  try {
    await run(await registrationContext(f, owner, blank, remove, goal, coderOnly));
  } finally {
    await owner.release();
  }
}
export async function registrationContext(
  f: Parameters<Parameters<typeof fixture>[0]>[0],
  owner: Awaited<ReturnType<typeof import('../../../apps/desktop/src/storage')['acquireState']>>,
  blank = false,
  remove = false,
  goal = 'Real linked registration',
  coderOnly = false,
) {
  const { createInitialAppState, parseWorkspaceControl } = await import('@agora/core-domain');
  const { JsonTaskStateStore } = await import('@agora/runtime-state');
  const { LocalBindingCoordinator } = await import(
    '../../../packages/runtime/sandbox/src/local-binding-coordinator'
  );
  const { LocalGrantController } = await import(
    '../../../packages/runtime/sandbox/src/local-grant-controller'
  );
  const { LocalRootCoordinator } = await import(
    '../../../packages/runtime/sandbox/src/local-root-coordinator'
  );
  const { LocalControlObjects } = await import(
    '../../../packages/runtime/sandbox/src/local-control-objects'
  );
  const { LocalVersionStore } = await import(
    '../../../packages/runtime/sandbox/src/local-version-store'
  );
  const { localRootBinding } = await import(
    '../../../packages/runtime/sandbox/src/local-workspace-authority'
  );
  const scope = { projectId: 'project', taskId: 'task' };
  const store = new JsonTaskStateStore(join(owner.root, 'tasks'));
  const initial = createInitialAppState(scope.taskId, goal, scope.projectId);
  if (!blank)
    initial.subtasks.push({
      id: 'code',
      title: 'Code',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'todo',
    });
  if (!blank)
    initial.workers.push(
      ...(coderOnly ? (['CODER'] as const) : (['CODER', 'TESTER'] as const)).map((role) => ({
        workerId: role.toLowerCase(),
        role,
        executor: 'harness' as const,
        status: 'pending' as const,
        subtaskId: 'code',
        startedTs: 1,
      })),
    );
  await store.initialize(scope, initial);
  const control = await LocalBindingCoordinator.open(owner, store, true);
  const helpers = {
    inspector: resolve('packages/runtime/sandbox/build/local-root-inspection-darwin-arm64'),
    initializer: resolve('packages/runtime/sandbox/build/local-root-initialization-darwin-arm64'),
  };
  const controller = await LocalGrantController.open(
    owner,
    control,
    store,
    helpers.inspector,
    async () => ({
      version: 'seatbelt-apfs-v1',
      actions: ['read', 'edit', 'run', ...(remove ? ['remove' as const] : [])],
      toolchain: { manifestHash: hash(manifestBytes) },
      network: { mode: 'disabled' },
      outputs: { kind: 'private-per-operation' },
    }),
  );
  const proposal = await controller.prepareGrant(scope, {
    selectionRef: 'selection',
    path: f.root,
  });
  const intent = {
    ...scope,
    actionId: 'grant',
    expectedRevision: proposal.proposal.expectedRevision,
    selectionRef: 'selection',
    policyProposalId: proposal.policyProposalId,
    inputHash: proposal.inputHash,
  };
  await controller.commit(scope, {
    msgId: 'grant',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(`/workspace grant ${JSON.stringify(intent)}`),
      action: { status: 'applied' },
    },
    display: `/workspace grant ${JSON.stringify(intent)}`,
    ts: 1,
  });
  const grant = (await control.snapshot()).grants[0];
  if (!grant) throw Error('missing grant');
  const roots = await LocalRootCoordinator.open(owner, control, helpers);
  await roots.initialize({
    ...scope,
    actionId: 'initialize',
    rootId: grant.rootId,
    grantId: grant.grantId,
    expectedRevision: (await control.snapshot()).revision,
  });
  const root = (await control.snapshot()).roots[0];
  if (!root) throw Error('missing root');
  const objects = await LocalControlObjects.open(owner);
  const versions = new LocalVersionStore(
    objects,
    resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
  );
  const versionScope = { ...scope, rootId: root.rootId, policyHash: grant.policyHash };
  const verifyGrant = (s: typeof scope, id: string) => controller.assertGrant(s, id);
  const version = await versions.capture(versionScope, localRootBinding(root), async () => {
    await verifyGrant(scope, grant.grantId);
    return true;
  });
  const journalRoot = join(f.base, 'linked-initializations');
  mkdirSync(journalRoot, { mode: 0o700 });
  const gitOptions = {
    privateRoot: f.privateRoot,
    git: binary,
    metadataHelper,
    helpers,
    journalRoot,
  };
  const request = {
    ...scope,
    actionId: 'register',
    rootId: root.rootId,
    grantId: grant.grantId,
    expectedRevision: (await control.snapshot()).revision,
    version,
    targets: [
      { workspaceId: 'integration', purpose: 'integration' as const },
      { workspaceId: 'coding', purpose: 'coding' as const, workerId: 'coder' },
      { workspaceId: 'testing', purpose: 'validation' as const, workerId: 'tester' },
    ],
  };
  return {
    owner,
    scope,
    store,
    control,
    roots,
    objects,
    versions,
    versionScope,
    root,
    grant,
    verifyGrant,
    gitOptions,
    request,
  };
}

export async function prepareIntegration(ctx: Awaited<ReturnType<typeof registrationContext>>) {
  const { LocalGitWorkspaces } = await import(
    '../../../packages/runtime/sandbox/src/local-git-workspaces'
  );
  const refs = await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
  const target = refs.find((r) => r.purpose === 'integration');
  const physical = (await ctx.control.snapshot()).linkedRoots?.find(
    (r) => r.workspaceId === target?.workspaceId,
  );
  if (target?.mode !== 'linked-worktree' || !physical) throw Error('missing target');
  const coder = refs.find((r) => r.purpose === 'coding');
  const codingPhysical = (await ctx.control.snapshot()).linkedRoots?.find(
    (r) => r.workspaceId === coder?.workspaceId,
  );
  if (coder?.mode !== 'linked-worktree' || !codingPhysical) throw Error('missing coder');
  const worktree = {
    path: codingPhysical.path,
    branch: coder.branch,
    baseCommit: coder.baseCommit,
    headCommit: coder.baseCommit,
  };
  const integration = {
    integrationId: 'integration-test',
    waveId: 'wave-test',
    base: { branch: 'main', commit: target.baseCommit },
    integrationWorktree: {
      path: physical.path,
      branch: target.branch,
      baseCommit: target.baseCommit,
      headCommit: target.baseCommit,
    },
    pendingBranches: [{ workerId: 'coder', subtaskId: 'code', worktree, topologicalRank: 0 }],
    mergedBranches: [],
    conflicts: [],
    status: 'merging' as const,
  };
  await ctx.store.commit(ctx.scope, [
    mergeByIdMutation('workers', 'coder', { status: 'done', worktree }),
    { op: 'set', field: 'integration', value: integration },
  ]);
  return {
    ctx,
    physical,
    integration,
    request: {
      ...ctx.scope,
      actionId: 'claim-integration',
      workspaceId: target.workspaceId,
      integrationId: integration.integrationId,
      expectedRevision: (await ctx.control.snapshot()).revision,
    },
  };
}

export async function firstCodingWave(
  ctx: Awaited<ReturnType<typeof registrationContext>>,
  options: { singleWorker?: boolean } = {},
) {
  const { LocalGitWorkspaces } = await import(
    '../../../packages/runtime/sandbox/src/local-git-workspaces'
  );
  const { LocalGitVersionStore } = await import(
    '../../../packages/runtime/sandbox/src/local-git-version-store'
  );
  const { setMutation } = await import('@agora/core-domain');
  const { decide } = await import('@agora/core-orchestration');
  const manager = new LocalGitWorkspaces(ctx);
  const [workspace] = await manager.registerInitial({
    ...ctx.request,
    targets: [{ workspaceId: 'integration', purpose: 'integration' as const }],
  });
  const record = (await ctx.control.snapshot()).linkedRoots?.find(
    (r) => r.workspaceId === workspace?.workspaceId,
  );
  if (workspace?.mode !== 'linked-worktree' || !record) throw Error('missing baseline');
  const version = await new LocalGitVersionStore(ctx.objects, ctx.versions).capture(
    ctx.versionScope,
    {
      ...ctx.gitOptions,
      ...ctx.scope,
      root: ctx.root.path,
      sourceRoot: ctx.root,
      workspace,
      record,
      expectedHead: workspace.baseCommit,
      actionId: record.initialization.actionId,
      creationActionId: record.creation.actionId,
      bindingReceiptId: record.bindingReceiptId,
      authorize: async () => {
        await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
        return true;
      },
    },
  );
  await ctx.store.commit(ctx.scope, [
    setMutation('phase', 'planning'),
    setMutation('complexity', { tier: 2, signals: {} }),
    setMutation('architecture', {
      executionPlan: {
        version: 1,
        subtasks: options.singleWorker
          ? [{ id: 'A', title: 'First', dependsOn: [] }]
          : [
              { id: 'A', title: 'First', dependsOn: [] },
              { id: 'B', title: 'Second', dependsOn: [] },
              { id: 'C', title: 'Dependent', dependsOn: ['A', 'B'] },
            ],
      },
    }),
  ]);
  let sequence = 0;
  const decision = decide(await ctx.control.assertClosed(ctx.scope), {
    newId: () => `wave-control-${++sequence}`,
    now: () => 10,
    parallel: {
      initialBase: { branch: workspace.branch, commit: workspace.baseCommit },
      controlFingerprint: 'f'.repeat(64),
    },
  });
  const state = (await ctx.store.commit(ctx.scope, decision.mutations)).state;
  const wave = state.parallelExecution?.activeWave;
  if (!wave) throw Error('missing wave');
  return {
    manager,
    state,
    record,
    request: {
      ...ctx.request,
      actionId: 'register-wave',
      expectedRevision: (await ctx.control.snapshot()).revision,
      version,
      sourceWorkspaceId: workspace.workspaceId,
      waveId: wave.waveId,
      attempt: wave.attempt,
      targets: wave.coderWorkerIds.map((workerId, i) => ({
        workspaceId: `wave-coder-${i}`,
        purpose: 'coding' as const,
        workerId,
      })),
    },
  };
}
