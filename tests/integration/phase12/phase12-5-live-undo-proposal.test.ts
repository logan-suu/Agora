// Real Go model, official Harness, MCP, native writes, actual global lease and
// closed-session evidence, inverse effects and canonical result closure.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type Message,
  mergeByIdMutation,
  parseWorkspaceControl,
  setMutation,
  workspaceUndoResults,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import {
  HarnessTraceReader,
  projectForAssignment,
  readHarnessSafePointEvidence,
} from '@agora/runtime-executor';
import type {
  WorkspaceFileApply,
  WorkspaceFileBatchApply,
  WorkspaceFileRead,
} from '@agora/runtime-sandbox';
import { expect, it } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createLocalCoderExecutor } from '../../../apps/web/src/server/local-workspace-executor';
import { createLocalWorkspaceProtection } from '../../../apps/web/src/server/local-workspace-protection';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';
import { withLocalGitSession } from '../../../packages/runtime/sandbox/src/local-git-session';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { verifyLocalLinkedRoot } from '../../../packages/runtime/sandbox/src/local-linked-root';
import { LocalQuiescentWorkerEvidence } from '../../../packages/runtime/sandbox/src/local-quiescent-worker-evidence';
import { LocalQuiescentWriters } from '../../../packages/runtime/sandbox/src/local-quiescent-writers';
import { localRecordHash } from '../../../packages/runtime/sandbox/src/local-registry-records';
import {
  LocalUndoAuthority,
  type LocalUndoCall,
} from '../../../packages/runtime/sandbox/src/local-undo-authority';
import { LocalUndoBatch } from '../../../packages/runtime/sandbox/src/local-undo-batch';
import { LocalUndoCompletion } from '../../../packages/runtime/sandbox/src/local-undo-completion';
import { LocalUndoCurrentSource } from '../../../packages/runtime/sandbox/src/local-undo-current-source';
import { LocalUndoOriginalEffects } from '../../../packages/runtime/sandbox/src/local-undo-original-effects';
import { LocalUndoProposalStore } from '../../../packages/runtime/sandbox/src/local-undo-proposal';
import { LocalWorkspaceApply } from '../../../packages/runtime/sandbox/src/local-workspace-apply';
import { LocalWorkspaceAuthority } from '../../../packages/runtime/sandbox/src/local-workspace-authority';
import { LocalWorkspaceFiles } from '../../../packages/runtime/sandbox/src/local-workspace-files';
import { resolveLiveTestModel } from '../../helpers/live-model';
import { nativeRangeFixture } from './local-range-native-fixture';

const goal =
  'Read file.txt using workspace_read. Replace its contents once with exactly "working\\nagent addition\\n" using workspace_apply and the actual read receipt. Copy that read response version object unchanged into expected, and its readReceiptId unchanged into readReceiptId; use dependencies: []. Preserve all other files. Do not run commands, commit or invent tool evidence. Report done after the actual successful write.';
it(
  'binds an inverse candidate to actual B/A/U after a naturally completed model, preserving user changes and rejecting stale confirmation',
  async () =>
    nativeRangeFixture(async (ctx) => {
      const live = await resolveLiveTestModel();
      expect(live.model).toBe('deepseek-v4-flash');
      const progress: { phase: string; time: number }[] = [];
      const mark = (phase: string) => {
        progress.push({ phase, time: Date.now() });
        mkdirSync(resolve('test-outputs'), { recursive: true });
        writeFileSync(
          resolve('test-outputs/task125-undo-batch-progress.json'),
          JSON.stringify(progress),
        );
      };
      const entries: Awaited<ReturnType<typeof createLocalCoderExecutor>>[] = [],
        receipts: (WorkspaceFileApply | WorkspaceFileBatchApply)[] = [],
        applyFailures: string[] = [],
        applyShapes: string[][] = [],
        readBasis: { path: string; read: WorkspaceFileRead }[] = [],
        basisChecks: { receiptMatches: boolean; versionMatches: boolean; pathMatches: boolean }[] =
          [],
        helper = resolve('packages/runtime/sandbox/build/local-file-transaction-darwin-arm64'),
        git = new LocalGitWorkspaces(ctx);
      const runtime = new WorkerRuntime(
        {
          roster: DEFAULT_ROSTER,
          loadState: () => ctx.store.load(ctx.scope),
          transition: async (_s, m) => (await ctx.store.commit(ctx.scope, m)).state,
          sessionIdForAssignment: () => 'live-undo-source',
          localWorkspace: ctx.sessions,
          rangeAdmission: ctx.sessions,
          resolveWorktree: (_s, a) => git.resolveAssignment({ ...ctx.scope, workerId: a.workerId }),
          buildExecutor: () => {
            throw Error('legacy_executor_forbidden');
          },
          buildLocalExecutor: async (spec, _a, session) => {
            expect(ctx.scheduler.activeCount).toBe(1);
            const entry = await createLocalCoderExecutor({
              spec: { ...spec, model: live.model },
              session: {
                ...session,
                tools: {
                  ...session.tools,
                  read: async (...args) => {
                    const result = await session.tools.read(...args);
                    readBasis.push({ path: args[1], read: result });
                    return result;
                  },
                  apply: async (...args) => {
                    for (const change of args[1]) {
                      const read = readBasis.find(
                        (r) => r.read.readReceiptId === change.readReceiptId,
                      );
                      basisChecks.push({
                        receiptMatches: !!read,
                        versionMatches:
                          !!read &&
                          localRecordHash(read.read.version) === localRecordHash(change.expected),
                        pathMatches: !!read && read.path === change.path,
                      });
                    }
                    try {
                      const result = await session.tools.apply(...args);
                      receipts.push(result);
                      return result;
                    } catch (error) {
                      applyFailures.push(
                        error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
                          ? error.message
                          : 'unclassified_port_error',
                      );
                      throw error;
                    }
                  },
                },
              },
              options: {
                ...live.options,
                maxToolCallsPerTurn: 4,
                approval: async (call) => {
                  if (call.name === 'workspace_apply') {
                    const args = call.arguments as Record<string, unknown>;
                    // Only fixed schema diagnostics, never argument values or raw errors.
                    const issues: string[] = [];
                    if (!Array.isArray(args?.dependencies)) issues.push('dependencies_not_array');
                    if (!Array.isArray(args?.changes)) issues.push('changes_not_array');
                    if (Array.isArray(args?.changes))
                      for (const change of args.changes) {
                        if (!change || typeof change !== 'object') {
                          issues.push('change_not_object');
                          continue;
                        }
                        if (!/^read:[a-f0-9]{64}$/.test(change.readReceiptId))
                          issues.push('invalid_read_receipt_id');
                        if (!['utf8', 'base64'].includes(change.encoding))
                          issues.push('invalid_encoding');
                        if (typeof change.content !== 'string') issues.push('content_not_string');
                        if (
                          !change.expected ||
                          !['regular', 'absent'].includes(change.expected.kind)
                        )
                          issues.push('invalid_expected_kind');
                      }
                    applyShapes.push(issues);
                  }
                  return undefined;
                },
                sessionPersistence: { root: ctx.sessionRoot, cwd: ctx.root.path, ...ctx.scope },
              },
            });
            entries.push(entry);
            return entry.executor;
          },
        },
        ctx.scheduler,
      );
      ctx.bindRuntime(runtime);
      let releaseInverse = () => {};
      let pendingPost: Promise<Response> | undefined;
      let host: TaskOrchestrationRuntime | undefined;
      const state = (
          await ctx.store.commit(ctx.scope, [
            setMutation('phase', 'coding'),
            mergeByIdMutation('requirements', 'undo-fixture-goal', {
              story: goal,
              acceptance: [
                'file.txt is exactly working\\nagent addition\\n after one successful native apply.',
              ],
              nonGoals: ['Do not run commands or modify other files.'],
            }),
            mergeByIdMutation('subtasks', 'code', { status: 'in_progress', title: goal }),
          ])
        ).state,
        userIndex = readFileSync(join(ctx.root.path, '.git/index'));
      try {
        expect(
          projectForAssignment(
            state,
            { workerId: 'coder', role: 'CODER', subtaskId: 'code' },
            DEFAULT_ROSTER,
          ).slices.currentRequirements,
        ).toContainEqual({
          id: 'undo-fixture-goal',
          story: goal,
          acceptance: [
            'file.txt is exactly working\\nagent addition\\n after one successful native apply.',
          ],
          nonGoals: ['Do not run commands or modify other files.'],
        });
        mark('model:start');
        await runtime.runOne(state, { workerId: 'coder', role: 'CODER', subtaskId: 'code' });
        mark('model:closed');
        const completed = await ctx.control.assertClosed(ctx.scope),
          worker = completed.workers.find((w) => w.workerId === 'coder'),
          originalReceipt = receipts.filter((r) => r.effect === true && r.stage === 'applied');
        expect(worker?.status).toBe('done');
        expect(worker?.safePoint).toBeTypeOf('string');
        expect(originalReceipt).toHaveLength(1);
        expect(ctx.scheduler.activeCount).toBe(0);
        expect(ctx.sessions.rangeCapabilities(ctx.scope)).toEqual([]);
        const closure = new LocalQuiescentWorkerEvidence({
          ...ctx,
          native: (scope) => ctx.sessions.rangeBoundary(scope),
          isActive: (scope) =>
            ctx.sessions
              .rangeCapabilities(scope)
              .some((c) => c.workerId === scope.workerId && c.sessionId === scope.sessionId),
          official: (scope, canonical) => {
            const role = canonical.workers.find((w) => w.workerId === scope.workerId)?.role;
            if (!role) throw Error('missing canonical role');
            return readHarnessSafePointEvidence(scope.safePointRef, {
              root: ctx.sessionRoot,
              cwd: ctx.root.path,
              projectId: scope.projectId,
              taskId: scope.taskId,
              role,
            });
          },
        });
        const writers = new LocalQuiescentWriters({
          ...ctx,
          activity: (scope) => runtime.rangeActivity(scope),
          capabilities: (scope) => ctx.sessions.rangeCapabilities(scope),
          operations: (scope) => ctx.sessions.rangeOperations(scope),
          workerClosure: (claim, canonical) => closure.proveClaim(claim, canonical),
          controlClosure: async () => {
            throw Error('unexpected_control_writer');
          },
          verifyClosure: (claim, canonical, ref) => closure.verifyClaim(claim, canonical, ref),
          runtimeClosure: (w, canonical) => closure.prove(w, canonical),
          verifyRuntimeClosure: (w, canonical, ref) => closure.read(w, canonical, ref),
        });
        const current = new LocalUndoCurrentSource({
          ...ctx,
          writers,
          filesHelper: helper,
          inspector: ctx.gitOptions.helpers.inspector,
          fingerprint: (canonical) => ({
            goal: canonical.goal,
            requirements: canonical.requirements,
          }),
          metadata: async (scope, registry) => {
            mark('metadata:start');
            const workspace = registry.workspaces.find((w) => w.workspaceId === scope.workspaceId),
              record = registry.linkedRoots?.find((r) => r.workspaceId === scope.workspaceId),
              canonical = await ctx.control.assertClosed(scope),
              head = canonical.workers.find((w) =>
                canonical.localExecution?.bindings.some(
                  (b) => b.workerId === w.workerId && b.workspaceId === scope.workspaceId,
                ),
              )?.worktree;
            if (
              workspace?.mode !== 'linked-worktree' ||
              !record ||
              typeof head !== 'object' ||
              !head?.headCommit
            )
              throw Error('missing canonical committed Git');
            await verifyLocalLinkedRoot({
              ...ctx.gitOptions,
              ...ctx.scope,
              root: ctx.root.path,
              sourceRoot: ctx.root,
              workspace,
              record,
              expectedHead: head.headCommit,
              actionId: record.initialization.actionId,
              creationActionId: record.creation.actionId,
              bindingReceiptId: record.bindingReceiptId,
              authorize: async () => {
                await ctx.verifyGrant(ctx.scope, ctx.grant.grantId);
                return true;
              },
            });
            const metadata = await withLocalGitSession(
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
            mark('metadata:closed');
            return metadata;
          },
        });
        const authority = new LocalWorkspaceAuthority(
            ctx.control,
            ctx.roots,
            ctx.versions,
            () => {
              throw Error('no_current_worker_capability');
            },
            ctx.verifyGrant,
            undefined,
            ctx.gitOptions,
          ),
          files = new LocalWorkspaceFiles(authority, ctx.objects, helper),
          original = new LocalUndoOriginalEffects({
            objects: ctx.objects,
            files: await LocalWorkspaceApply.open(ctx.owner, authority, ctx.objects, files, helper),
          }),
          proposals = new LocalUndoProposalStore({
            objects: ctx.objects,
            original,
            current,
            filesHelper: helper,
          }),
          physical = (await ctx.control.snapshot()).linkedRoots?.find(
            (r) => r.workspaceId === 'coding',
          );
        if (!physical || !originalReceipt[0]) throw Error('missing original effect');
        const target = join(physical.path, 'file.txt');
        expect(readFileSync(target, 'utf8')).toBe('working\nagent addition\n');
        writeFileSync(target, 'user working\nagent addition\n');
        const prepared = await proposals.prepare(
          { ...ctx.scope, workspaceId: 'coding' },
          { ...ctx.scope, workspaceId: 'coding' },
          originalReceipt[0].receiptId,
        );
        expect(prepared.plan.kind).toBe('candidate');
        if (prepared.plan.kind !== 'candidate') throw Error('missing inverse candidate');
        expect(
          prepared.plan.candidate.files.find((f) => f.path === 'file.txt')?.content.toString(),
        ).toBe('user working\n');
        expect(readFileSync(target, 'utf8')).toBe('user working\nagent addition\n');
        await proposals.verifyFresh(prepared.inputHash);
        writeFileSync(target, 'later user content\n');
        await expect(proposals.verifyFresh(prepared.inputHash)).rejects.toThrow();
        expect((await proposals.read(prepared.inputHash)).plan.kind).toBe('candidate');
        expect(readFileSync(target, 'utf8')).toBe('later user content\n');
        expect(readFileSync(join(ctx.root.path, '.git/index'))).toEqual(userIndex);
        let undo!: LocalUndoAuthority, inverse!: LocalUndoBatch, completion!: LocalUndoCompletion;
        let enteredInverse = (_call: LocalUndoCall) => {};
        const inverseEntered = new Promise<LocalUndoCall>((r) => {
            enteredInverse = r;
          }),
          inverseGate = new Promise<void>((r) => {
            releaseInverse = r;
          }),
          messages = new MessageRuntime(
            join(ctx.owner.root, 'tasks'),
            new ChannelStream(),
            DEFAULT_ROSTER,
          );
        host = new TaskOrchestrationRuntime(messages, async () => {
          throw Error('undo_must_not_create_worker');
        });
        await createLocalWorkspaceProtection({
          ...ctx,
          runtime: host,
          lifecycle: {
            closeWorkers: (h, source) => ctx.workerEvidence.closeWorkers(h, source),
            proveWriters: (h, source, w) => ctx.writers.prove(h, source, w),
          },
          readFork: async () => {
            throw Error('undo_must_not_fork');
          },
          fallback: {
            commit: async () => {
              throw Error('unexpected_workspace_verb');
            },
          },
          undo: async ({ control, canonical, facts, serializeTask }) => {
            undo = new LocalUndoAuthority({
              ...ctx,
              control,
              proposals,
              current,
              writers,
              tasks: canonical,
            });
            inverse = await LocalUndoBatch.open(
              ctx.owner,
              ctx.objects,
              ctx.versions,
              undo,
              proposals,
              helper,
            );
            completion = new LocalUndoCompletion({
              ...ctx,
              control,
              authority: undo,
              batch: inverse,
              proposals,
              tasks: facts,
              serializeTask,
            });
            return {
              authority: undo,
              completion: {
                finish: async (call) => {
                  enteredInverse(call);
                  await inverseGate;
                  return completion.finish(call);
                },
              },
            };
          },
        });
        await messages.ensureProjectChannels(ctx.scope.projectId);
        const next = await proposals.prepare(
            { ...ctx.scope, workspaceId: 'coding' },
            { ...ctx.scope, workspaceId: 'coding' },
            originalReceipt[0].receiptId,
          ),
          display =
            '/workspace undo ' +
            JSON.stringify({
              ...ctx.scope,
              actionId: 'undo-confirmation',
              expectedRevision: next.proposal.expectedRevision,
              fileApplyReceiptId: next.proposal.fileApplyReceiptId,
              inputHash: next.inputHash,
            }),
          confirmation: Message = {
            msgId: 'undo-confirmation',
            channelId: 'main',
            fromRole: 'leader',
            type: 'chat',
            ts: 100,
            display,
            payload: {
              kind: 'leader_intent',
              intent: parseWorkspaceControl(display),
              action: { status: 'applied' },
            },
          };
        expect(next.plan.kind).toBe('conflict');
        await expect(undo.acquire(ctx.scope, confirmation)).rejects.toThrow(
          'undo_candidate_conflict',
        );
        expect((await ctx.control.snapshot()).claims.some((c) => c.kind === 'undo')).toBe(false);
        writeFileSync(target, 'user working\nagent addition\n');
        const accepted = await proposals.prepare(
            { ...ctx.scope, workspaceId: 'coding' },
            { ...ctx.scope, workspaceId: 'coding' },
            originalReceipt[0].receiptId,
          ),
          acceptedDisplay =
            '/workspace undo ' +
            JSON.stringify({
              ...ctx.scope,
              actionId: 'undo-live-confirmation',
              expectedRevision: accepted.proposal.expectedRevision,
              fileApplyReceiptId: accepted.proposal.fileApplyReceiptId,
              inputHash: accepted.inputHash,
            }),
          acceptedMessage: Message = {
            ...confirmation,
            msgId: 'undo-live-confirmation',
            display: acceptedDisplay,
            payload: {
              kind: 'leader_intent',
              intent: parseWorkspaceControl(acceptedDisplay),
              action: { status: 'applied' },
            },
          };
        const post = createPostMessage(messages),
          postInput = {
            method: 'POST',
            body: JSON.stringify({
              ...ctx.scope,
              channelId: 'main',
              msgId: acceptedMessage.msgId,
              display: acceptedDisplay,
            }),
          };
        pendingPost = post(new Request('http://localhost/api/messages', postInput));
        const call = await Promise.race([
            inverseEntered,
            pendingPost.then(async (response) => {
              throw Error(`undo_http_did_not_reach_inverse:${response.status}`);
            }),
          ]),
          acquired = { call, replayed: false };
        expect(acquired.replayed).toBe(false);
        expect(
          (await ctx.control.snapshot()).claims.find((c) => c.claimId === acquired.call.claimId),
        ).toMatchObject({ kind: 'undo', status: 'active', inputHash: accepted.inputHash });
        await undo.assertCall(acquired.call);
        expect(await ctx.sessions.canAcquire({ ...ctx.scope, workerId: 'coder' })).toBe(false);
        expect(await ctx.sessions.canAcquire({ ...ctx.scope, workerId: 'tester' })).toBe(false);
        expect(
          (await undo.acquire(ctx.scope, { ...acceptedMessage, ts: acceptedMessage.ts + 1 }))
            .replayed,
        ).toBe(true);
        expect(readFileSync(target, 'utf8')).toBe('user working\nagent addition\n');
        expect(
          (await ctx.store.load(ctx.scope))?.workers.find((w) => w.workerId === 'coder'),
        ).toEqual(worker);
        mark('undo:batch:start');
        releaseInverse();
        expect((await pendingPost).status).toBe(202);
        const result = await inverse.readHistory(acquired.call);
        mark('undo:batch:closed');
        expect(result).toMatchObject({ stage: 'applied', reason: 'none', closed: true });
        expect(result.currentVersion).not.toBeNull();
        expect(result.items).toHaveLength(1);
        expect(readFileSync(target, 'utf8')).toBe('user working\n');
        expect(readFileSync(join(ctx.root.path, '.git/index'))).toEqual(userIndex);
        const outcome = await completion.readHistory(acquired.call);
        expect(outcome.stage).toBe('applied');
        const closed = await ctx.control.assertClosed(ctx.scope);
        expect(workspaceUndoResults(closed)).toHaveLength(1);
        expect(workspaceUndoResults(closed)[0]).toMatchObject({
          source: { msgId: acceptedMessage.msgId, inputHash: accepted.inputHash },
          stage: 'applied',
        });
        expect(closed.workers.find((w) => w.workerId === 'coder')).toEqual(worker);
        expect(
          (await ctx.control.snapshot()).claims.find((c) => c.claimId === acquired.call.claimId),
        ).toMatchObject({ status: 'released', closureReceiptId: outcome.closureReceiptId });
        await expect(undo.assertCall(acquired.call)).rejects.toThrow('undo_not_live');
        writeFileSync(target, 'later user content after undo\n');
        expect(await completion.finish(acquired.call)).toEqual(outcome);
        expect((await undo.acquire(ctx.scope, acceptedMessage)).replayed).toBe(true);
        expect(await inverse.readHistory(acquired.call)).toEqual(result);
        expect(await inverse.apply(acquired.call)).toEqual(result);
        const replayed = await post(new Request('http://localhost/api/messages', postInput));
        expect(replayed.status).toBe(202);
        expect(await replayed.json()).toMatchObject({ published: false });
        expect(readFileSync(target, 'utf8')).toBe('later user content after undo\n');
      } finally {
        releaseInverse();
        await pendingPost?.catch(() => undefined);
        await host?.disposeAll();
        mkdirSync(resolve('test-outputs'), { recursive: true });
        writeFileSync(
          resolve('test-outputs/task125-live-undo-proposal-evidence.json'),
          JSON.stringify(
            {
              provider: 'opencode-go',
              model: live.model,
              scope:
                'actual original write, native/official closure and immutable inverse candidate; not complete undo G5',
              receipts,
              applyFailures,
              applyShapes,
              basisChecks,
              trace: await new HarnessTraceReader(ctx.owner.root)
                .read(ctx.scope)
                .catch(() => ({ unavailable: true })),
              leases: ctx.scheduler.activity(ctx.scope),
              capabilities: ctx.sessions.rangeCapabilities(ctx.scope),
            },
            null,
            2,
          ),
        );
        for (const entry of entries) await entry.dispose();
      }
    }, goal),
  300_000,
);
