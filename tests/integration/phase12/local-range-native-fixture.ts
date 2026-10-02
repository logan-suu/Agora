// Real native registry, fixed-root versions, capabilities and lease inventory.
// Active closure uses an explicitly bound real WorkerRuntime and official reader.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeByIdMutation } from '@agora/core-domain';
import { GlobalScheduler, type WorkerRuntime } from '@agora/core-orchestration';
import { readHarnessSafePointEvidence } from '@agora/runtime-executor';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { verifyLocalLinkedRoot } from '../../../packages/runtime/sandbox/src/local-linked-root';
import { LocalNativeRangeSources } from '../../../packages/runtime/sandbox/src/local-native-range-sources';
import { LocalRangeController } from '../../../packages/runtime/sandbox/src/local-range-controller';
import { LocalRangeReturnController } from '../../../packages/runtime/sandbox/src/local-range-return-controller';
import { LocalRangeReturnEvidence } from '../../../packages/runtime/sandbox/src/local-range-return-evidence';
import { LocalRangeWorkerEvidence } from '../../../packages/runtime/sandbox/src/local-range-worker-evidence';
import { LocalRangeWritersEvidence } from '../../../packages/runtime/sandbox/src/local-range-writers-evidence';
import { LocalWorkspaceAuthority } from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import {
  fixture,
  hash,
  manifest,
  manifestBytes,
  toolchainRoot,
} from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';
export async function nativeRangeFixture(
  work: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  goal = 'Real linked registration',
  direct = false,
  independent = false,
) {
  return fixture(async (f) =>
    registeredFixture(
      f,
      async (ctx) => work(await setup(ctx, direct, independent)),
      false,
      false,
      goal,
      direct,
    ),
  );
}
async function setup(
  ctx: Parameters<Parameters<typeof registeredFixture>[1]>[0],
  direct: boolean,
  independent: boolean,
) {
  if (independent) {
    if (direct) throw Error('independent_fixture_requires_linked_roots');
    await ctx.store.commit(ctx.scope, [
      mergeByIdMutation('subtasks', 'independent', {
        title: 'Read only the fixed file.txt in your independent workspace',
        ownerRole: 'CODER',
        status: 'in_progress',
        dependsOn: [],
      }),
      mergeByIdMutation('workers', 'independent', {
        role: 'CODER',
        executor: 'harness',
        status: 'pending',
        subtaskId: 'independent',
        startedTs: 1,
      }),
    ]);
    ctx.request.targets.push({
      workspaceId: 'independent-coding',
      purpose: 'coding',
      workerId: 'independent',
    });
  }
  if (direct)
    await new LocalWorkspaceAuthority(
      ctx.control,
      ctx.roots,
      ctx.versions,
      () => {
        throw Error('registration_must_not_execute');
      },
      ctx.verifyGrant,
    ).register({
      ...ctx.scope,
      actionId: 'register-direct',
      rootId: ctx.root.rootId,
      grantId: ctx.grant.grantId,
      workspaceId: 'coding',
      workerId: 'coder',
      subtaskId: 'code',
      version: ctx.request.version,
      expectedRevision: (await ctx.control.snapshot()).revision,
    });
  else await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
  const sessions = await LocalWorkspaceSessions.create({
    ...ctx,
    filesHelper: resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
    grantForAssignment: async () => ctx.grant.grantId,
    gitOptions: ctx.gitOptions,
    tools: {
      manifestHash: hash(manifestBytes),
      node: {
        path: join(toolchainRoot, 'node/bin/node'),
        sha256: hash(readFileSync(join(toolchainRoot, 'node/bin/node'))),
        version: manifest.versions.node,
      },
      bootstrap: {
        path: resolve('packages/runtime/sandbox/build/local-command-bootstrap-darwin-arm64'),
        sha256: hash(
          readFileSync(
            resolve('packages/runtime/sandbox/build/local-command-bootstrap-darwin-arm64'),
          ),
        ),
      },
      processControl: {
        path: resolve('packages/runtime/sandbox/build/local-process-control-darwin-arm64'),
        sha256: hash(
          readFileSync(
            resolve('packages/runtime/sandbox/build/local-process-control-darwin-arm64'),
          ),
        ),
      },
    },
  });
  const scheduler = new GlobalScheduler();
  let runtime: WorkerRuntime | undefined;
  const sessionRoot = join(
    ctx.owner.root,
    'projects',
    ctx.scope.projectId,
    'tasks',
    ctx.scope.taskId,
    'harness-sessions',
  );
  const workerEvidence = new LocalRangeWorkerEvidence({
    ...ctx,
    tasks: ctx.store,
    runtime: (scope) =>
      scope.projectId === ctx.scope.projectId && scope.taskId === ctx.scope.taskId
        ? runtime
        : undefined,
    native: (scope) => sessions.rangeBoundary(scope),
    official: async (scope) => {
      const state = await ctx.store.load(scope),
        role = state?.workers.find((w) => w.workerId === scope.workerId)?.role;
      if (!role) throw Error('missing actual worker');
      return readHarnessSafePointEvidence(scope.safePointRef, {
        root: sessionRoot,
        cwd: ctx.root.path,
        projectId: scope.projectId,
        taskId: scope.taskId,
        role,
      });
    },
  });
  const writers = new LocalRangeWritersEvidence({
    ...ctx,
    tasks: ctx.store,
    capabilities: (s) => sessions.rangeCapabilities(s),
    activity: (s) =>
      runtime?.rangeActivity(s) ?? { ...s, activeWorkerIds: [], ...scheduler.activity(s) },
    operations: (s) => sessions.rangeOperations(s),
    controlWriter: async () => {
      throw Error('unexpected_control_writer');
    },
  });
  const sources = new LocalNativeRangeSources({
    ...ctx,
    tasks: ctx.store,
    inspector: ctx.gitOptions.helpers.inspector,
    verifyLinked: async (plan, registry) => {
      const workspace = registry.workspaces.find((w) => w.workspaceId === plan.workspaceId),
        record = registry.linkedRoots?.find((r) => r.workspaceId === plan.workspaceId);
      if (workspace?.mode !== 'linked-worktree' || !record) throw Error('missing linked binding');
      await verifyLocalLinkedRoot({
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
      });
    },
    verifyWorkerClosure: (plan, proof) => workerEvidence.verify(plan, proof),
    verifyWritersClosure: (plan, proof, targets) => writers.verify(plan, proof, targets),
  });
  const controller = new LocalRangeController({
    ...ctx,
    tasks: ctx.store,
    sources,
    lifecycle: {
      closeWorkers: (h, s) =>
        h.plan.cohort.length ? workerEvidence.closeWorkers(h, s) : Promise.resolve([]),
      proveWriters: (h, s, w) => writers.prove(h, s, w),
    },
  });
  const evidence = new LocalRangeReturnEvidence({ ...ctx, tasks: ctx.store, sources, writers });
  const returns = new LocalRangeReturnController({ ...ctx, tasks: ctx.store, evidence });
  return {
    ...ctx,
    sessions,
    workerEvidence,
    scheduler,
    writers,
    sources,
    controller,
    evidence,
    returns,
    sessionRoot,
    bindRuntime: (value: WorkerRuntime) => {
      if (runtime && runtime !== value) {
        const activity = runtime.rangeActivity(ctx.scope);
        if (
          activity.activeWorkerIds.length ||
          activity.leasedWorkerIds.length ||
          activity.queuedWorkerIds.length
        )
          throw Error('previous_runtime_not_closed');
      }
      runtime = value;
    },
  };
}
