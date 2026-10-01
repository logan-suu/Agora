// Real owned Git worktree and native file manifest prove the command input;
// no model, command runner or mock may supply the version qualification.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeByIdMutation } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { expect, it } from 'vitest';
import { localGitValidationCommand } from '../../../apps/web/src/server/local-validation-command';
import { LocalFixedInputs } from '../../../packages/runtime/sandbox/src/local-fixed-inputs';
import { LocalGitVersionStore } from '../../../packages/runtime/sandbox/src/local-git-version-store';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { LocalWorkspaceApply } from '../../../packages/runtime/sandbox/src/local-workspace-apply';
import { LocalWorkspaceAuthority } from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { LocalWorkspaceCommands } from '../../../packages/runtime/sandbox/src/local-workspace-commands';
import { LocalWorkspaceFiles } from '../../../packages/runtime/sandbox/src/local-workspace-files';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';
import {
  fixture,
  hash,
  manifest,
  manifestBytes,
  toolchainRoot,
} from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { registeredFixture } from './local-linked-workspace-fixture';

it('qualifies the exact live linked Git manifest before a fixed command can use it', async () => {
  await fixture(async (f) =>
    registeredFixture(f, async (ctx) => {
      await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
      const registry = await ctx.control.snapshot();
      const claim = registry.claims.find((item) => item.workerId === 'coder');
      const workspace = registry.workspaces.find((item) => item.workspaceId === claim?.workspaceId);
      const record = registry.linkedRoots?.find((item) => item.workspaceId === claim?.workspaceId);
      if (!claim || workspace?.mode !== 'linked-worktree' || !record)
        throw Error('missing linked coding workspace');
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', 'coder', {
          status: 'running',
          worktree: {
            path: record.path,
            branch: workspace.branch,
            baseCommit: workspace.baseCommit,
          },
        }),
      ]);
      const userHead = f.git(['rev-parse', 'HEAD']);
      const userIndex = readFileSync(join(f.root, '.git/index'));
      const scheduler = new GlobalScheduler();
      const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'coder');
      const call = {
        ...ctx.scope,
        workspaceId: workspace.workspaceId,
        workerId: 'coder',
        actionId: 'fixed-git-validation-version',
        grantRevision: ctx.grant.revision,
        writerEpoch: claim.writerEpoch,
      };
      const authority = new LocalWorkspaceAuthority(
        ctx.control,
        ctx.roots,
        ctx.versions,
        () => scheduler.assertActive(lease),
        ctx.verifyGrant,
        undefined,
        ctx.gitOptions,
      );
      try {
        const scope = {
          ...ctx.scope,
          rootId: ctx.root.rootId,
          policyHash: ctx.grant.policyHash,
        };
        const version = await new LocalGitVersionStore(ctx.objects, ctx.versions).capture(scope, {
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
            scheduler.assertActive(lease);
            await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
            return true;
          },
        });
        expect(version.kind).toBe('git');
        await authority.verifyCommandGitVersion(call, version, ctx.objects);
        await expect(
          authority.verifyCommandGitVersion(
            call,
            { ...version, kind: 'git', commit: 'f'.repeat(40) },
            ctx.objects,
          ),
        ).rejects.toThrow();
        const linkedFile = join(record.path, 'file.txt');
        const originalBytes = readFileSync(linkedFile);
        writeFileSync(linkedFile, 'modified after fixed manifest\n');
        await expect(
          authority.verifyCommandGitVersion(call, version, ctx.objects),
        ).rejects.toThrow();
        writeFileSync(linkedFile, originalBytes);
        await authority.verifyCommandGitVersion(call, version, ctx.objects);
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', 'coder', { status: 'done' }),
        ]);
        await expect(
          authority.verifyCommandGitVersion(call, version, ctx.objects),
        ).rejects.toThrow();
        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
      } finally {
        await scheduler.release(lease);
      }
    }),
  );
}, 180_000);

it('opens the host-only TESTER command after the session commits and persists its HEAD', async () => {
  await fixture(async (f) =>
    registeredFixture(f, async (ctx) => {
      await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
      const registry = await ctx.control.snapshot();
      const claim = registry.claims.find((item) => item.workerId === 'tester');
      const workspace = registry.workspaces.find((item) => item.workspaceId === claim?.workspaceId);
      const record = registry.linkedRoots?.find((item) => item.workspaceId === claim?.workspaceId);
      if (!claim || workspace?.mode !== 'linked-worktree' || !record)
        throw Error('missing linked validation workspace');
      const userHead = f.git(['rev-parse', 'HEAD']);
      const userIndex = readFileSync(join(f.root, '.git/index'));
      writeFileSync(
        join(record.path, 'session.test.cjs'),
        "const { test } = require('node:test'); const { strictEqual } = require('node:assert'); test('session', () => strictEqual(3 * 3, 9));\n",
      );
      writeFileSync(
        join(record.path, 'session-extra.test.cjs'),
        "const { test } = require('node:test'); const { strictEqual } = require('node:assert'); test('extra', () => strictEqual(4 + 4, 8));\n",
      );
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', 'tester', {
          status: 'running',
          worktree: {
            path: record.path,
            branch: workspace.branch,
            baseCommit: workspace.baseCommit,
          },
        }),
      ]);
      const scheduler = new GlobalScheduler();
      const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'tester');
      const tool = (name: string) => {
        const path = resolve(`packages/runtime/sandbox/build/${name}-darwin-arm64`);
        return { path, sha256: hash(readFileSync(path)) };
      };
      const node = join(toolchainRoot, 'node/bin/node');
      const sessions = await LocalWorkspaceSessions.create({
        owner: ctx.owner,
        control: ctx.control,
        roots: ctx.roots,
        objects: ctx.objects,
        versions: ctx.versions,
        filesHelper: resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        tools: {
          manifestHash: hash(manifestBytes),
          node: { path: node, sha256: hash(readFileSync(node)), version: manifest.versions.node },
          bootstrap: tool('local-command-bootstrap'),
          processControl: tool('local-process-control'),
        },
        gitOptions: ctx.gitOptions,
        verifyGrant: ctx.verifyGrant,
        grantForAssignment: async () => ctx.grant.grantId,
      });
      let session: Awaited<ReturnType<typeof sessions.open>> | undefined;
      try {
        session = await sessions.open({
          ...ctx.scope,
          workerId: 'tester',
          role: 'TESTER',
          subtaskId: 'code',
          sessionId: 'fixed-git-test-session',
          assertLease: () => scheduler.assertActive(lease),
        });
        if (
          !session.completeWorktree ||
          !session.inspectCommittedGit ||
          !session.runFixedGitValidation
        )
          throw Error('missing host-only validation capability');
        await expect(
          session.runFixedGitValidation('before-worker-commit', {
            toolId: 'node',
            argv: ['--test', '--test-reporter=tap', '@input/session.test.cjs'],
            inputVersion: ctx.request.version,
            outputRoot: 'private-per-operation',
            networkGrantId: null,
            timeoutMs: 30000,
          }),
        ).rejects.toThrow('workspace_validation_commit_required');
        await session.checkpoint('complete');
        const committed = await session.completeWorktree();
        expect(committed.headCommit).toMatch(/^[a-f0-9]{40}$/);
        await expect(session.inspectCommittedGit('before-head-persistence')).rejects.toThrow();
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', 'tester', { worktree: committed }),
        ]);
        const inspection = await session.inspectCommittedGit('committed-head-inspection');
        expect(inspection.version).toMatchObject({ kind: 'git', commit: committed.headCommit });
        const request = localGitValidationCommand(inspection, committed.headCommit as string);
        expect(request.argv).toEqual([
          '--test',
          '--test-reporter=tap',
          '@input/session-extra.test.cjs',
          '@input/session.test.cjs',
        ]);
        const run = await session.runFixedGitValidation('session-fixed-git-validation', request);
        expect(run.stage).toBe('exited');
        expect(run.exitCode).toBe(0);
        expect(run.quiescent).toBe(true);
        expect(run.stdout).toContain('# pass 2');
        const repeated = await session.runFixedGitValidation(
          'session-fixed-git-validation-repeat',
          request,
        );
        expect(repeated).toMatchObject({ stage: 'exited', exitCode: 0, quiescent: true });
        expect(repeated.stdout).toContain('# pass 2');
        expect(
          (
            await sessions.verifyCommand(
              { ...ctx.scope, workspaceId: workspace.workspaceId },
              run.receiptId,
            )
          ).request,
        ).toEqual(request);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
      } finally {
        await session?.close();
        await scheduler.release(lease);
      }
    }),
  );
}, 180_000);

it('runs only the complete fixed TESTER command against a committed linked Git version', async () => {
  await fixture(async (f) =>
    registeredFixture(f, async (ctx) => {
      await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
      const registry = await ctx.control.snapshot();
      const claim = registry.claims.find((item) => item.workerId === 'tester');
      const workspace = registry.workspaces.find((item) => item.workspaceId === claim?.workspaceId);
      const record = registry.linkedRoots?.find((item) => item.workspaceId === claim?.workspaceId);
      if (!claim || workspace?.mode !== 'linked-worktree' || !record)
        throw Error('missing linked validation workspace');
      const userHead = f.git(['rev-parse', 'HEAD']);
      const userIndex = readFileSync(join(f.root, '.git/index'));
      writeFileSync(
        join(record.path, 'fixed.test.cjs'),
        "const { test } = require('node:test'); const { strictEqual } = require('node:assert'); test('fixed', () => strictEqual(2 + 2, 4));\n",
      );
      f.git(['-C', record.path, 'add', 'fixed.test.cjs']);
      f.git(['-C', record.path, 'commit', '-qm', 'Add fixed validation test']);
      const head = f.git(['-C', record.path, 'rev-parse', 'HEAD']);
      await ctx.store.commit(ctx.scope, [
        mergeByIdMutation('workers', 'tester', {
          status: 'running',
          worktree: {
            path: record.path,
            branch: workspace.branch,
            baseCommit: workspace.baseCommit,
            headCommit: head,
          },
        }),
      ]);
      const scheduler = new GlobalScheduler();
      const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, 'tester');
      const call = {
        ...ctx.scope,
        workspaceId: workspace.workspaceId,
        workerId: 'tester',
        actionId: 'fixed-git-validation-run',
        grantRevision: ctx.grant.revision,
        writerEpoch: claim.writerEpoch,
      };
      const authority = new LocalWorkspaceAuthority(
        ctx.control,
        ctx.roots,
        ctx.versions,
        () => scheduler.assertActive(lease),
        ctx.verifyGrant,
        undefined,
        ctx.gitOptions,
      );
      const scope = { ...ctx.versionScope };
      const git = new LocalGitVersionStore(ctx.objects, ctx.versions);
      try {
        const version = await git.capture(scope, {
          ...ctx.gitOptions,
          ...ctx.scope,
          root: ctx.root.path,
          sourceRoot: ctx.root,
          workspace,
          record,
          expectedHead: head,
          actionId: record.initialization.actionId,
          creationActionId: record.creation.actionId,
          bindingReceiptId: record.bindingReceiptId,
          authorize: async () => {
            scheduler.assertActive(lease);
            await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
            return true;
          },
        });
        const files = new LocalWorkspaceFiles(
          authority,
          ctx.objects,
          resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        );
        const writer = await LocalWorkspaceApply.open(
          ctx.owner,
          authority,
          ctx.objects,
          files,
          resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        );
        const tool = (name: string) => {
          const path = resolve(`packages/runtime/sandbox/build/${name}-darwin-arm64`);
          return { path, sha256: hash(readFileSync(path)) };
        };
        const node = join(toolchainRoot, 'node/bin/node');
        const commands = await LocalWorkspaceCommands.open(
          ctx.owner,
          authority,
          ctx.objects,
          ctx.versions,
          await LocalFixedInputs.open(ctx.owner, ctx.objects, ctx.versions),
          writer,
          {
            manifestHash: hash(manifestBytes),
            node: { path: node, sha256: hash(readFileSync(node)), version: manifest.versions.node },
            bootstrap: tool('local-command-bootstrap'),
            processControl: tool('local-process-control'),
          },
          resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        );
        const request = {
          toolId: 'node' as const,
          argv: ['--test', '--test-reporter=tap', '@input/fixed.test.cjs'],
          inputVersion: version,
          outputRoot: 'private-per-operation' as const,
          networkGrantId: null,
          timeoutMs: 30000,
        };
        await expect(
          commands.runCommand({ ...call, actionId: 'generic-git-denied' }, request),
        ).rejects.toThrow('invalid_workspace_command');
        await expect(
          commands.runFixedGitValidation(
            { ...call, actionId: 'incomplete-git-command' },
            {
              ...request,
              argv: ['--test'],
            },
          ),
        ).rejects.toThrow('invalid_local_validation_command');
        const result = await commands.runFixedGitValidation(call, request);
        expect(result.stage).toBe('exited');
        expect(result.quiescent).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('# pass 1');
        expect(result.inputVersion).toEqual(version);
        const verified = await commands.verifyCommand(
          { ...ctx.scope, workspaceId: workspace.workspaceId },
          result.receiptId,
        );
        expect(verified.request).toEqual(request);
        expect(verified.command.receiptId).toBe(result.receiptId);
        writeFileSync(join(record.path, 'file.txt'), 'TESTER changed business bytes\n');
        f.git(['-C', record.path, 'add', 'file.txt']);
        f.git(['-C', record.path, 'commit', '-qm', 'Change business bytes in validation']);
        const invalidHead = f.git(['-C', record.path, 'rev-parse', 'HEAD']);
        await ctx.store.commit(ctx.scope, [
          mergeByIdMutation('workers', 'tester', {
            worktree: {
              path: record.path,
              branch: workspace.branch,
              baseCommit: workspace.baseCommit,
              headCommit: invalidHead,
            },
          }),
        ]);
        await expect(
          authority.captureCommandGitVersion(
            { ...call, actionId: 'changed-business-git-denied' },
            ctx.objects,
          ),
        ).rejects.toThrow('local_validation_business_file_changed');
        expect(f.git(['rev-parse', 'HEAD'])).toBe(userHead);
        expect(readFileSync(join(f.root, '.git/index'))).toEqual(userIndex);
      } finally {
        await scheduler.release(lease);
      }
    }),
  );
}, 180_000);
