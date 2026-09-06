// R11/G5: only the external paid LLM stream is scripted. HTTP intent handling, JSON stores,
// MessageService, ProjectRosterService, WorkerRuntime, HarnessExecutor, collaboration CAS,
// safe-point persistence, deterministic handoff, and responsibility handling are real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyMutations, createInitialAppState, mergeByIdMutation } from '@agora/core-domain';
import { UnknownRoleError, WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor } from '@agora/runtime-executor';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ChannelEvent, ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';

class GatedAdapter extends LlmAdapter {
  streamCalls = 0;
  readonly started: Promise<void>;
  private markStarted = () => {};
  private releaseStream = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseStream = resolve;
  });

  constructor() {
    super();
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  release(): void {
    this.releaseStream();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.streamCalls += 1;
    this.markStarted();
    await this.gate;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'The in-flight step committed.' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'The in-flight step committed.' },
    };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-phase7-guardrails-'));
  roots.push(root);
  return root;
}

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 7 D12 guardrails', () => {
  it('keeps COORDINATOR enabled and records only the canonical rejected Leader audit message', async () => {
    const stream = new ChannelStream();
    const runtime = createMessageRuntime(await temporaryRoot(), stream);
    const scope = { projectId: 'guardrail-project', taskId: 'coordinator-task' };
    const beforeState = await runtime.initialize(scope, 'Protect the coordination kernel');
    const beforeCollaboration = await runtime.collaboration.load(scope.projectId);
    const events: ChannelEvent[] = [];
    const unsubscribe = stream.subscribe({ ...scope, channelId: 'main' }, (event) =>
      events.push(event),
    );

    try {
      await expect(runtime.roster.disableRole(scope.projectId, 'COORDINATOR')).rejects.toThrow(
        /COORDINATOR cannot be disabled/,
      );
      await expect(runtime.collaboration.load(scope.projectId)).resolves.toEqual(
        beforeCollaboration,
      );

      const response = await createPostMessage(runtime)(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'reject-remove-coordinator',
          display: '/role remove COORDINATOR',
        }),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        accepted: true,
        published: true,
        action: { status: 'rejected', reason: 'COORDINATOR cannot depart' },
      });
      const afterState = await runtime.store.load(scope);
      expect(afterState?.messages).toEqual([
        expect.objectContaining({
          msgId: 'reject-remove-coordinator',
          fromRole: 'leader',
          payload: {
            kind: 'leader_intent',
            intent: { kind: 'remove_role', targetRole: 'COORDINATOR' },
            action: { status: 'rejected', reason: 'COORDINATOR cannot depart' },
          },
        }),
      ]);
      expect(afterState && { ...afterState, messages: beforeState.messages }).toEqual(beforeState);
      await expect(runtime.collaboration.load(scope.projectId)).resolves.toEqual(
        beforeCollaboration,
      );
      expect(events).toEqual([expect.objectContaining({ type: 'message' })]);
    } finally {
      unsubscribe();
    }
  });

  it('blocks new work while one in-flight Harness step commits before the target drains', async () => {
    const root = await temporaryRoot();
    const runtime = createMessageRuntime(root, new ChannelStream());
    const scope = { projectId: 'guardrail-project', taskId: 'drain-task' };
    const initial = applyMutations(
      createInitialAppState(scope.taskId, 'Drain current coding safely', scope.projectId),
      [
        mergeByIdMutation('subtasks', 'coding-work', {
          title: 'Finish current coding work',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ],
    );
    await runtime.initializeState(scope, initial);
    const adapter = new GatedAdapter();
    const executors: HarnessExecutor[] = [];
    let saveSafePointSpy: ReturnType<typeof vi.spyOn> | undefined;
    const drains: Array<{
      role: string;
      activeWorkers: number;
      safePointRefs: readonly string[];
    }> = [];
    const worker = new WorkerRuntime({
      roster: DEFAULT_ROSTER,
      loadRoster: () => runtime.enabledRoleSpecs(scope.projectId),
      buildChannelContext: (state, role) => runtime.workerStepChannelContextFor(state, role),
      transition: async (_state, mutations) =>
        (await runtime.commitMutations(scope, mutations)).state,
      transitionStep: async (_state, role, mutations) =>
        (await runtime.commitWorkerStepMutations(scope, role, mutations)).state,
      buildExecutor: (spec) => {
        const executor = new HarnessExecutor(spec, {
          adapter,
          provider: 'agora',
          sessionPersistence: {
            root: join(root, 'harness-sessions'),
            cwd: root,
            projectId: scope.projectId,
            taskId: scope.taskId,
          },
        });
        saveSafePointSpy = vi.spyOn(executor, 'saveSafePoint');
        executors.push(executor);
        return executor;
      },
    });
    runtime.bindRoleDrainPort({
      awaitSafePoint: async (_scope, role) => {
        const result = await worker.awaitRoleSafePoint(role);
        drains.push(result);
        return result;
      },
    });

    try {
      const running = worker.runOne(initial, {
        workerId: 'worker:phase7-guardrail:coder',
        role: 'CODER',
        subtaskId: 'coding-work',
      });
      await adapter.started;
      const removal = createPostMessage(runtime)(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'remove-coder-guardrail',
          display: '/role remove CODER to TESTER',
        }),
      );
      await expect
        .poll(
          async () =>
            (await runtime.collaboration.load(scope.projectId))?.roster.find(
              (entry) => entry.spec.role === 'CODER',
            )?.status,
        )
        .toBe('departing');

      const commitLeaderMessage = runtime.commitLeaderMessage.bind(runtime);
      let markAssignmentQueued = () => {};
      const assignmentQueued = new Promise<void>((resolve) => {
        markAssignmentQueued = resolve;
      });
      vi.spyOn(runtime, 'commitLeaderMessage').mockImplementation((queuedScope, input) => {
        const queued = commitLeaderMessage(queuedScope, input);
        if (input.msgId === 'assign-departing-coder') markAssignmentQueued();
        return queued;
      });
      let assignmentSettled = false;
      const assignment = createPostMessage(runtime)(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'assign-departing-coder',
          display: '@CODER start another step',
        }),
      ).then((response) => {
        assignmentSettled = true;
        return response;
      });
      await assignmentQueued;
      expect(assignmentSettled).toBe(false);
      const whileDeparting = await runtime.store.load(scope);
      if (whileDeparting === undefined) throw new Error('expected persisted task state');
      expect(whileDeparting.messages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ msgId: 'assign-departing-coder' })]),
      );
      expect(whileDeparting.nextRole).not.toBe('CODER');
      await expect(
        runtime.commitMessage(scope, {
          msgId: 'departing-coder-message',
          channelId: 'main',
          fromRole: 'CODER',
          type: 'chat',
          payload: {},
          display: 'This new message must be rejected.',
          ts: 2_001,
        }),
      ).rejects.toThrow(/not enabled/);
      await expect(runtime.store.load(scope)).resolves.toEqual(whileDeparting);
      await expect(
        worker.runOne(whileDeparting, {
          workerId: 'worker:phase7-guardrail:departing-coder',
          role: 'CODER',
          subtaskId: 'new-coding-work',
        }),
      ).rejects.toBeInstanceOf(UnknownRoleError);
      expect(executors).toHaveLength(1);

      adapter.release();
      const [workerState, response, assignmentResponse] = await Promise.all([
        running,
        removal,
        assignment,
      ]);
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        action: { status: 'applied' },
      });
      expect(assignmentResponse.status).toBe(202);
      await expect(assignmentResponse.json()).resolves.toMatchObject({
        accepted: true,
        published: true,
        action: { status: 'rejected', reason: 'role "CODER" is disabled' },
      });
      expect(workerState.messages.at(-1)).toMatchObject({
        fromRole: 'CODER',
        display: 'The in-flight step committed.',
      });
      const saved = await runtime.store.load(scope);
      const committedIndex =
        saved?.messages.findIndex(
          (message) => message.display === 'The in-flight step committed.',
        ) ?? -1;
      const handoffIndex =
        saved?.messages.findIndex(
          (message) => message.msgId === 'role-departure:remove-coder-guardrail',
        ) ?? -1;
      expect(committedIndex).toBeGreaterThanOrEqual(0);
      expect(handoffIndex).toBeGreaterThan(committedIndex);
      expect(drains).toEqual([
        { role: 'CODER', activeWorkers: 1, safePointRefs: [expect.any(String)] },
      ]);
      expect(adapter.streamCalls).toBe(1);
      expect(saveSafePointSpy).toHaveBeenCalledTimes(1);
      expect(worker.paused).toBe(false);
      await expect(runtime.collaboration.load(scope.projectId)).resolves.toMatchObject({
        roster: expect.arrayContaining([
          expect.objectContaining({
            spec: expect.objectContaining({ role: 'CODER' }),
            status: 'departed',
            departure: expect.objectContaining({ stage: 'completed' }),
          }),
        ]),
      });
    } finally {
      adapter.release();
      await Promise.all(executors.map((executor) => executor.dispose()));
    }
  });

  it('keeps unfinished responsibilities awaiting replacement across an idempotent HTTP replay', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'guardrail-project', taskId: 'orphan-task' };
    await runtime.initializeState(
      scope,
      applyMutations(
        createInitialAppState(scope.taskId, 'Do not orphan unfinished work', scope.projectId),
        [
          mergeByIdMutation('subtasks', 'orphaned-work', {
            title: 'Still owned by the departing coder',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress',
          }),
        ],
      ),
    );
    const post = createPostMessage(runtime);
    const request = () =>
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'remove-coder-without-replacement',
          display: '/role remove CODER',
        }),
      );

    const first = await request();
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      accepted: true,
      action: {
        status: 'blocked',
        reason: 'role_departure_requires_replacement:CODER',
      },
    });
    const firstState = await runtime.store.load(scope);
    const firstCollaboration = await runtime.collaboration.load(scope.projectId);
    expect(firstState).toMatchObject({
      subtasks: [{ id: 'orphaned-work', ownerRole: 'CODER', status: 'blocked' }],
      humanGate: {
        reason: 'role_departure_requires_replacement:CODER',
        options: ['assign_enabled_successor'],
      },
      handoffPackets: [expect.objectContaining({ fromRole: 'CODER', toRole: 'leader' })],
    });
    expect(firstCollaboration).toMatchObject({
      roster: expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({ role: 'CODER' }),
          status: 'departing',
          departure: expect.objectContaining({ stage: 'awaiting_replacement' }),
        }),
      ]),
    });

    const replay = await request();
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      published: false,
      action: { status: 'blocked' },
    });
    await expect(runtime.store.load(scope)).resolves.toEqual(firstState);
    await expect(runtime.collaboration.load(scope.projectId)).resolves.toEqual(firstCollaboration);
  });
});
