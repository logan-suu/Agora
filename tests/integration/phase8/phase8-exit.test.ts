// Mock reason (R11): only paid external LLM responses are scripted. These tests use the real
// Harness JSONL persistence, LocalTempSandbox, TaskStateStore, HTTP message service,
// Coordinator, WorkerRuntime, D4 lifecycle, trace reader, and artifact archive path.
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addDecision,
  appendMutation,
  applyMutations,
  createInitialAppState,
  deriveObjectionResolutions,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { decide } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor, HarnessTraceReader, project } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { createWebTaskCompositionFactory } from '../../../apps/web/src/server/task-composition';
import { TaskOrchestrationRuntime } from '../../../apps/web/src/server/task-orchestration-runtime';

class Phase8Adapter extends LlmAdapter {
  reviewerTurns = 0;

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const role = projectionRole(options);
    const text =
      role === 'REVIEWER'
        ? JSON.stringify([
            {
              id: `phase8-review-${++this.reviewerTurns}`,
              kind: 'verdict',
              verdict: 'approved',
              summary: 'Candidate is ready for Leader confirmation.',
            },
          ])
        : `${role} completed the deterministic Phase 8 step.`;
    yield* textChunks(text);
  }
}

class AuditedLocalTempSandbox extends LocalTempSandbox {
  suspends = 0;
  resumes = 0;
  teardowns = 0;

  override async suspend(taskId: string): Promise<void> {
    this.suspends += 1;
    await super.suspend(taskId);
  }

  override async resume(
    taskId: string,
    bindings: Parameters<LocalTempSandbox['resume']>[1],
  ): Promise<void> {
    this.resumes += 1;
    await super.resume(taskId, bindings);
  }

  override async teardown(taskId: string): Promise<void> {
    this.teardowns += 1;
    await super.teardown(taskId);
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 8 exit matrix', () => {
  it('runs candidate → Leader rework → new candidate → Leader approval through durable Fork resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase8-exit-'));
    roots.push(root);
    const scope = { projectId: 'phase8-exit-project', taskId: 'phase8-exit-task' };
    const sandbox = new AuditedLocalTempSandbox();
    const worktree = await sandbox.createWorktree(scope.taskId, 'shared');
    await sandbox.write(
      worktree,
      'test-results.json',
      JSON.stringify({ passed: true, total: 1, failed: 0, failures: [] }),
    );
    const initial = applyMutations(
      createInitialAppState(scope.taskId, 'PROJECTION_SECRET durable completion', scope.projectId),
      [
        setMutation('phase', 'coding'),
        setMutation('iterationCount', 8),
        mergeByIdMutation('subtasks', 'phase8-work', {
          title: 'Verify completion authority',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
          worktree: worktree.path,
        }),
      ],
    );
    const coder = DEFAULT_ROSTER.find((entry) => entry.role === 'CODER');
    if (coder === undefined) throw new Error('CODER role is missing');
    const adapter = new Phase8Adapter();
    const sessionRoot = join(
      root,
      'projects',
      scope.projectId,
      'tasks',
      scope.taskId,
      'harness-sessions',
    );
    const source = new HarnessExecutor(coder, {
      adapter,
      provider: 'agora-phase8-exit',
      sessionPersistence: {
        root: sessionRoot,
        cwd: worktree.path,
        projectId: scope.projectId,
        taskId: scope.taskId,
      },
    });
    await source.step({
      sessionId: 'phase8-exit-source',
      view: project(initial, 'CODER', DEFAULT_ROSTER),
    });
    const sourceRef = await source.saveSafePoint();
    await source.dispose();
    const lineageChild = new HarnessExecutor(coder, {
      adapter,
      provider: 'agora-phase8-exit',
      sessionPersistence: {
        root: sessionRoot,
        cwd: worktree.path,
        projectId: scope.projectId,
        taskId: scope.taskId,
        resumeSessionId: 'phase8-preflight-child',
      },
    });
    await lineageChild.loadSafePoint(sourceRef);
    await lineageChild.step({
      sessionId: 'phase8-preflight-child',
      view: project(initial, 'CODER', DEFAULT_ROSTER),
    });
    await lineageChild.dispose();
    await sandbox.suspend(scope.taskId);

    const messages = createMessageRuntime(root, new ChannelStream());
    await messages.initializeState(
      scope,
      applyMutations(initial, [
        setMutation('humanGate', {
          gateId: 'human-gate:phase8-initial-limit',
          reason: 'iteration_limit',
          options: ['continue'],
          phase: 'coding',
          openedTs: 1,
          safePointRefs: [sourceRef],
        }),
      ]),
    );
    const runtime = new TaskOrchestrationRuntime(
      messages,
      createWebTaskCompositionFactory({
        sandbox,
        dataRoot: root,
        executorOptions: { adapter, provider: 'agora-phase8-exit', deepseek: false },
      }),
    );
    const post = createPostMessage(messages);

    await postLeader(
      post,
      scope,
      'continue-phase8',
      '/resolve-gate human-gate:phase8-initial-limit continue',
    );
    await runtime.waitForIdle(scope);
    let state = await requiredState(messages, scope);
    expect(state.humanGate?.reason).toBe('completion_confirmation:phase8-review-1');
    expect(state.messages.filter((message) => message.type === 'escalation')).toHaveLength(0);

    await postLeader(
      post,
      scope,
      'request-phase8-rework',
      `/resolve-gate ${state.humanGate?.gateId} request_changes Cover the restart path.`,
    );
    await runtime.waitForIdle(scope);
    state = await requiredState(messages, scope);
    expect(state.humanGate?.reason).toBe('completion_confirmation:phase8-review-2');
    expect(state.decisionLedger).toContainEqual(
      expect.objectContaining({
        id: 'task-completion-resolution:request-phase8-rework',
        decision: 'request_changes',
        authority: 'leader',
      }),
    );

    await postLeader(
      post,
      scope,
      'approve-phase8',
      `/resolve-gate ${state.humanGate?.gateId} approve_completion`,
    );
    await runtime.waitForIdle(scope);

    await expect(runtime.summary(scope)).resolves.toMatchObject({
      runStatus: 'completed',
      phase: 'done',
      artifactPath: join(
        root,
        'projects',
        scope.projectId,
        'tasks',
        scope.taskId,
        'artifacts',
        'worktree',
      ),
    });
    state = await requiredState(messages, scope);
    expect(state.messages.map((message) => message.msgId)).toEqual(
      expect.arrayContaining([
        'human-gate-resumed:continue-phase8',
        'human-gate-resumed:request-phase8-rework',
        'human-gate-resumed:approve-phase8',
      ]),
    );
    expect(state.decisionLedger).toContainEqual(
      expect.objectContaining({
        id: 'task-completion-resolution:approve-phase8',
        decision: 'approve_completion',
        authority: 'leader',
      }),
    );
    expect(sandbox.suspends).toBeGreaterThanOrEqual(3);
    expect(sandbox.resumes).toBe(3);
    expect(sandbox.teardowns).toBe(1);
    await expect(
      access(
        join(
          root,
          'projects',
          scope.projectId,
          'tasks',
          scope.taskId,
          'artifacts',
          'worktree',
          'test-results.json',
        ),
      ),
    ).resolves.toBeUndefined();

    const trace = await new HarnessTraceReader(root).read(scope);
    expect(trace.sessions.some((session) => session.parentSessionId !== undefined)).toBe(true);
    expect(JSON.stringify(trace)).not.toMatch(/PROJECTION_SECRET|arguments|results/i);
  }, 60_000);

  it('resets an iteration-limit gate atomically and replays without another gate or escalation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-phase8-limit-'));
    roots.push(root);
    const scope = { projectId: 'phase8-limit', taskId: 'task' };
    const messages = createMessageRuntime(root, new ChannelStream());
    const resumes: string[] = [];
    messages.bindHumanGateLifecyclePort({
      suspend: async () => {
        throw new Error('unexpected suspend');
      },
      resume: async (_scope, actionId) => {
        resumes.push(actionId);
      },
    });
    await messages.initializeState(
      scope,
      applyMutations(createInitialAppState(scope.taskId, 'goal', scope.projectId), [
        setMutation('iterationCount', 8),
        setMutation('humanGate', {
          gateId: 'human-gate:limit-1',
          reason: 'iteration_limit',
          options: ['continue'],
          phase: 'testing',
          openedTs: 1,
          safePointRefs: ['safe-1'],
        }),
      ]),
    );
    const post = createPostMessage(messages);
    const display = '/resolve-gate human-gate:limit-1 continue';
    await postLeader(post, scope, 'continue-limit', display);
    await postLeader(post, scope, 'continue-limit', display);
    const state = await requiredState(messages, scope);

    expect(state.iterationCount).toBe(0);
    expect(state.humanGate).toBeUndefined();
    expect(state.messages.filter((message) => message.msgId === 'continue-limit')).toHaveLength(1);
    expect(state.messages.filter((message) => message.type === 'escalation')).toHaveLength(0);
    expect(resumes).toEqual(['continue-limit', 'continue-limit']);
  });

  it('keeps objection tracks deterministic and rejects cross-topic decision replacement', () => {
    const base = applyMutations(createInitialAppState('task', 'goal'), [
      mergeByIdMutation('requirements', 'requirement-1', {
        story: 'Keep the requirements consistent.',
        acceptance: ['No contradiction remains.'],
        nonGoals: [],
      }),
      appendMutation('objections', {
        id: 'blocking-1',
        threadId: 'blocking-1',
        fromRole: 'PM',
        claim: 'contradiction',
        target: { kind: 'requirement', id: 'requirement-1' },
        argument: 'The requirements conflict.',
        track: 'blocking',
        ts: 1,
      }),
      appendMutation('objections', {
        id: 'advisory-1',
        threadId: 'advisory-1',
        fromRole: 'ARCHITECT',
        claim: 'concern',
        argument: 'Consider clearer naming.',
        track: 'advisory',
        ts: 2,
      }),
    ]);
    const routed = decide(base, { newId: () => 'ledger-1', now: () => 3 });
    expect(routed.route).toMatchObject({
      kind: 'human_gate',
      request: { reason: 'blocking_objection:blocking-1' },
    });
    expect(deriveObjectionResolutions(base)).toEqual([
      { objectionId: 'blocking-1', status: 'unresolved' },
      { objectionId: 'advisory-1', status: 'unresolved' },
    ]);

    const first = {
      id: 'decision-1',
      topic: 'runtime',
      decision: 'Use runtime A',
      rationale: 'Pinned baseline',
      authority: 'agent' as const,
      by: 'ARCHITECT',
      ts: 1,
    };
    expect(() =>
      addDecision([first], {
        ...first,
        id: 'decision-2',
        topic: 'storage',
        supersedes: first.id,
        ts: 2,
      }),
    ).toThrow('same topic');
  });
});

function projectionRole(options: GenerateOptions): string {
  const text = options.messages[0]?.content.find((block) => block.type === 'text');
  if (text?.type !== 'text') throw new Error('expected projected role input');
  const parsed = JSON.parse(text.text) as { role?: unknown };
  if (typeof parsed.role !== 'string') throw new Error('expected projected role');
  return parsed.role;
}

function* textChunks(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

async function postLeader(
  post: ReturnType<typeof createPostMessage>,
  scope: { projectId: string; taskId: string },
  msgId: string,
  display: string,
): Promise<void> {
  const response = await post(
    new Request('http://localhost/api/messages', {
      method: 'POST',
      body: JSON.stringify({ ...scope, channelId: 'main', msgId, display }),
    }),
  );
  await expect(response.json()).resolves.toMatchObject({ action: { status: 'applied' } });
}

async function requiredState(
  messages: ReturnType<typeof createMessageRuntime>,
  scope: { projectId: string; taskId: string },
) {
  const state = await messages.store.load(scope);
  if (state === undefined) throw new Error('expected persisted task state');
  return state;
}
