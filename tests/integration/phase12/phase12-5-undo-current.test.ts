// Real fixed roots, full native versions, private objects and managed Git reads.
// This only verifies candidate inputs; it never launches a model or writes U.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { withLocalGitSession } from '../../../packages/runtime/sandbox/src/local-git-session';
import { verifyLocalLinkedRoot } from '../../../packages/runtime/sandbox/src/local-linked-root';
import { LocalQuiescentWriters } from '../../../packages/runtime/sandbox/src/local-quiescent-writers';
import { LocalUndoCurrentSource } from '../../../packages/runtime/sandbox/src/local-undo-current-source';
import { nativeRangeFixture } from './local-range-native-fixture';

it(
  'captures full actual U and metadata without changing user HEAD/index, and rejects a stale confirmation',
  async () =>
    nativeRangeFixture(async (ctx) => {
      const writers = new LocalQuiescentWriters({
        ...ctx,
        activity: (scope) => ({ ...scope, activeWorkerIds: [], ...ctx.scheduler.activity(scope) }),
        capabilities: (scope) => ctx.sessions.rangeCapabilities(scope),
        operations: (scope) => ctx.sessions.rangeOperations(scope),
        workerClosure: async () => {
          throw Error('actual_worker_closure_required');
        },
        controlClosure: async () => {
          throw Error('actual_control_closure_required');
        },
        verifyClosure: async () => {
          throw Error('unexpected_closure');
        },
      });
      const source = new LocalUndoCurrentSource({
        ...ctx,
        writers,
        filesHelper: resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        inspector: ctx.gitOptions.helpers.inspector,
        fingerprint: (state) => ({ goal: state.goal, requirements: state.requirements }),
        metadata: async (scope, registry) => {
          const workspace = registry.workspaces.find((w) => w.workspaceId === scope.workspaceId),
            record = registry.linkedRoots?.find((r) => r.workspaceId === scope.workspaceId);
          if (workspace?.mode !== 'linked-worktree' || !record) throw Error('missing owned Git');
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
          return withLocalGitSession(
            {
              ...ctx.gitOptions,
              ...ctx.scope,
              root: ctx.root.path,
              actionId: 'undo-metadata',
              authorize: async () => {
                await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
                return true;
              },
            },
            async (session) => {
              const proof = {
                source: session.initialUserState,
                sourceHead: session.sourceHead,
                marker: session.readLinked(record.path, 'marker'),
                linked: session.readLinked(record.metadata.path, 'linked'),
              };
              await session.check();
              return proof;
            },
          );
        },
      });
      const registry = await ctx.control.snapshot(),
        record = registry.linkedRoots?.find((r) => r.workspaceId === 'coding');
      if (!record) throw Error('missing actual root');
      const target = join(record.path, 'file.txt'),
        index = readFileSync(join(ctx.root.path, '.git/index')),
        before = await source.capture({ ...ctx.scope, workspaceId: 'coding' });
      expect(before.tree.files.find((f) => f.path === 'file.txt')?.content).toEqual(
        readFileSync(target),
      );
      expect(before.tree.directories[0]?.metadata).toMatch(/^\d+:\d+:\d+:[a-f0-9]{64}$/);
      expect(await source.read(before.hash)).toEqual(before.record);
      await source.verifyCurrent(before.hash);
      writeFileSync(target, 'later independent U\n');
      await expect(source.verifyCurrent(before.hash)).rejects.toThrow();
      expect(readFileSync(target, 'utf8')).toBe('later independent U\n');
      expect(readFileSync(join(ctx.root.path, '.git/index'))).toEqual(index);
      const history = await source.read(before.hash);
      expect(history.version).toEqual(before.record.version);
    }),
  120_000,
);
