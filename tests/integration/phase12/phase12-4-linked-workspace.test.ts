// Real registry/Git/native/runtime integration. The dispatch case scripts only
// executor decisions; interruption cases wrap the actual canonical commit.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { CallId } from '@deepseek-ai/dsh-llm/brand';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { expect, it } from 'vitest';
import { fixture, hash } from '../../../packages/runtime/sandbox/test/local-git-fixture';
import { firstCodingWave, registeredFixture } from './local-linked-workspace-fixture';

it(
  'registers a real initial Git batch atomically and replays without creating workers or trees',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const { LocalGitWorkspaces } = await import(
          '../../../packages/runtime/sandbox/src/local-git-workspaces'
        );
        const manager = new LocalGitWorkspaces(ctx);
        const before = await ctx.store.load(ctx.scope);
        const head = f.git(['rev-parse', 'HEAD']),
          index = readFileSync(join(f.metadata, 'index'));
        const result = await manager.registerInitial(ctx.request);
        expect(result).toHaveLength(3);
        const state = await ctx.control.assertClosed(ctx.scope),
          snapshot = await ctx.control.snapshot();
        expect(state.workers).toEqual(before?.workers);
        expect(state.subtasks).toEqual(before?.subtasks);
        expect(state.localExecution?.git?.initialWorkspaceId).toBe('integration');
        expect(state.localExecution?.bindings.map((b) => b.workerId).sort()).toEqual([
          'coder',
          'tester',
        ]);
        expect(snapshot.linkedRoots).toHaveLength(3);
        expect(snapshot.claims.map((c) => c.workerId).sort()).toEqual(['coder', 'tester']);
        expect(new Set(snapshot.claims.map((c) => c.writerEpoch)).size).toBe(2);
        for (const record of snapshot.linkedRoots ?? []) {
          expect(readFileSync(join(record.path, 'file.txt'), 'utf8')).toBe('working\n');
          expect(record.rootId).toBe(ctx.root.rootId);
          expect(record.grantId).toBe(ctx.grant.grantId);
        }
        const privateFiles = readdirSync(f.privateRoot).sort();
        expect(await manager.registerInitial(ctx.request)).toEqual(result);
        expect(readdirSync(f.privateRoot).sort()).toEqual(privateFiles);
        expect((await ctx.control.snapshot()).revision).toBe(snapshot.revision);
        expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
        expect(readFileSync(join(f.metadata, 'index'))).toEqual(index);
        await expect(
          manager.registerInitial({ ...ctx.request, targets: ctx.request.targets.slice(0, 2) }),
        ).rejects.toThrow('operation_conflict');
      }),
    ),
  30_000,
);

it(
  'admits linked coder and tester calls only with physical proof, canonical HEAD and a live matching lease',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const { LocalGitWorkspaces } = await import(
          '../../../packages/runtime/sandbox/src/local-git-workspaces'
        );
        const { LocalWorkspaceAuthority } = await import(
          '../../../packages/runtime/sandbox/src/local-workspace-authority'
        );
        const { GlobalScheduler } = await import('@agora/core-orchestration');
        const { mergeByIdMutation } = await import('@agora/core-domain');
        await new LocalGitWorkspaces(ctx).registerInitial(ctx.request);
        const snapshot = await ctx.control.snapshot();
        const scheduler = new GlobalScheduler();
        for (const workerId of ['coder', 'tester']) {
          const claim = snapshot.claims.find((c) => c.workerId === workerId);
          const workspace = snapshot.workspaces.find((w) => w.workspaceId === claim?.workspaceId);
          const record = snapshot.linkedRoots?.find((r) => r.workspaceId === claim?.workspaceId);
          if (!claim || workspace?.mode !== 'linked-worktree' || !record)
            throw Error('missing binding');
          await ctx.store.commit(ctx.scope, [
            mergeByIdMutation('workers', workerId, {
              status: 'running',
              worktree: {
                path: record.path,
                branch: workspace.branch,
                baseCommit: workspace.baseCommit,
              },
            }),
          ]);
          const lease = await scheduler.acquire(ctx.scope.projectId, ctx.scope.taskId, workerId);
          const assertLease = (call: import('@agora/core-domain').WorkspaceCall) => {
            scheduler.assertActive(lease);
            if (
              call.projectId !== lease.projectId ||
              call.taskId !== lease.taskId ||
              call.workerId !== lease.workerId
            )
              throw Error('lease_scope_mismatch');
          };
          const call = {
            ...ctx.scope,
            workspaceId: workspace.workspaceId,
            workerId,
            actionId: `read-${workerId}`,
            grantRevision: ctx.grant.revision,
            writerEpoch: claim.writerEpoch,
          };
          const unconfigured = new LocalWorkspaceAuthority(
            ctx.control,
            ctx.roots,
            ctx.versions,
            assertLease,
            ctx.verifyGrant,
          );
          await expect(unconfigured.assertCall(call, 'read')).rejects.toThrow(
            'workspace_assignment_mismatch',
          );
          const authority = new LocalWorkspaceAuthority(
            ctx.control,
            ctx.roots,
            ctx.versions,
            assertLease,
            ctx.verifyGrant,
            undefined,
            ctx.gitOptions,
          );
          try {
            const admitted = await authority.assertCall(call, 'edit');
            expect(admitted.binding.root).toBe(record.path);
            expect(admitted.binding.root).not.toBe(ctx.root.path);
            expect(admitted.root.rootId).toBe(ctx.root.rootId);
            expect(admitted.binding.stagingIdentity).toBe(record.staging.identity);
            await expect(authority.assertCall({ ...call, writerEpoch: 0 }, 'edit')).rejects.toThrow(
              'authorization_closed',
            );
            const marker = join(record.path, '.git'),
              saved = readFileSync(marker);
            writeFileSync(marker, 'gitdir: /unowned\n');
            await expect(authority.assertCall(call, 'edit')).rejects.toThrow();
            writeFileSync(marker, saved);
            await scheduler.release(lease);
            await expect(authority.assertCall(call, 'read')).rejects.toThrow();
          } finally {
            await scheduler.release(lease);
          }
        }
      }),
    ),
  30_000,
);

// Only executor decisions are scripted here. Runtime, sessions, grants, Git, MCP and Harness ToolRuntime,
// scheduler, native file transactions and persisted receipts are real. The new
// two-worker case allows 180 seconds for repeated native admission/close proofs;
// individual command and existing test/model deadlines remain unchanged.
it(
  'runs linked workers through real sessions and MCP without assigning tester writes to the coder subtask',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const { LocalGitWorkspaces } = await import(
          '../../../packages/runtime/sandbox/src/local-git-workspaces'
        );
        const { LocalWorkspaceSessions } = await import(
          '../../../packages/runtime/sandbox/src/local-workspace-sessions'
        );
        const { GlobalScheduler, WorkerRuntime } = await import('@agora/core-orchestration');
        const { PHASE0_ROSTER } = await import('@agora/core-domain');
        const manager = new LocalGitWorkspaces(ctx);
        await manager.registerInitial(ctx.request);
        const sessions = await LocalWorkspaceSessions.create({
          ...ctx,
          filesHelper: resolve(
            'packages/runtime/sandbox/build/local-file-transaction-darwin-arm64',
          ),
          grantForAssignment: async () => ctx.grant.grantId,
        });
        const scheduler = new GlobalScheduler();
        const calls: string[] = [];
        const progress: { event: string; ms: number }[] = [];
        const started = Date.now();
        const mark = (event: string) => {
          progress.push({ event, ms: Date.now() - started });
          writeFileSync(
            resolve('test-outputs/task124/runtime-linked-progress.json'),
            JSON.stringify({ base: f.base, progress }),
          );
        };
        const runtime = new WorkerRuntime(
          {
            roster: PHASE0_ROSTER,
            loadState: () => ctx.store.load(ctx.scope),
            transition: async (_old, mutations) =>
              (await ctx.store.commit(ctx.scope, mutations)).state,
            resolveWorktree: (_state, assignment) =>
              manager.resolveAssignment({ ...ctx.scope, workerId: assignment.workerId }),
            localWorkspace: sessions,
            completeLocalAssignment: async (canonical, assignment, session) => {
              const ref = canonical.workers.find(
                (w) => w.workerId === assignment.workerId,
              )?.worktree;
              if (!ref || typeof ref === 'string') throw Error('missing canonical HEAD');
              expect(f.git(['-C', ref.path, 'rev-parse', 'HEAD'])).toBe(ref.headCommit);
              const path = assignment.role === 'CODER' ? 'implementation.txt' : 'tests.txt';
              const read = await session.tools.read(
                `tool:${hash(`${assignment.workerId}:after-commit`)}`,
                path,
              );
              await expect(
                session.tools.apply(
                  `tool:${hash(`${assignment.workerId}:sealed`)}`,
                  [
                    {
                      path,
                      expected: read.version,
                      readReceiptId: read.readReceiptId,
                      content: 'must not write',
                      encoding: 'utf8',
                    },
                  ],
                  [],
                ),
              ).rejects.toThrow('workspace_worker_writes_closed');
              return [];
            },
            buildExecutor: () => {
              throw Error('legacy executor forbidden');
            },
            buildLocalExecutor: (spec, assignment, session) => ({
              async step() {
                calls.push(assignment.workerId);
                mark(`${assignment.workerId}:step`);
                const { createLocalWorkspaceCatalog } = await import('@agora/tools-bridge');
                const { localWorkspaceRole } = await import('@agora/roles-definitions');
                const mapped = localWorkspaceRole(spec, session.workspace.mode);
                const capabilities = mapped.tools.map((tool) => {
                  if (tool === 'workspace.read') return 'read' as const;
                  if (tool === 'workspace.apply') return 'apply' as const;
                  if (tool === 'workspace.run') return 'run' as const;
                  throw Error('unexpected tool');
                });
                const catalog = await createLocalWorkspaceCatalog({
                  port: session.tools,
                  sessionId: session.sessionId,
                  capabilities,
                });
                const context = new Context();
                await context.plugin(SystemPrompt);
                await context.plugin(ToolRuntime);
                for (const tool of catalog.resolve(mapped.tools).definitions)
                  context.tools.register(tool);
                const run = async (name: string, args: unknown, id: string) => {
                  const response = await context.tools.execute({
                    name,
                    arguments: args,
                    callId: CallId(`${assignment.workerId}:${id}`),
                    signal: new AbortController().signal,
                  });
                  if (response.isError) throw Error(JSON.stringify(response.content));
                  return response.value as Record<string, unknown>;
                };
                try {
                  const read = await run('workspace_read', { path: 'file.txt' }, 'read');
                  expect(read.kind === 'file' && read.content).toBe('working\n');
                  mark(`${assignment.workerId}:read`);
                  const path = assignment.role === 'CODER' ? 'implementation.txt' : 'tests.txt';
                  const absent = await run('workspace_read', { path }, 'missing');
                  expect(absent.kind).toBe('absent');
                  mark(`${assignment.workerId}:absent`);
                  const result = await run(
                    'workspace_apply',
                    {
                      changes: [
                        {
                          path,
                          expected: absent.version,
                          readReceiptId: absent.readReceiptId,
                          content: assignment.workerId,
                          encoding: 'utf8',
                        },
                      ],
                      dependencies: [],
                    },
                    'apply',
                  );
                  expect(result.stage).toBe('applied');
                  mark(`${assignment.workerId}:applied`);
                  const snapshot = await run('workspace_read', {}, 'inspect');
                  expect(
                    Array.isArray(snapshot.files) &&
                      snapshot.files.some((file) => file.path === path),
                  ).toBe(true);
                } finally {
                  await catalog.dispose();
                }
                return {
                  kind: 'done' as const,
                  output: {},
                  reachedSafeBoundary: true,
                  mutations: [],
                };
              },
              async saveSafePoint() {
                return `safe:${assignment.workerId}`;
              },
              async loadSafePoint() {},
              injectInbox() {},
            }),
          },
          scheduler,
        );
        for (const role of ['CODER', 'TESTER'] as const) {
          const state = await ctx.store.load(ctx.scope);
          if (!state) throw Error('missing state');
          const completed = await runtime.runOne(state, {
            workerId: role.toLowerCase(),
            role,
            subtaskId: 'code',
          });
          const ref = completed.workers.find((w) => w.workerId === role.toLowerCase())?.worktree;
          expect(typeof ref === 'object' && ref.headCommit).toMatch(/^[a-f0-9]{40,64}$/);
          if (!ref || typeof ref === 'string') throw Error('missing committed worker');
          expect(ref.headCommit).not.toBe(ref.baseCommit);
          const path = role === 'CODER' ? 'implementation.txt' : 'tests.txt';
          expect(f.git(['-C', ref.path, 'show', `${ref.headCommit}:${path}`])).toBe(
            role.toLowerCase(),
          );
        }
        const state = await ctx.control.assertClosed(ctx.scope);
        const coder = state.workers.find((w) => w.workerId === 'coder'),
          tester = state.workers.find((w) => w.workerId === 'tester');
        expect(coder?.status).toBe('done');
        expect(tester?.status).toBe('done');
        expect(state.subtasks[0]?.worktree).toEqual(coder?.worktree);
        expect(tester?.worktree).not.toEqual(coder?.worktree);
        const records = (await ctx.control.snapshot()).linkedRoots ?? [];
        const coding = records.find((r) => r.workspaceId === 'coding'),
          testing = records.find((r) => r.workspaceId === 'testing');
        if (!coding || !testing) throw Error('missing physical records');
        expect(readFileSync(join(coding.path, 'implementation.txt'), 'utf8')).toBe('coder');
        expect(readFileSync(join(testing.path, 'tests.txt'), 'utf8')).toBe('tester');
        expect(existsSync(join(coding.path, 'tests.txt'))).toBe(false);
        expect(existsSync(join(testing.path, 'implementation.txt'))).toBe(false);
        expect(existsSync(join(f.root, 'implementation.txt'))).toBe(false);
        expect(existsSync(join(f.root, 'tests.txt'))).toBe(false);
        expect(calls).toEqual(['coder', 'tester']);
        expect(scheduler.activeCount).toBe(0);
        const closures: Record<string, unknown>[] = [];
        for (const reference of await ctx.objects.references()) {
          const value = (await ctx.objects.get(reference.valueHash)) as Record<string, unknown>;
          if (value.schemaVersion === 'workspace-worker-boundary-v1' && value.reason === 'close')
            closures.push(value);
        }
        expect(closures).toHaveLength(2);
        expect(closures.every((value) => value.claimRetained === true)).toBe(true);
        const revision = (await ctx.control.snapshot()).revision;
        expect(await manager.registerInitial(ctx.request)).toEqual(
          state.localExecution?.workspaces.filter((w) => w.mode === 'linked-worktree'),
        );
        expect((await ctx.control.snapshot()).revision).toBe(revision);
        expect((await ctx.control.assertClosed(ctx.scope)).workers).toEqual(state.workers);
        const committedCoder = coder?.worktree;
        if (!committedCoder || typeof committedCoder === 'string')
          throw Error('missing committed coder');
        f.git(['-C', coding.path, 'update-ref', 'HEAD', committedCoder.baseCommit]);
        await expect(manager.registerInitial(ctx.request)).rejects.toThrow(
          'local_git_worktree_changed',
        );
        expect((await ctx.control.snapshot()).revision).toBe(revision);
        expect((await ctx.control.assertClosed(ctx.scope)).workers).toEqual(state.workers);
      }),
    ),
  180_000,
);

// Fault adapters only interrupt the actual canonical commit, before or after
// its real disk write. No registry, Git or native operation is replaced.
it.each(['before', 'after'] as const)(
  'recovers an initial Git registration interrupted %s canonical commit without recreating trees',
  async (stage) =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const { LocalGitWorkspaces } = await import(
          '../../../packages/runtime/sandbox/src/local-git-workspaces'
        );
        const { LocalBindingCoordinator } = await import(
          '../../../packages/runtime/sandbox/src/local-binding-coordinator'
        );
        let interrupted = false;
        const control = await LocalBindingCoordinator.open(ctx.owner, {
          load: (scope) => ctx.store.load(scope),
          commit: async (scope, mutations) => {
            const shouldInterrupt =
              !interrupted &&
              mutations.some(
                (m) =>
                  m.op === 'set' &&
                  m.field === 'localExecution' &&
                  typeof m.value === 'object' &&
                  m.value !== null &&
                  'git' in m.value,
              );
            if (shouldInterrupt) {
              interrupted = true;
              if (stage === 'before') throw Error('fixed_commit_interruption');
            }
            const result = await ctx.store.commit(scope, mutations);
            if (shouldInterrupt) throw Error('fixed_commit_interruption');
            return result;
          },
        });
        await expect(
          new LocalGitWorkspaces({ ...ctx, control }).registerInitial(ctx.request),
        ).rejects.toThrow('fixed_commit_interruption');
        await expect(ctx.control.assertClosed(ctx.scope)).rejects.toThrow(
          'registry_recovery_required',
        );
        const paths = readdirSync(f.privateRoot).sort();
        const prepared = await control.snapshot();
        expect(prepared.linkedRoots).toHaveLength(3);
        expect(prepared.operations.at(-1)?.stage).toBe('prepared');
        const restarted = await LocalBindingCoordinator.open(ctx.owner, ctx.store);
        const result = await new LocalGitWorkspaces({ ...ctx, control: restarted }).registerInitial(
          ctx.request,
        );
        expect(result).toHaveLength(3);
        expect(readdirSync(f.privateRoot).sort()).toEqual(paths);
        const state = await restarted.assertClosed(ctx.scope);
        expect(
          state.localExecution?.receipts.filter((r) => r.actionId === ctx.request.actionId),
        ).toHaveLength(1);
        expect(state.workers.every((w) => w.status === 'pending' && !w.worktree)).toBe(true);
        expect((await restarted.snapshot()).linkedRoots).toEqual(prepared.linkedRoots);
      }),
    ),
  30_000,
);

it(
  'preserves partial Git preparation and refuses automatic recreation after an external lock',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const { LocalGitWorkspaces } = await import(
          '../../../packages/runtime/sandbox/src/local-git-workspaces'
        );
        let locked = false;
        const verifyGrant = async (scope: typeof ctx.scope, grantId: string) => {
          await ctx.verifyGrant(scope, grantId);
          if (
            !locked &&
            readdirSync(f.privateRoot).some((name) => name.endsWith('.worktree-completed.json'))
          ) {
            locked = true;
            writeFileSync(join(f.metadata, 'index.lock'), 'external lock');
          }
        };
        await expect(
          new LocalGitWorkspaces({ ...ctx, verifyGrant }).registerInitial(ctx.request),
        ).rejects.toThrow();
        expect(locked).toBe(true);
        const paths = readdirSync(f.privateRoot).sort();
        expect(paths.some((p) => p.endsWith('.worktree-completed.json'))).toBe(true);
        expect((await ctx.control.assertClosed(ctx.scope)).localExecution?.git).toBeUndefined();
        unlinkSync(join(f.metadata, 'index.lock'));
        await expect(new LocalGitWorkspaces(ctx).registerInitial(ctx.request)).rejects.toThrow(
          'local_git_recovery_required',
        );
        expect(readdirSync(f.privateRoot).sort()).toEqual(paths);
        expect((await ctx.control.snapshot()).claims).toEqual([]);
      }),
    ),
  15_000,
);

it.each(['source-drift', 'bad-role', 'missing-worker', 'duplicate-worker'] as const)(
  'rejects invalid Git registration before creating private Git metadata: %s',
  async (scenario) =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const { LocalGitWorkspaces } = await import(
          '../../../packages/runtime/sandbox/src/local-git-workspaces'
        );
        const request = structuredClone(ctx.request);
        if (scenario === 'source-drift') writeFileSync(join(f.root, 'file.txt'), 'changed');
        if (scenario === 'bad-role')
          request.targets[2] = { workspaceId: 'testing', purpose: 'coding', workerId: 'tester' };
        if (scenario === 'missing-worker')
          request.targets[1] = { workspaceId: 'coding', purpose: 'coding', workerId: 'missing' };
        if (scenario === 'duplicate-worker')
          request.targets[2] = { workspaceId: 'testing', purpose: 'coding', workerId: 'coder' };
        await expect(new LocalGitWorkspaces(ctx).registerInitial(request)).rejects.toThrow();
        expect(readdirSync(f.privateRoot)).toEqual([]);
        expect((await ctx.control.snapshot()).linkedRoots ?? []).toEqual([]);
        expect((await ctx.control.assertClosed(ctx.scope)).localExecution?.git).toBeUndefined();
      }),
    ),
);

it(
  'registers a complete directory baseline without importing excluded contents',
  async () =>
    fixture(async (f) =>
      registeredFixture(f, async (ctx) => {
        const { LocalGitWorkspaces } = await import(
          '../../../packages/runtime/sandbox/src/local-git-workspaces'
        );
        const { localRootBinding } = await import(
          '../../../packages/runtime/sandbox/src/local-workspace-authority'
        );
        mkdirSync(join(f.root, 'empty-directory'));
        mkdirSync(join(f.root, 'empty-directory/nested'));
        mkdirSync(join(f.root, 'excluded-only'));
        writeFileSync(join(f.root, 'excluded-only/.env'), 'fixture excluded content');
        const version = await ctx.versions.capture(
          ctx.versionScope,
          localRootBinding(ctx.root),
          async () => {
            await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
            return true;
          },
        );
        const registered = await new LocalGitWorkspaces(ctx).registerInitial({
          ...ctx.request,
          version,
        });
        expect(registered).toHaveLength(3);
        const roots = (await ctx.control.snapshot()).linkedRoots ?? [];
        expect(roots).toHaveLength(3);
        for (const root of roots) {
          expect(readdirSync(join(root.path, 'empty-directory'))).toEqual(['nested']);
          expect(readdirSync(join(root.path, 'empty-directory/nested'))).toEqual([]);
          expect(readdirSync(join(root.path, 'excluded-only'))).toEqual([]);
        }
        expect(readFileSync(join(f.root, 'excluded-only/.env'), 'utf8')).toBe(
          'fixture excluded content',
        );
      }),
    ),
  20_000,
);

it(
  'bootstraps an integration-only baseline before any D17 worker exists',
  async () =>
    fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          const { LocalGitWorkspaces } = await import(
            '../../../packages/runtime/sandbox/src/local-git-workspaces'
          );
          const manager = new LocalGitWorkspaces(ctx);
          const request = {
            ...ctx.request,
            targets: [{ workspaceId: 'integration', purpose: 'integration' as const }],
          };
          const result = await manager.registerInitial(request);
          expect(result).toHaveLength(1);
          const state = await ctx.control.assertClosed(ctx.scope);
          expect(state.workers).toEqual([]);
          expect(state.subtasks).toEqual([]);
          expect(state.localExecution?.bindings).toEqual([]);
          expect((await ctx.control.snapshot()).claims).toEqual([]);
          const revision = (await ctx.control.snapshot()).revision;
          const paths = readdirSync(f.privateRoot).sort();
          expect(await manager.registerInitial(request)).toEqual(result);
          expect((await ctx.control.snapshot()).revision).toBe(revision);
          expect(readdirSync(f.privateRoot).sort()).toEqual(paths);
        },
        true,
      ),
    ),
  15_000,
);

it(
  'registers the exact persisted D17 coding batch from its fixed baseline, preserving user edits',
  async () =>
    fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          const { manager, request, state } = await firstCodingWave(ctx);
          writeFileSync(join(f.root, 'file.txt'), 'later user edit\n');
          const workspaces = await manager.registerCodingWave(request);
          expect(workspaces).toHaveLength(2);
          const after = await ctx.control.assertClosed(ctx.scope);
          expect(after.workers).toEqual(state.workers);
          expect(after.subtasks).toEqual(state.subtasks);
          expect(after.parallelExecution).toEqual(state.parallelExecution);
          expect(after.localExecution?.git?.initialWorkspaceId).toBe('integration');
          expect(after.localExecution?.git?.worktrees).toHaveLength(3);
          expect((await ctx.control.snapshot()).claims).toHaveLength(2);
          for (const target of request.targets) {
            const ref = await manager.resolveAssignment({
              ...ctx.scope,
              workerId: target.workerId,
            });
            expect(ref.baseCommit).toBe(
              request.version.kind === 'git' ? request.version.commit : 'not git',
            );
            expect(readFileSync(join(ref.path, 'file.txt'), 'utf8')).toBe('working\n');
          }
          const revision = (await ctx.control.snapshot()).revision;
          const paths = readdirSync(f.privateRoot).sort();
          expect(await manager.registerCodingWave(request)).toEqual(workspaces);
          expect((await ctx.control.snapshot()).revision).toBe(revision);
          expect(readdirSync(f.privateRoot).sort()).toEqual(paths);
          expect(readFileSync(join(f.root, 'file.txt'), 'utf8')).toBe('later user edit\n');
        },
        true,
      ),
    ),
  40_000,
);

it(
  'rejects a stale, incomplete or drifting coding batch before new Git effects',
  async () =>
    fixture(async (f) =>
      registeredFixture(
        f,
        async (ctx) => {
          const { manager, request, record } = await firstCodingWave(ctx);
          const paths = readdirSync(f.privateRoot).sort();
          const revision = (await ctx.control.snapshot()).revision;
          const cases = [
            { ...request, targets: request.targets.slice(0, 1) },
            { ...request, waveId: 'other-wave' },
            { ...request, attempt: request.attempt + 1 },
            { ...request, sourceWorkspaceId: 'other-workspace' },
            {
              ...request,
              version: { ...request.version, kind: 'git' as const, commit: 'f'.repeat(40) },
            },
            { ...request, expectedRevision: revision - 1 },
          ];
          for (const invalid of cases) {
            await expect(manager.registerCodingWave(invalid)).rejects.toThrow();
            expect(readdirSync(f.privateRoot).sort()).toEqual(paths);
            expect((await ctx.control.snapshot()).revision).toBe(revision);
          }
          writeFileSync(join(record.path, 'file.txt'), 'uncommitted drift');
          await expect(manager.registerCodingWave(request)).rejects.toThrow(
            'file_version_conflict',
          );
          expect(readdirSync(f.privateRoot).sort()).toEqual(paths);
          expect((await ctx.control.snapshot()).revision).toBe(revision);
        },
        true,
      ),
    ),
  25_000,
);
