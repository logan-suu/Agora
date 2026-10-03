// Actual native inspection and shared registry admission, without substituted
// root identities or task snapshots. No additional Harness run is needed here.
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInitialAppState, parseWorkspaceControl } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { LocalGrantController } from '../../../packages/runtime/sandbox/src/local-grant-controller';
import { hash, manifestBytes } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { nativeRangeFixture } from './local-range-native-fixture';

it.each([
  { projectId: 'project', nested: false },
  { projectId: 'another-project', nested: false },
  { projectId: 'another-project', nested: true },
])(
  'refuses a second task grant over an enrolled physical root ($projectId, nested=$nested)',
  async ({ projectId, nested }) =>
    nativeRangeFixture(
      async (ctx) => {
        const scope = { projectId, taskId: 'another-task' };
        await ctx.store.initialize(
          scope,
          createInitialAppState(scope.taskId, 'Conflicting root admission', scope.projectId),
        );
        const path = nested ? join(ctx.root.path, 'nested') : ctx.root.path;
        if (nested) mkdirSync(path);
        const controller = await LocalGrantController.open(
          ctx.owner,
          ctx.control,
          ctx.store,
          ctx.gitOptions.helpers.inspector,
          async () => ({
            version: 'seatbelt-apfs-v1',
            actions: ['read', 'edit', 'run'],
            toolchain: { manifestHash: hash(manifestBytes) },
            network: { mode: 'disabled' },
            outputs: { kind: 'private-per-operation' },
          }),
        );
        const registry = await ctx.control.snapshot();
        const before = await ctx.store.load(scope);
        const original = readFileSync(join(ctx.root.path, 'file.txt'));
        const proposal = await controller.prepareGrant(scope, {
          selectionRef: 'another-selection',
          path,
        });
        const display = `/workspace grant ${JSON.stringify({
          ...scope,
          actionId: 'another-grant',
          expectedRevision: proposal.proposal.expectedRevision,
          selectionRef: 'another-selection',
          policyProposalId: proposal.policyProposalId,
          inputHash: proposal.inputHash,
        })}`;
        await expect(
          controller.commit(scope, {
            msgId: 'another-grant',
            channelId: 'main',
            fromRole: 'leader',
            type: 'chat',
            display,
            ts: 5,
            payload: {
              kind: 'leader_intent',
              intent: parseWorkspaceControl(display),
              action: { status: 'applied' },
            },
          }),
        ).rejects.toThrow('workspace_root_conflict');
        expect(await ctx.control.snapshot()).toEqual(registry);
        expect(await ctx.store.load(scope)).toEqual(before);
        expect(readFileSync(join(ctx.root.path, 'file.txt'))).toEqual(original);
      },
      'Real cross-task root rejection',
      true,
    ),
  30000,
);

it(
  'refuses a symlink selector alias before creating a second grant or binding',
  async () =>
    nativeRangeFixture(
      async (ctx) => {
        const scope = { projectId: 'another-project', taskId: 'another-task' };
        await ctx.store.initialize(
          scope,
          createInitialAppState(scope.taskId, 'Alias admission', scope.projectId),
        );
        const path = join(dirname(ctx.root.path), 'root-alias');
        symlinkSync(ctx.root.path, path);
        const controller = await LocalGrantController.open(
          ctx.owner,
          ctx.control,
          ctx.store,
          ctx.gitOptions.helpers.inspector,
          async () => ({
            version: 'seatbelt-apfs-v1',
            actions: ['read', 'edit', 'run'],
            toolchain: { manifestHash: hash(manifestBytes) },
            network: { mode: 'disabled' },
            outputs: { kind: 'private-per-operation' },
          }),
        );
        const registry = await ctx.control.snapshot();
        const before = await ctx.store.load(scope);
        await expect(
          controller.prepareGrant(scope, { selectionRef: 'alias-selection', path }),
        ).rejects.toThrow('unsupported_workspace');
        expect(await ctx.control.snapshot()).toEqual(registry);
        expect(await ctx.store.load(scope)).toEqual(before);
      },
      'Real symlink alias rejection',
      true,
    ),
  30000,
);
