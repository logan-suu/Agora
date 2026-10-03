// Real Go, native Direct workspace, official Harness, HTTP, canonical queue,
// shared scheduler and production host factory. Approval only orders the hold;
// the observed tool result is returned by the actual native read implementation.
// The step observer forwards unchanged arguments to the real executor; it only
// compares the queued projection with the canonical execution-time projection.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeByIdMutation, setMutation, workspaceRangeResumes } from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import {
  HarnessExecutor,
  type ProjectionView,
  readHarnessLineageEvidence,
} from '@agora/runtime-executor';
import { expect, it, vi } from 'vitest';
import { type ChannelEvent, ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createLocalTaskCompositionFactory } from '../../../apps/web/src/server/local-task-composition';
import { createLocalWorkspaceProtection } from '../../../apps/web/src/server/local-workspace-protection';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import {
  type TaskComposition,
  TaskOrchestrationRuntime,
} from '../../../apps/web/src/server/task-orchestration-runtime';
import { resolveLiveTestModel } from '../../helpers/live-model';
import { nativeRangeFixture } from './local-range-native-fixture';

const goal =
  'Use workspace_read to inspect the actual file.txt and report its current contents. Preserve every file, do not execute commands, and report done after that read.';
it(
  'uses the production HTTP host for pending return, natural active closure, disposal, official Fork and fresh leased native reads; replay stays read-only',
  async () =>
    nativeRangeFixture(
      async (ctx) => {
        const live = await resolveLiveTestModel();
        expect(live.model).toBe('deepseek-v4-flash');
        await ctx.store.commit(ctx.scope, [
          setMutation('phase', 'coding'),
          mergeByIdMutation('subtasks', 'code', { title: goal, status: 'in_progress' }),
          mergeByIdMutation('requirements', 'req-read', {
            story: goal,
            acceptance: ['Inspect actual current content'],
            nonGoals: [],
          }),
        ]);
        let takeCommitted = () => {};
        const activeTakeCommit = new Promise<void>((r) => {
          takeCommitted = r;
        });
        const stream = new ChannelStream(),
          messages = new MessageRuntime(join(ctx.owner.root, 'tasks'), stream, DEFAULT_ROSTER),
          events: ChannelEvent[] = [],
          unsubscribe = stream.subscribe({ ...ctx.scope, channelId: 'main' }, (e) => {
            events.push(e);
            if (e.type === 'message' && (e.data as { msgId?: string }).msgId === 'host-active-take')
              takeCommitted();
          }),
          compositions: TaskComposition[] = [],
          reads: { sessionId: string; content: string }[] = [],
          sessions: { role: string; sessionId: string }[] = [];
        let entered = () => {},
          release = () => {},
          first = true;
        const inside = new Promise<void>((r) => {
            entered = r;
          }),
          gate = new Promise<void>((r) => {
            release = r;
          }),
          open = ctx.sessions.open.bind(ctx.sessions);
        ctx.sessions.open = async (input) => {
          expect(ctx.scheduler.activeCount).toBe(1);
          const session = await open(input),
            read = session.tools.read.bind(session.tools);
          sessions.push({ role: input.role, sessionId: session.sessionId });
          session.tools.read = async (id, path) => {
            const result = await read(id, path);
            if (result.kind === 'file')
              reads.push({
                sessionId: session.sessionId,
                content: result.content.toString('utf8'),
              });
            return result;
          };
          return session;
        };
        const factory = createLocalTaskCompositionFactory({
            loadState: (s) => messages.store.load(s),
            bindCompletionVerifier: (verify) => messages.bindLocalCompletionVerifier(verify),
            prepare: async () => ({
              local: ctx.sessions,
              cwd: ctx.root.path,
              sessionRoot: ctx.sessionRoot,
            }),
            scheduler: ctx.scheduler,
            model: live.model,
            executorOptions: {
              ...live.options,
              maxToolCallsPerTurn: 4,
              approval: async () => {
                if (first) {
                  first = false;
                  entered();
                  await gate;
                }
                return { kind: 'allow' };
              },
            },
          }),
          runtime = new TaskOrchestrationRuntime(messages, async (input) => {
            const composition = await factory(input);
            compositions.push(composition);
            ctx.bindRuntime(composition.workerRuntime);
            return composition;
          });
        const protection = await createLocalWorkspaceProtection({
          ...ctx,
          runtime,
          lifecycle: {
            closeWorkers: (hold, source) => ctx.workerEvidence.closeWorkers(hold, source),
            proveWriters: (hold, source, workers) => ctx.writers.prove(hold, source, workers),
          },
          readFork: (plan, fresh) =>
            readHarnessLineageEvidence(
              plan.sourceSafePointRef,
              plan.resumeSessionId,
              {
                root: ctx.sessionRoot,
                cwd: ctx.root.path,
                projectId: plan.projectId,
                taskId: plan.taskId,
                role: plan.role,
              },
              { fresh },
            ),
          fallback: {
            commit: async () => {
              throw Error('unexpected_workspace_verb');
            },
          },
        });
        const post = createPostMessage(messages),
          inputs = new Map<string, RequestInit>();
        const request = async (verb: string, actionId: string, extra: object) => {
          const body = {
            ...ctx.scope,
            channelId: 'main',
            msgId: actionId,
            display: `/workspace ${verb} ${JSON.stringify({ ...ctx.scope, actionId, expectedRevision: (await protection.control.snapshot()).revision, ...extra })}`,
          };
          const init = { method: 'POST', body: JSON.stringify(body) };
          inputs.set(actionId, init);
          return post(new Request('http://localhost/api/messages', init));
        };
        const projectionChecks: {
          currentResume: boolean;
          sameResumes: boolean;
          sameVersions: boolean;
        }[] = [];
        const actualStep = HarnessExecutor.prototype.step;
        const stepObserver = vi
          .spyOn(HarnessExecutor.prototype, 'step')
          .mockImplementation(function (this: HarnessExecutor, context) {
            const markers = context.view.slices.workspaceRangeResumes;
            if (
              Array.isArray(markers) &&
              markers.some((entry) => entry.resumeSessionId === context.sessionId)
            ) {
              const effective = (Reflect.get(this, 'pendingInbox') ??
                context.view) as ProjectionView;
              projectionChecks.push({
                currentResume: true,
                sameResumes:
                  JSON.stringify(effective.slices.workspaceRangeResumes) ===
                  JSON.stringify(markers),
                sameVersions:
                  JSON.stringify(effective.slices.workspaceVersionChanges) ===
                  JSON.stringify(context.view.slices.workspaceVersionChanges),
              });
            }
            return actualStep.call(this, context);
          });
        try {
          const originalIndex = readFileSync(join(ctx.root.path, '.git/index'));
          expect(
            (
              await request('takeover', 'host-pending-take', {
                workspaceId: 'coding',
                paths: ['file.txt'],
              })
            ).status,
          ).toBe(202);
          expect((await protection.take.view('takeover:host-pending-take')).editable).toBe(true);
          writeFileSync(join(ctx.root.path, 'file.txt'), 'first held user edit\n');
          expect(
            (
              await request('return', 'host-pending-return', {
                takeoverReceiptId: 'takeover:host-pending-take',
              })
            ).status,
          ).toBe(202);
          expect(compositions).toHaveLength(1);
          await Promise.race([
            inside,
            runtime.waitForIdle(ctx.scope).then(() => {
              throw Error('live_model_did_not_propose_required_read');
            }),
          ]);
          const active = request('takeover', 'host-active-take', {
            workspaceId: 'coding',
            paths: ['file.txt'],
          });
          await Promise.race([
            activeTakeCommit,
            active.then(() => {
              throw Error('active_take_did_not_commit');
            }),
          ]);
          release();
          expect((await active).status).toBe(202);
          await runtime.waitForIdle(ctx.scope);
          const heldView = await protection.take.view('takeover:host-active-take');
          expect(heldView).toMatchObject({ editable: true, needsAttention: false });
          expect(runtime.rangeWorkerRuntime(ctx.scope)).toBeUndefined();
          expect(ctx.scheduler.activeCount).toBe(0);
          expect(ctx.sessions.rangeCapabilities(ctx.scope)).toEqual([]);
          expect(
            (await messages.store.load(ctx.scope))?.workers.find((w) => w.workerId === 'coder')
              ?.status,
          ).toBe('paused');
          writeFileSync(join(ctx.root.path, 'file.txt'), 'second held user edit\n');
          expect(
            (
              await request('return', 'host-active-return', {
                takeoverReceiptId: 'takeover:host-active-take',
              })
            ).status,
          ).toBe(202);
          expect(compositions).toHaveLength(2);
          const registered = await messages.store.load(ctx.scope);
          if (!registered) throw Error('missing actual registered state');
          const marker = workspaceRangeResumes(registered)[0];
          if (!marker) throw Error('missing_actual_host_fork');
          await runtime.waitForIdle(ctx.scope);
          const coderSessions = sessions.filter((s) => s.role === 'CODER');
          expect(projectionChecks).toEqual([
            { currentResume: true, sameResumes: true, sameVersions: true },
          ]);
          expect(coderSessions).toHaveLength(2);
          expect(coderSessions[1]?.sessionId).toBe(marker.resumeSessionId);
          expect(coderSessions[1]?.sessionId).not.toBe(coderSessions[0]?.sessionId);
          expect(
            reads.some(
              (r) =>
                r.sessionId === marker.resumeSessionId && r.content === 'second held user edit\n',
            ),
          ).toBe(true);
          expect(readFileSync(join(ctx.root.path, '.git/index'))).toEqual(originalIndex);
          const before = {
            contexts: compositions.length,
            sessions: sessions.length,
            reads: reads.length,
          };
          const replay = await post(
            new Request('http://localhost/api/messages', inputs.get('host-active-return')),
          );
          expect(replay.status).toBe(202);
          expect(await replay.json()).toMatchObject({ published: false });
          expect({
            contexts: compositions.length,
            sessions: sessions.length,
            reads: reads.length,
          }).toEqual(before);
          for (const action of inputs.keys())
            expect(
              events.filter(
                (e) => e.type === 'message' && (e.data as { msgId?: string }).msgId === action,
              ),
            ).toHaveLength(1);
          expect(
            events
              .filter((e) => e.type === 'message')
              .every((e) => !Object.hasOwn(e.data as object, 'payload')),
          ).toBe(true);
          const cold = new TaskOrchestrationRuntime(messages, async () => {
            throw Error('cold_must_not_build');
          });
          expect((await cold.start({ ...ctx.scope, goal, requestId: 'cold' })).startOutcome).toBe(
            'interrupted',
          );
          await cold.disposeAll();
        } finally {
          const state = await messages.store.load(ctx.scope);
          writeFileSync(
            resolve('test-outputs/task125-protection-host-evidence.json'),
            JSON.stringify(
              {
                provider: 'opencode-go',
                model: live.model,
                sessions,
                readCount: reads.length,
                projectionChecks,
                workerStatuses: state?.workers.map((w) => ({
                  workerId: w.workerId,
                  role: w.role,
                  status: w.status,
                  sessionId: w.sessionId,
                })),
                host: await runtime.summary(ctx.scope),
                compositionCount: compositions.length,
                activeLeases: ctx.scheduler.activeCount,
                resumeSessionIds: state
                  ? workspaceRangeResumes(state).map((r) => r.resumeSessionId)
                  : [],
                controlEventCount: events.filter(
                  (e) => e.type === 'message' && inputs.has((e.data as { msgId: string }).msgId),
                ).length,
              },
              null,
              2,
            ),
          );
          release();
          unsubscribe();
          try {
            await runtime.disposeAll();
          } finally {
            stepObserver.mockRestore();
          }
          // The real fixture records ownership, process closure and cleanup evidence.
        }
      },
      goal,
      true,
    ),
  300_000,
);
