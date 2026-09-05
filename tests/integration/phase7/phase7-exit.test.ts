// R11/G5: only the external paid LLM stream is scripted. HTTP intent handling,
// JSON stores, collaboration CAS, ProjectRosterService, WorkerRuntime, HarnessExecutor,
// safe-point persistence, deterministic handoff, onboarding projection, and replay are real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  type RoleSpec,
} from '@agora/core-domain';
import { WorkerRuntime } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor } from '@agora/runtime-executor';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';

const RELEASE_MANAGER: RoleSpec = {
  role: 'RELEASE_MANAGER',
  executor: 'harness',
  systemPrompt: 'Coordinate release readiness from structured task facts.',
  tools: [],
  projection: ['goal'],
  routeWhen: 'leaderAssigned',
};

class GatedAdapter extends LlmAdapter {
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
    this.markStarted();
    await this.gate;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Exit-chain coding step committed.' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Exit-chain coding step committed.' },
    };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

class CapturingAdapter extends LlmAdapter {
  readonly inputs: string[] = [];

  async *stream(options: Parameters<LlmAdapter['stream']>[0]): AsyncIterable<StreamChunk> {
    this.inputs.push(
      options.messages
        .flatMap((message) => message.content)
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('\n'),
    );
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Exit-chain handoff accepted.' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Exit-chain handoff accepted.' },
    };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase 7 role-lifecycle exit chain', () => {
  it('registers, drains, hands off, replays, restarts, and onboards through one persisted world', async () => {
    const root = await temporaryRoot();
    const runtime = createMessageRuntime(root, new ChannelStream());
    const scope = { projectId: 'phase7-exit-project', taskId: 'phase7-exit-task' };
    const initial = applyMutations(
      createInitialAppState(scope.taskId, 'Complete the Phase 7 lifecycle', scope.projectId),
      [
        mergeByIdMutation('subtasks', 'coding-work', {
          title: 'Finish before departure',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ],
    );
    await runtime.initializeState(scope, initial);

    const commitEvents: string[] = [];
    let handoffCommittedWithTransferredOwner = false;
    let departedObservedTransferredOwner = false;
    const taskCommit = runtime.store.commit.bind(runtime.store);
    runtime.store.commit = async (commitScope, mutations) => {
      const committed = await taskCommit(commitScope, mutations);
      if (
        !commitEvents.includes('handoff-commit') &&
        committed.state.messages.some(
          (message) => message.msgId === 'role-departure:remove-coder-exit',
        )
      ) {
        handoffCommittedWithTransferredOwner =
          committed.state.subtasks.find((entry) => entry.id === 'coding-work')?.ownerRole ===
          'TESTER';
        commitEvents.push('handoff-commit');
      }
      return committed;
    };
    const collaborationCommit = runtime.collaboration.commit.bind(runtime.collaboration);
    runtime.collaboration.commit = async (projectId, expectedRevision, next) => {
      const committed = await collaborationCommit(projectId, expectedRevision, next);
      if (
        !commitEvents.includes('departed-commit') &&
        committed.snapshot.roster.some(
          (entry) => entry.spec.role === 'CODER' && entry.status === 'departed',
        )
      ) {
        const stateAtDeparture = await runtime.store.load(scope);
        departedObservedTransferredOwner =
          stateAtDeparture?.subtasks.find((entry) => entry.id === 'coding-work')?.ownerRole ===
          'TESTER';
        commitEvents.push('departed-commit');
      }
      return committed;
    };

    const beforeRegistration = await runtime.collaboration.load(scope.projectId);
    if (beforeRegistration === undefined) throw new Error('expected initial collaboration');
    await runtime.roster.addRole(scope.projectId, RELEASE_MANAGER);
    const afterRegistration = await runtime.collaboration.load(scope.projectId);
    expect(afterRegistration).toMatchObject({
      revision: beforeRegistration.revision + 1,
      roster: expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({ role: 'RELEASE_MANAGER' }),
          status: 'enabled',
        }),
      ]),
      channels: [
        expect.objectContaining({
          kind: 'main',
          participants: expect.arrayContaining(['RELEASE_MANAGER']),
        }),
      ],
    });

    const coderAdapter = new GatedAdapter();
    const coderExecutors: HarnessExecutor[] = [];
    let safePointSpy: ReturnType<typeof vi.spyOn> | undefined;
    const coderWorker = new WorkerRuntime({
      roster: DEFAULT_ROSTER,
      loadRoster: () => runtime.enabledRoleSpecs(scope.projectId),
      buildChannelContext: (state, role) => runtime.workerStepChannelContextFor(state, role),
      transition: async (_state, mutations) =>
        (await runtime.commitMutations(scope, mutations)).state,
      transitionStep: async (_state, role, mutations) => {
        const committed = await runtime.commitWorkerStepMutations(scope, role, mutations);
        commitEvents.push(
          mutations.every((mutation) => mutation.field === 'workers')
            ? 'worker-state-commit'
            : 'step-commit',
        );
        return committed.state;
      },
      buildExecutor: (spec) => {
        const executor = new HarnessExecutor(spec, {
          adapter: coderAdapter,
          provider: 'agora',
          sessionPersistence: {
            root: join(root, 'harness-sessions'),
            cwd: root,
            projectId: scope.projectId,
            taskId: scope.taskId,
          },
        });
        const saveSafePoint = executor.saveSafePoint.bind(executor);
        safePointSpy = vi.spyOn(executor, 'saveSafePoint').mockImplementation(async () => {
          const ref = await saveSafePoint();
          commitEvents.push('safe-point');
          return ref;
        });
        coderExecutors.push(executor);
        return executor;
      },
    });
    runtime.bindRoleDrainPort({
      awaitSafePoint: async (_scope, role) => coderWorker.awaitRoleSafePoint(role),
    });

    try {
      const running = coderWorker.runOne(initial, {
        workerId: 'worker:phase7-exit:coder',
        role: 'CODER',
        subtaskId: 'coding-work',
      });
      await coderAdapter.started;
      const post = createPostMessage(runtime);
      const removal = post(
        messageRequest(scope, 'remove-coder-exit', '/role remove CODER to TESTER'),
      );
      await expect
        .poll(
          async () =>
            (await runtime.collaboration.load(scope.projectId))?.roster.find(
              (entry) => entry.spec.role === 'CODER',
            )?.status,
        )
        .toBe('departing');
      coderAdapter.release();
      const [, removed] = await Promise.all([running, removal]);
      await expect(removed.json()).resolves.toMatchObject({ action: { status: 'applied' } });
      expect(safePointSpy).toHaveBeenCalledTimes(1);
      expect(commitEvents).toEqual([
        'worker-state-commit',
        'step-commit',
        'safe-point',
        'worker-state-commit',
        'handoff-commit',
        'departed-commit',
      ]);
      expect(handoffCommittedWithTransferredOwner).toBe(true);
      expect(departedObservedTransferredOwner).toBe(true);

      const stateAfterDeparture = await runtime.store.load(scope);
      const collaborationAfterDeparture = await runtime.collaboration.load(scope.projectId);
      if (stateAfterDeparture === undefined || collaborationAfterDeparture === undefined) {
        throw new Error('expected completed departure state');
      }
      const committedIndex = stateAfterDeparture.messages.findIndex(
        (message) => message.display === 'Exit-chain coding step committed.',
      );
      const handoffIndex = stateAfterDeparture.messages.findIndex(
        (message) => message.msgId === 'role-departure:remove-coder-exit',
      );
      expect(handoffIndex).toBeGreaterThan(committedIndex);
      expect(stateAfterDeparture.subtasks).toEqual([
        expect.objectContaining({ id: 'coding-work', ownerRole: 'TESTER' }),
      ]);
      expect(collaborationAfterDeparture.roster).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            spec: expect.objectContaining({ role: 'CODER' }),
            status: 'departed',
            departure: expect.objectContaining({ stage: 'completed' }),
          }),
        ]),
      );

      const replay = await post(
        messageRequest(scope, 'remove-coder-exit', '/role remove CODER to TESTER'),
      );
      await expect(replay.json()).resolves.toMatchObject({
        published: false,
        action: { status: 'applied' },
      });
      await expect(runtime.store.load(scope)).resolves.toEqual(stateAfterDeparture);
      await expect(runtime.collaboration.load(scope.projectId)).resolves.toEqual(
        collaborationAfterDeparture,
      );

      const onboarded = await post(
        messageRequest(scope, 'onboard-tester-exit', '/role onboard TESTER'),
      );
      await expect(onboarded.json()).resolves.toMatchObject({ action: { status: 'applied' } });

      const restarted = createMessageRuntime(root, new ChannelStream());
      const persisted = await restarted.store.load(scope);
      if (persisted === undefined) throw new Error('expected restarted task state');
      const testerAdapter = new CapturingAdapter();
      const testerExecutors: HarnessExecutor[] = [];
      const testerWorker = new WorkerRuntime({
        roster: [],
        loadRoster: () => restarted.enabledRoleSpecs(scope.projectId),
        buildChannelContext: (state, role) => restarted.channelContextFor(state, role),
        transition: async (_state, mutations) =>
          (await restarted.commitMutations(scope, mutations)).state,
        transitionStep: async (_state, role, mutations) =>
          (await restarted.commitWorkerStepMutations(scope, role, mutations)).state,
        buildExecutor: (spec) => {
          const executor = new HarnessExecutor(spec, { adapter: testerAdapter, provider: 'agora' });
          testerExecutors.push(executor);
          return executor;
        },
      });
      try {
        await testerWorker.runOne(persisted, {
          workerId: 'worker:phase7-exit:tester',
          role: 'TESTER',
          subtaskId: 'coding-work',
        });
      } finally {
        await Promise.all(testerExecutors.map((executor) => executor.dispose()));
      }
      expect(testerAdapter.inputs).toHaveLength(1);
      expect(testerAdapter.inputs[0]).toContain('"actionId":"onboard-tester-exit"');
      expect(testerAdapter.inputs[0]).toContain('"msgId":"role-departure:remove-coder-exit"');
      expect(testerAdapter.inputs[0]).not.toContain('/role remove CODER to TESTER');
      expect(testerAdapter.inputs[0]).not.toContain('/role onboard TESTER');
      expect(testerAdapter.inputs[0]).not.toContain('Role CODER handoff is ready');

      const beforeCoordinatorRejection = await restarted.collaboration.load(scope.projectId);
      const rejected = await createPostMessage(restarted)(
        messageRequest(scope, 'remove-coordinator-exit', '/role remove COORDINATOR'),
      );
      await expect(rejected.json()).resolves.toMatchObject({
        action: { status: 'rejected', reason: 'COORDINATOR cannot depart' },
      });
      await expect(restarted.collaboration.load(scope.projectId)).resolves.toEqual(
        beforeCoordinatorRejection,
      );
    } finally {
      coderAdapter.release();
      await Promise.all(coderExecutors.map((executor) => executor.dispose()));
    }
  });

  it('keeps orphaned responsibility awaiting replacement across a stable replay', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'phase7-orphan-project', taskId: 'phase7-orphan-task' };
    await runtime.initializeState(
      scope,
      applyMutations(
        createInitialAppState(scope.taskId, 'Require a replacement', scope.projectId),
        [
          mergeByIdMutation('subtasks', 'orphan', {
            title: 'Unfinished responsibility',
            ownerRole: 'CODER',
            dependsOn: [],
            status: 'in_progress',
          }),
        ],
      ),
    );
    const post = createPostMessage(runtime);
    const request = () =>
      post(messageRequest(scope, 'remove-coder-orphan-exit', '/role remove CODER'));

    const first = await request();
    await expect(first.json()).resolves.toMatchObject({ action: { status: 'blocked' } });
    const firstState = await runtime.store.load(scope);
    const firstCollaboration = await runtime.collaboration.load(scope.projectId);
    expect(firstState).toMatchObject({
      subtasks: [{ id: 'orphan', ownerRole: 'CODER', status: 'blocked' }],
      humanGate: { reason: 'role_departure_requires_replacement:CODER' },
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
    await expect(replay.json()).resolves.toMatchObject({
      published: false,
      action: { status: 'blocked' },
    });
    await expect(runtime.store.load(scope)).resolves.toEqual(firstState);
    await expect(runtime.collaboration.load(scope.projectId)).resolves.toEqual(firstCollaboration);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-phase7-exit-'));
  roots.push(root);
  return root;
}

function messageRequest(
  scope: { projectId: string; taskId: string },
  msgId: string,
  display: string,
): Request {
  return new Request('http://localhost/api/messages', {
    method: 'POST',
    body: JSON.stringify({ ...scope, channelId: 'main', msgId, display }),
  });
}
