// Real Go provider, official Harness, native linked workspace, MCP, registry,
// WorkerRuntime and shared GlobalScheduler. The pre-tool checkpoint only orders
// the trusted request; no model response, file proof or closure is doubled.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type Message,
  mergeByIdMutation,
  parseWorkspaceControl,
  setMutation,
  workspaceRangeResumes,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import {
  HarnessTraceReader,
  projectForAssignment,
  readHarnessLineageEvidence,
} from '@agora/runtime-executor';
import { expect, it } from 'vitest';
import { deferredTools } from '../../../apps/web/src/server/local-task-composition';
import { createLocalCoderExecutor } from '../../../apps/web/src/server/local-workspace-executor';
import { LocalGitWorkspaces } from '../../../packages/runtime/sandbox/src/local-git-workspaces';
import { LocalRangeResumeController } from '../../../packages/runtime/sandbox/src/local-range-resume-controller';
import { LocalRangeReturnController } from '../../../packages/runtime/sandbox/src/local-range-return-controller';
import { resolveLiveTestModel } from '../../helpers/live-model';
import { nativeRangeFixture } from './local-range-native-fixture';

const goal =
  'Inspect the fixed file.txt using workspace_read before reporting its contents. Do not edit files, run commands, commit, or invent evidence. Report done after the actual read result.';
function message(
  scope: { projectId: string; taskId: string },
  verb: string,
  actionId: string,
  revision: number,
  extra: object,
): Message {
  const display = `/workspace ${verb} ${JSON.stringify({ ...scope, actionId, expectedRevision: revision, ...extra })}`;
  return {
    msgId: actionId,
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat',
    display,
    ts: 10,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
}
it(
  'naturally closes a live model Step and real MCP capability before native held ownership, return capture, canonical Fork and a fresh leased run',
  async () =>
    nativeRangeFixture(
      async (ctx) => {
        const live = await resolveLiveTestModel();
        expect(live.model).toBe('deepseek-v4-flash');
        const composed: Awaited<ReturnType<typeof createLocalCoderExecutor>>[] = [];
        const forks = new Map<
          string,
          {
            entry: Awaited<ReturnType<typeof createLocalCoderExecutor>>;
            port: ReturnType<typeof deferredTools>;
            sessionId: string;
          }
        >();
        const openedSessions: string[] = [];
        const resumedReads: string[] = [];
        const resumedCalls: string[] = [];
        const resumedReadDiagnostics: {
          expectedPath: boolean;
          pathHash: string;
          resultKind?: string;
          errorCode?: string;
        }[] = [];
        const requestDiagnostics: {
          sessionId: string;
          seq: number;
          systemHash: string;
          scopedGoal: boolean;
          currentSession: boolean;
          versionChanges: boolean;
          resumeMarkers: boolean;
          resumeContract: boolean;
          currentRequirement: boolean;
          toolNames: string[];
        }[] = [];
        const responseDiagnostics: {
          seq: number;
          textHash: string;
          mentionsTarget: boolean;
          mentionsUnavailable: boolean;
          mentionsPaused: boolean;
          mentionsHistorical: boolean;
          failureReply?: string;
        }[] = [];
        const requestDiagnosticFailures: string[] = [];
        const independentReads: string[] = [];
        let entered = () => {},
          release = () => {},
          first = true;
        const inside = new Promise<void>((r) => {
            entered = r;
          }),
          gate = new Promise<void>((r) => {
            release = r;
          });
        const git = new LocalGitWorkspaces(ctx);
        const runtime = new WorkerRuntime(
          {
            roster: DEFAULT_ROSTER,
            loadState: () => ctx.store.load(ctx.scope),
            transition: async (_s, m) => (await ctx.store.commit(ctx.scope, m)).state,
            sessionIdForAssignment: (a) =>
              a.workerId === 'coder' ? 'live-range-source' : 'live-range-independent',
            localWorkspace: ctx.sessions,
            rangeAdmission: ctx.sessions,
            resolveWorktree: (_s, a) =>
              git.resolveAssignment({ ...ctx.scope, workerId: a.workerId }),
            buildExecutor: () => {
              throw Error('legacy_executor_forbidden');
            },
            buildLocalExecutor: async (spec, a, session) => {
              expect(ctx.scheduler.activeCount).toBe(1);
              openedSessions.push(session.sessionId);
              const fork = forks.get(a.workerId);
              if (fork) {
                fork.port.bind({
                  ...session.tools,
                  inspect: async (id) => {
                    resumedCalls.push('inspect');
                    return session.tools.inspect(id);
                  },
                  read: async (id, path) => {
                    resumedCalls.push('read');
                    const diagnostic: (typeof resumedReadDiagnostics)[number] = {
                      expectedPath: path === 'file.txt',
                      pathHash: createHash('sha256').update(path).digest('hex'),
                    };
                    resumedReadDiagnostics.push(diagnostic);
                    try {
                      const result = await session.tools.read(id, path);
                      diagnostic.resultKind = result.kind;
                      if (result.kind === 'file')
                        resumedReads.push(result.content.toString('utf8'));
                      return result;
                    } catch (error) {
                      diagnostic.errorCode =
                        error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
                          ? error.message
                          : 'workspace_tool_failed';
                      throw error;
                    }
                  },
                });
                return fork.entry.executor;
              }
              const entry = await createLocalCoderExecutor({
                spec: { ...spec, model: live.model },
                session: {
                  ...session,
                  tools: {
                    ...session.tools,
                    read: async (id, path) => {
                      const result = await session.tools.read(id, path);
                      if (a.workerId === 'independent' && result.kind === 'file')
                        independentReads.push(result.content.toString('utf8'));
                      return result;
                    },
                  },
                },
                options: {
                  ...live.options,
                  maxToolCallsPerTurn: 4,
                  sessionPersistence: { root: ctx.sessionRoot, cwd: ctx.root.path, ...ctx.scope },
                  approval: async () => {
                    if (first) {
                      first = false;
                      entered();
                      await gate;
                    }
                    return { kind: 'allow' };
                  },
                },
              });
              composed.push(entry);
              return entry.executor;
            },
            closeRangeExecutor: async (executor) => {
              const entries = composed.filter((e) => e.executor === executor);
              if (entries.length !== 1) throw Error('missing actual executor');
              await entries[0]?.dispose();
            },
          },
          ctx.scheduler,
        );
        ctx.bindRuntime(runtime);
        const recovery = new LocalRangeResumeController({
          ...ctx,
          tasks: ctx.store,
          evidence: ctx.evidence,
          prepareFork: async (plan, state) => {
            expect(ctx.scheduler.activeCount).toBe(0);
            const spec = DEFAULT_ROSTER.find((r) => r.role === plan.role),
              binding = state.localExecution?.bindings.find((b) => b.workerId === plan.workerId),
              workspace = state.localExecution?.workspaces.find(
                (w) => w.workspaceId === binding?.workspaceId,
              );
            if (!spec || !workspace) throw Error('missing actual Fork binding');
            const port = deferredTools(),
              entry = await createLocalCoderExecutor({
                spec: { ...spec, model: live.model },
                session: { workspace, sessionId: plan.resumeSessionId, tools: port.tools },
                options: {
                  ...live.options,
                  maxToolCallsPerTurn: 4,
                  sessionPersistence: {
                    root: ctx.sessionRoot,
                    cwd: ctx.root.path,
                    ...ctx.scope,
                    resumeSessionId: plan.resumeSessionId,
                  },
                },
              });
            composed.push(entry);
            await entry.executor.loadSafePoint(plan.sourceSafePointRef);
            forks.set(plan.workerId, { entry, port, sessionId: plan.resumeSessionId });
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
          register: (request, verify) => runtime.registerRangeResumes(request, verify),
        });
        ctx.evidence.setResumeReader((hold, ref) => recovery.read(hold, ref));
        const returns = new LocalRangeReturnController({
          ...ctx,
          tasks: ctx.store,
          evidence: ctx.evidence,
          onReleased: (hold) => recovery.prepare(hold),
        });
        const prepared = await ctx.store.commit(ctx.scope, [
          setMutation('phase', 'coding'),
          mergeByIdMutation('subtasks', 'code', { status: 'in_progress', title: goal }),
          mergeByIdMutation('requirements', 'read-task-goal', {
            story: goal,
            acceptance: ['Inspect actual current content'],
            nonGoals: [],
          }),
        ]);
        // The CODER receives its assigned subtask, not the unprojected global
        // goal. Prove that the actual read instruction reaches this assignment.
        expect(
          projectForAssignment(
            prepared.state,
            { workerId: 'coder', role: 'CODER', subtaskId: 'code' },
            DEFAULT_ROSTER,
          ).slices.assignedSubtask,
        ).toEqual(expect.arrayContaining([expect.objectContaining({ title: goal })]));
        expect(
          projectForAssignment(
            prepared.state,
            { workerId: 'coder', role: 'CODER', subtaskId: 'code' },
            DEFAULT_ROSTER,
          ).slices.currentRequirements,
        ).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'read-task-goal', story: goal })]),
        );
        const source = readFileSync(join(ctx.root.path, 'file.txt'));
        const running = runtime.runOne(prepared.state, {
          workerId: 'coder',
          role: 'CODER',
          subtaskId: 'code',
        });
        try {
          // A completed turn before any tool proposal is a genuine missing-evidence
          // failure; it must not leave this test silently waiting for another run.
          await Promise.race([
            inside,
            running.then(() => {
              throw Error('live_model_did_not_propose_required_read');
            }),
          ]);
          const take = message(
            ctx.scope,
            'takeover',
            'live-take',
            (await ctx.control.snapshot()).revision,
            { workspaceId: 'coding', paths: ['file.txt'] },
          );
          await ctx.controller.commit(ctx.scope, take);
          const holding = ctx.controller.hold('takeover:live-take');
          release();
          const held = await holding;
          await running;
          expect(held.plan.cohort.map((w) => w.workerId)).toEqual(['coder']);
          expect(await ctx.controller.view(held.plan.takeoverId)).toMatchObject({
            editable: true,
            needsAttention: false,
          });
          expect(runtime.rangeActivity(ctx.scope)).toMatchObject({
            activeWorkerIds: [],
            leasedWorkerIds: [],
            queuedWorkerIds: [],
          });
          expect(ctx.sessions.rangeCapabilities(ctx.scope)).toEqual([]);
          const independentState = await ctx.store.load(ctx.scope);
          if (!independentState) throw Error('missing actual independent state');
          expect((await runtime.rangeDispatch(independentState))?.workerIds).toContain(
            'independent',
          );
          expect(held.plan.cohort.some((w) => w.workerId === 'independent')).toBe(false);
          const independent = await runtime.runOne(independentState, {
            workerId: 'independent',
            role: 'CODER',
            subtaskId: 'independent',
          });
          expect(independent.workers.find((w) => w.workerId === 'independent')?.status).toBe(
            'done',
          );
          expect(independentReads).toContain('working\n');
          expect(independent.workers.find((w) => w.workerId === 'coder')?.status).toBe('paused');
          expect((await ctx.controller.view(held.plan.takeoverId)).editable).toBe(true);
          const paused = (await ctx.store.load(ctx.scope))?.workers.find(
            (w) => w.workerId === 'coder',
          );
          expect(paused?.status).toBe('paused');
          if (!paused?.safePoint) throw Error('missing actual safe point');
          const coding = (await ctx.control.snapshot()).linkedRoots?.find(
            (r) => r.workspaceId === 'coding',
          );
          if (!coding) throw Error('missing coding');
          writeFileSync(join(coding.path, 'file.txt'), 'fixed user edit during held ownership\n');
          const returned = message(
            ctx.scope,
            'return',
            'live-return',
            (await ctx.control.snapshot()).revision,
            { takeoverReceiptId: held.plan.takeoverId },
          );
          await returns.commit(ctx.scope, returned);
          ctx.control.setRangeEvidenceVerifier((r, s) => ctx.evidence.verifyAdmission(r, s));
          await returns.release(held.plan.takeoverId);
          const registered = await ctx.store.load(ctx.scope);
          if (!registered) throw Error('missing canonical registration');
          const marker = workspaceRangeResumes(registered)[0];
          if (!marker) throw Error('missing canonical Fork marker');
          expect(marker.sourceSessionId).toBe('live-range-source');
          expect(marker.resumeSessionId).not.toBe('live-range-source');
          expect(registered.workers.find((w) => w.workerId === 'coder')?.status).toBe('paused');
          expect(ctx.scheduler.activeCount).toBe(0);
          const fork = await readHarnessLineageEvidence(
            paused.safePoint,
            marker.resumeSessionId,
            { root: ctx.sessionRoot, cwd: ctx.root.path, ...ctx.scope, role: 'CODER' },
            { fresh: true },
          );
          const resumed = await runtime.runOne(registered, {
            workerId: 'coder',
            role: 'CODER',
            subtaskId: 'code',
          });
          expect(resumed.workers.find((w) => w.workerId === 'coder')).toMatchObject({
            status: 'done',
            sessionId: marker.resumeSessionId,
          });
          expect(openedSessions).toEqual([
            'live-range-source',
            'live-range-independent',
            marker.resumeSessionId,
          ]);
          expect(resumedReads).toContain('fixed user edit during held ownership\n');
          expect(ctx.scheduler.activeCount).toBe(0);
          const registeredRef = (await ctx.control.snapshot()).rangeHolds?.[0]?.evidence.find(
            (e) => e.phase === 'resume_registered',
          )?.ref;
          if (!registeredRef) throw Error('missing private registration');
          const cold = new LocalRangeResumeController({
            ...ctx,
            tasks: ctx.store,
            evidence: ctx.evidence,
            prepareFork: async () => {
              throw Error('cold reader must not Fork');
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
            register: async () => {
              throw Error('cold reader must not register');
            },
          });
          const completeHold = (await ctx.control.snapshot()).rangeHolds?.[0];
          if (!completeHold) throw Error('missing registered hold');
          expect((await cold.read(completeHold, registeredRef)).resumeSessionId).toBe(
            marker.resumeSessionId,
          );
          await returns.commit(ctx.scope, { ...returned, ts: returned.ts + 1 });
          expect(openedSessions).toHaveLength(3);
          expect(
            (await ctx.store.load(ctx.scope))?.workers.find((w) => w.workerId === 'coder')?.status,
          ).toBe('done');
          expect(readFileSync(join(coding.path, 'file.txt'), 'utf8')).toBe(
            'fixed user edit during held ownership\n',
          );
          expect(readFileSync(join(ctx.root.path, 'file.txt'))).toEqual(source);
          const { mkdirSync } = await import('node:fs');
          mkdirSync(resolve('test-outputs'), { recursive: true });
          writeFileSync(
            resolve('test-outputs/task125-live-range-result.json'),
            JSON.stringify(
              {
                taskId: '12.5',
                provider: 'opencode-go',
                model: live.model,
                scope:
                  'one live Step closure, real MCP/native ownership, return U, canonical official Fork registration and resumed read with a new lease/MCP capability; not complete task G5',
                held: true,
                returned: true,
                fork,
                workerStatus: 'done',
                activeLeases: 0,
              },
              null,
              2,
            ),
          );
        } finally {
          const { mkdirSync } = await import('node:fs');
          mkdirSync(resolve('test-outputs'), { recursive: true });
          const trace = await new HarnessTraceReader(ctx.owner.root)
            .read(ctx.scope)
            .catch(() => ({ unavailable: true }));
          // Test-only official-store inspection. On a no-read failure retain a
          // bounded ordinary reply from this synthetic fixture, never request
          // text, tool payloads or model reasoning blocks.
          for (const { entry, sessionId } of forks.values()) {
            try {
              const reader = Reflect.get(entry.executor, 'ctx') as {
                sessionPersistence: {
                  inspect(id: string): Promise<{
                    meta: { seedLength?: number };
                    events: {
                      seq: number;
                      type: string;
                      data: {
                        header?: { system?: string; tools?: { name: string }[] };
                        message?: { content?: { type: string; text?: string }[] };
                      };
                    }[];
                  }>;
                };
              };
              const stored = await reader.sessionPersistence.inspect(sessionId);
              for (const event of stored.events) {
                if (
                  event.seq >= (stored.meta.seedLength ?? 0) &&
                  event.type === 'assistant/message'
                ) {
                  const finalText = (event.data.message?.content ?? [])
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text ?? '')
                    .join('\n');
                  responseDiagnostics.push({
                    seq: event.seq,
                    textHash: createHash('sha256').update(finalText).digest('hex'),
                    mentionsTarget: finalText.includes('file.txt'),
                    mentionsUnavailable:
                      /unavailable|denied|cannot|can't|unable|not permitted|blocked|无法|拒绝|不可用/i.test(
                        finalText,
                      ),
                    mentionsPaused: /paus|held|takeover|接管|暂停/i.test(finalText),
                    mentionsHistorical: /histor|parent|previous|earlier|历史|先前/i.test(finalText),
                    ...(resumedReads.length === 0
                      ? { failureReply: finalText.slice(0, 2400) }
                      : {}),
                  });
                }
                if (event.seq < (stored.meta.seedLength ?? 0) || event.type !== 'request/header')
                  continue;
                const system = event.data.header?.system ?? '';
                requestDiagnostics.push({
                  sessionId,
                  seq: event.seq,
                  systemHash: createHash('sha256').update(system).digest('hex'),
                  scopedGoal: system.includes(goal),
                  currentSession: system.includes(sessionId),
                  versionChanges: system.includes('"workspaceVersionChanges"'),
                  resumeMarkers: system.includes('"workspaceRangeResumes"'),
                  resumeContract: system.includes('[Workspace version and resume context]'),
                  currentRequirement: system.includes('"read-task-goal"'),
                  toolNames: (event.data.header?.tools ?? []).map((tool) => tool.name),
                });
              }
            } catch (error) {
              requestDiagnosticFailures.push(
                error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
                  ? error.message
                  : 'official_request_diagnostic_unavailable',
              );
            }
          }
          writeFileSync(
            resolve('test-outputs/task125-live-range-diagnostics.json'),
            JSON.stringify(
              {
                provider: 'opencode-go',
                model: live.model,
                openedSessions,
                resumedCalls,
                resumedReadDiagnostics,
                requestDiagnostics,
                requestDiagnosticFailures,
                responseDiagnostics,
                resumedReadCount: resumedReads.length,
                activeLeases: ctx.scheduler.activeCount,
                trace,
              },
              null,
              2,
            ),
          );
          release();
          await running.catch(() => undefined);
          for (const fork of forks.values()) fork.port.close();
          for (const entry of composed) await entry.dispose();
        }
      },
      goal,
      false,
      true,
    ),
  300_000,
);
