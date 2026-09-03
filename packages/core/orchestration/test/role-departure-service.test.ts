import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageBus, MessageCommitted } from '@agora/comm-bus';
import {
  JsonProjectChannelStore,
  JsonProjectCollaborationStore,
  type ProjectCollaborationStore,
} from '@agora/comm-channels';
import {
  createInitialAppState,
  createMainChannel,
  type RoleSpec,
  type RosterEntry,
} from '@agora/core-domain';
import { JsonTaskStateStore, type TaskScope } from '@agora/runtime-state';
import { afterEach, describe, expect, it } from 'vitest';

import { MessageService, RoleDepartureService } from '../src/index';

// Mock 原因（R11）：离职服务单测仅以 RecordingDrain 隔离 WorkerRuntime 的并发时序；
// WorkerRuntime 当前 Step 提交后再保存安全点由 worker-runtime.test.ts 独立覆盖。
class RecordingDrain {
  readonly calls: { scope: TaskScope; role: string }[] = [];

  async awaitSafePoint(scope: TaskScope, role: string) {
    this.calls.push({ scope, role });
    return { role, activeWorkers: 1, safePointRefs: ['cursor-1'] };
  }
}

class RecordingBus implements MessageBus {
  readonly events: MessageCommitted[] = [];

  async publish(event: MessageCommitted): Promise<void> {
    this.events.push(event);
  }
}

const roots: string[] = [];
const scope = { projectId: 'project-a', taskId: 'task-a' } as const;

function spec(role: string): RoleSpec {
  return {
    role,
    executor: 'harness',
    systemPrompt: `${role} responsibilities.`,
    tools: [],
    projection: ['global.summary'],
    routeWhen: 'always',
  };
}

const initialRoster: readonly RosterEntry[] = ['COORDINATOR', 'CODER', 'TESTER'].map((role) => ({
  spec: spec(role),
  status: 'enabled',
}));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agora-role-departure-test-'));
  roots.push(root);
  const collaboration = new JsonProjectCollaborationStore(root);
  await collaboration.initialize(scope.projectId, initialRoster, [
    createMainChannel(initialRoster.map((entry) => entry.spec.role)),
  ]);
  const state = new JsonTaskStateStore(root);
  const initial = createInitialAppState(scope.taskId, 'ship feature', scope.projectId);
  initial.phase = 'coding';
  initial.subtasks = [
    {
      id: 'done-z',
      title: 'Finished work',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'done',
    },
    {
      id: 'open-a',
      title: 'Finish implementation',
      ownerRole: 'CODER',
      dependsOn: [],
      status: 'in_progress',
    },
  ];
  initial.testResults = {
    passed: false,
    total: 1,
    failed: 1,
    failures: [{ test: 'feature', message: 'not done', file: 'src/feature.ts', line: 42 }],
  };
  await state.initialize(scope, initial);
  const channels = new JsonProjectChannelStore(collaboration, initialRoster);
  const bus = new RecordingBus();
  const messages = new MessageService(state, bus, channels, collaboration);
  const drain = new RecordingDrain();
  const service = new RoleDepartureService({ collaboration, state, messages, drain });
  return { bus, collaboration, drain, messages, service, state };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RoleDepartureService', () => {
  it('drains, commits deterministic handoff and responsibility transfer, then departs', async () => {
    const { bus, collaboration, drain, service, state } = await fixture();
    const input = {
      scope,
      actor: 'leader' as const,
      actionId: 'remove-coder-1',
      role: 'CODER',
      successorRole: 'TESTER',
      requestedTs: 1_000,
    };

    const result = await service.depart(input);

    expect(result.status).toBe('applied');
    expect(drain.calls).toEqual([{ scope, role: 'CODER' }]);
    const saved = await state.load(scope);
    expect(saved?.subtasks.find((entry) => entry.id === 'open-a')).toMatchObject({
      ownerRole: 'TESTER',
      status: 'in_progress',
    });
    expect(saved?.handoffPackets).toEqual([
      {
        fromRole: 'CODER',
        toRole: 'TESTER',
        done: 'Phase coding; completed subtasks: done-z (Finished work).',
        keyDecisions: [],
        openIssues: [
          'Subtask open-a (in_progress): Finish implementation',
          'Recommendation: TESTER should continue subtask open-a.',
        ],
        fileRefs: ['src/feature.ts:42'],
        ts: 1_000,
      },
    ]);
    expect(saved?.messages.at(-1)).toMatchObject({
      msgId: 'role-departure:remove-coder-1',
      fromRole: 'COORDINATOR',
      to: ['TESTER'],
      type: 'handoff',
      payload: { kind: 'role_departure_handoff', actionId: 'remove-coder-1' },
    });
    expect(bus.events).toHaveLength(1);
    const project = await collaboration.load(scope.projectId);
    expect(project?.roster.find((entry) => entry.spec.role === 'CODER')).toMatchObject({
      status: 'departed',
      departure: {
        actionId: 'remove-coder-1',
        stage: 'completed',
        handoffRef: { taskId: scope.taskId, msgId: 'role-departure:remove-coder-1' },
      },
    });
    expect(project?.channels[0]?.participants).toEqual(['leader', 'COORDINATOR', 'TESTER']);

    const replay = await service.depart(input);
    expect(replay.status).toBe('applied');
    expect(drain.calls).toHaveLength(1);
    expect((await state.load(scope))?.handoffPackets).toHaveLength(1);
    expect(bus.events).toHaveLength(1);
  });

  it('blocks orphan responsibilities and keeps the role awaiting replacement', async () => {
    const { collaboration, service, state } = await fixture();

    const result = await service.depart({
      scope,
      actor: 'leader',
      actionId: 'remove-coder-without-successor',
      role: 'CODER',
      requestedTs: 2_000,
    });

    expect(result.status).toBe('blocked');
    const saved = await state.load(scope);
    expect(saved?.subtasks.find((entry) => entry.id === 'open-a')).toMatchObject({
      ownerRole: 'CODER',
      status: 'blocked',
    });
    expect(saved?.humanGate).toEqual({
      gateId: 'human-gate:role-departure:remove-coder-without-successor',
      reason: 'role_departure_requires_replacement:CODER',
      options: ['assign_enabled_successor'],
      phase: 'coding',
      openedTs: 2000,
      safePointRefs: [],
    });
    expect(
      (await collaboration.load(scope.projectId))?.roster.find(
        (entry) => entry.spec.role === 'CODER',
      ),
    ).toMatchObject({ status: 'departing', departure: { stage: 'awaiting_replacement' } });
  });

  it('resumes after a final collaboration CAS failure without repeating drain or Task State facts', async () => {
    const { bus, collaboration, drain, messages, state } = await fixture();
    let failFinalCommit = true;
    const flaky: ProjectCollaborationStore = {
      initialize: (...args) => collaboration.initialize(...args),
      load: (...args) => collaboration.load(...args),
      commit: async (...args) => {
        if (args[1] === 1 && failFinalCommit) {
          failFinalCommit = false;
          throw new Error('injected final CAS failure');
        }
        return collaboration.commit(...args);
      },
    };
    const service = new RoleDepartureService({ collaboration: flaky, state, messages, drain });
    const input = {
      scope,
      actor: 'leader' as const,
      actionId: 'recoverable-remove-coder',
      role: 'CODER',
      successorRole: 'TESTER',
      requestedTs: 3_000,
    };

    await expect(service.depart(input)).rejects.toThrow('injected final CAS failure');
    expect(drain.calls).toHaveLength(1);
    expect((await state.load(scope))?.handoffPackets).toHaveLength(1);
    expect(
      (await collaboration.load(scope.projectId))?.roster.find(
        (entry) => entry.spec.role === 'CODER',
      ),
    ).toMatchObject({ status: 'departing', departure: { stage: 'draining' } });

    await expect(service.depart({ ...input, requestedTs: 9_999 })).resolves.toMatchObject({
      status: 'applied',
    });
    expect(drain.calls).toHaveLength(1);
    expect((await state.load(scope))?.handoffPackets).toEqual([
      expect.objectContaining({ ts: 3_000 }),
    ]);
    expect(bus.events).toHaveLength(1);
    expect(
      (await collaboration.load(scope.projectId))?.roster.find(
        (entry) => entry.spec.role === 'CODER',
      ),
    ).toMatchObject({ status: 'departed', departure: { stage: 'completed' } });
  });

  it('fails closed when the derived handoff message id is occupied by another message', async () => {
    const { drain, messages, service, state } = await fixture();
    await messages.commitMessage(scope, {
      msgId: 'role-departure:colliding-action',
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat',
      payload: {},
      display: 'Unrelated prior message',
      ts: 500,
    });

    await expect(
      service.depart({
        scope,
        actor: 'leader',
        actionId: 'colliding-action',
        role: 'CODER',
        successorRole: 'TESTER',
        requestedTs: 4_000,
      }),
    ).rejects.toThrow(/handoff message.*conflicts/i);

    expect(drain.calls).toHaveLength(0);
    await expect(state.load(scope)).resolves.toMatchObject({
      subtasks: [
        { id: 'done-z', ownerRole: 'CODER', status: 'done' },
        { id: 'open-a', ownerRole: 'CODER', status: 'in_progress' },
      ],
      handoffPackets: [],
    });
  });
});
