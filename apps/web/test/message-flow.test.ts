// Test seam: one case pauses the real TaskStateStore.load call to make the
// snapshot-to-subscription race deterministic; the JSON store, commit, and stream stay real.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendMutation,
  applyMutations,
  beginRoleDeparture,
  createInitialAppState,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';
import { decide, latestCoordinationLedger } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { JsonTaskStateStore } from '@agora/runtime-state';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStream } from '../src/server/channel-stream';
import {
  createGetChannels,
  createGetStream,
  createPostMessage,
} from '../src/server/message-handlers';
import { createMessageRuntime, getOrCreateMessageRuntime } from '../src/server/message-runtime';

const decoder = new TextDecoder();
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agora-web-message-flow-test-'));
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

describe('persisted HTTP + SSE message flow', () => {
  it('atomically resolves an advisory objection and validates its full replay facts', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const objection = {
      id: 'obj-advisory-1',
      threadId: 'obj-advisory-1',
      fromRole: 'ARCHITECT',
      claim: 'concern' as const,
      argument: 'Prefer a clearer interface name.',
      track: 'advisory' as const,
      ts: 10,
    };
    await runtime.initializeState(
      scope,
      applyMutations(createInitialAppState(scope.taskId, 'Task task-a', scope.projectId), [
        appendMutation('objections', objection),
      ]),
    );
    const post = createPostMessage(runtime);
    const request = () =>
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'resolve-advisory-1',
          display:
            '/resolve-objection obj-advisory-1 accept_objection The clearer name improves reviewability.',
          ts: 11,
        }),
      );
    const first = await request();
    await expect(first.json()).resolves.toMatchObject({
      accepted: true,
      published: true,
      action: { status: 'applied' },
    });
    const state = await runtime.store.load(scope);
    expect(state?.decisionLedger).toContainEqual(
      expect.objectContaining({
        id: 'objection-resolution:resolve-advisory-1',
        authority: 'leader',
        decision: 'accept_objection',
        objectionResolution: {
          objectionId: 'obj-advisory-1',
          outcome: 'accepted',
        },
      }),
    );
    expect(state?.messages).toContainEqual(
      expect.objectContaining({
        msgId: 'resolve-advisory-1',
        payload: expect.objectContaining({
          objectionResolution: {
            objectionId: 'obj-advisory-1',
            option: 'accept_objection',
            resolutionDecisionId: 'objection-resolution:resolve-advisory-1',
          },
        }),
      }),
    );
    const replay = await request();
    await expect(replay.json()).resolves.toMatchObject({ published: false });
  });

  it('atomically accepts a blocking decision objection before resuming from its receipt', async () => {
    const root = await temporaryRoot();
    const runtime = createMessageRuntime(root, new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const resumed: string[] = [];
    runtime.bindHumanGateLifecyclePort({
      suspend: async () => {
        throw new Error('unexpected suspend');
      },
      resume: async (_scope, actionId) => {
        resumed.push(actionId);
      },
    });
    const objection = {
      id: 'obj-blocking-1',
      threadId: 'obj-blocking-1',
      fromRole: 'PM',
      claim: 'contradiction' as const,
      target: { kind: 'decision' as const, id: 'dec-agent-1' },
      argument: 'The runtime conflicts with the deployment baseline.',
      track: 'blocking' as const,
      ts: 10,
    };
    await runtime.initializeState(
      scope,
      applyMutations(createInitialAppState(scope.taskId, 'Task task-a', scope.projectId), [
        appendMutation('decisionLedger', {
          id: 'dec-agent-1',
          topic: 'runtime',
          decision: 'Use runtime A',
          rationale: 'Initial choice',
          authority: 'agent',
          by: 'ARCHITECT',
          ts: 9,
        }),
        appendMutation('objections', objection),
        setMutation('humanGate', {
          gateId: 'human-gate:obj-blocking-1',
          reason: 'blocking_objection:obj-blocking-1',
          options: ['accept_objection', 'reject_objection'],
          phase: 'planning',
          openedTs: 10,
          safePointRefs: ['opaque-safe-point-1'],
        }),
      ]),
    );
    const post = createPostMessage(runtime);
    const request = () =>
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'resolve-blocking-1',
          display:
            '/resolve-gate human-gate:obj-blocking-1 accept_objection The deployment baseline is controlling.',
          ts: 11,
        }),
      );
    const first = await request();
    await expect(first.json()).resolves.toMatchObject({ action: { status: 'applied' } });
    const state = await runtime.store.load(scope);
    expect(state).not.toHaveProperty('humanGate');
    expect(state?.decisionLedger).toContainEqual(
      expect.objectContaining({
        id: 'objection-resolution:resolve-blocking-1',
        authority: 'leader',
        supersedes: 'dec-agent-1',
      }),
    );
    expect(resumed).toEqual(['resolve-blocking-1']);
    const replay = await request();
    await expect(replay.json()).resolves.toMatchObject({ published: false });
    expect(resumed).toEqual(['resolve-blocking-1', 'resolve-blocking-1']);

    const snapshotPath = join(
      root,
      'projects',
      scope.projectId,
      'tasks',
      scope.taskId,
      'state.json',
    );
    const corrupted = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      messages: Array<{ msgId: string; payload: Record<string, unknown> }>;
    };
    const resolutionMessage = corrupted.messages.find(
      (message) => message.msgId === 'resolve-blocking-1',
    );
    expect(resolutionMessage).toBeDefined();
    delete resolutionMessage?.payload.objectionResolution;
    await writeFile(snapshotPath, `${JSON.stringify(corrupted, null, 2)}\n`, 'utf8');
    await expect(request()).rejects.toThrow(/incomplete effects/i);
  });

  it('atomically resolves a durable humanGate and retries resume from the canonical receipt', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const resumed: Array<{ actionId: string; resumeSessionId: string }> = [];
    runtime.bindHumanGateLifecyclePort({
      suspend: async () => {
        throw new Error('unexpected suspend');
      },
      resume: async (_scope, actionId, receipt) => {
        resumed.push({ actionId, resumeSessionId: receipt.resumeSessionId });
      },
    });
    await runtime.initializeState(
      scope,
      applyMutations(createInitialAppState(scope.taskId, 'Task task-a', scope.projectId), [
        setMutation('iterationCount', 8),
        setMutation('humanGate', {
          gateId: 'human-gate:iteration-limit-1',
          reason: 'iteration_limit',
          options: ['continue'],
          phase: 'coding',
          openedTs: 100,
          safePointRefs: ['opaque-safe-point-1'],
        }),
      ]),
    );
    const post = createPostMessage(runtime);
    const request = () =>
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'resolve-iteration-1',
          display: '/resolve-gate human-gate:iteration-limit-1 continue',
        }),
      );

    const first = await request();
    await expect(first.json()).resolves.toMatchObject({
      accepted: true,
      published: true,
      action: { status: 'applied' },
    });
    const resolved = await runtime.store.load(scope);
    expect(resolved?.iterationCount).toBe(0);
    expect(resolved).not.toHaveProperty('humanGate');
    expect(resolved?.messages).toContainEqual(
      expect.objectContaining({
        msgId: 'resolve-iteration-1',
        payload: expect.objectContaining({
          resolution: {
            gateId: 'human-gate:iteration-limit-1',
            option: 'continue',
            safePointRefs: ['opaque-safe-point-1'],
            resumeSessionId: 'human-gate-resume:resolve-iteration-1',
          },
        }),
      }),
    );
    expect(resumed).toEqual([
      {
        actionId: 'resolve-iteration-1',
        resumeSessionId: 'human-gate-resume:resolve-iteration-1',
      },
    ]);

    const replay = await request();
    await expect(replay.json()).resolves.toMatchObject({ published: false });
    expect(resumed).toHaveLength(2);
    await expect(
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'resolve-iteration-1',
          display: '/resolve-gate human-gate:iteration-limit-1 retry',
        }),
      ),
    ).rejects.toThrow(/conflicts/i);
    await expect(
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'resolve-iteration-1',
          display: 'reuse the resolution id as chat',
        }),
      ),
    ).rejects.toThrow(/conflicts with its first write/i);
    await expect(
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'resolve-iteration-1',
          display: '/resolve-gate',
        }),
      ),
    ).rejects.toThrow(/conflicts with its first write/i);
    await expect(
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'resolve-stale-gate',
          display: '/resolve-gate human-gate:stale continue',
        }),
      ),
    ).rejects.toThrow(/no active humanGate/i);
    expect((await runtime.store.load(scope))?.messages).toHaveLength(1);
  });

  it('atomically persists role onboarding with direct handoff refs and keeps replay selection stable', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const post = createPostMessage(runtime);

    await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'remove-coder',
        display: '/role remove CODER to TESTER',
      }),
    );
    const onboard = await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'onboard-tester',
        display: '/role onboard TESTER',
      }),
    );

    await expect(onboard.json()).resolves.toMatchObject({
      accepted: true,
      published: true,
      action: { status: 'applied' },
    });
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      nextRole: 'TESTER',
      messages: expect.arrayContaining([
        expect.objectContaining({
          msgId: 'onboard-tester',
          payload: {
            kind: 'leader_intent',
            intent: {
              kind: 'onboard_role',
              targetRole: 'TESTER',
              entrustedHandoffMsgIds: [],
            },
            action: { status: 'applied' },
            onboarding: {
              actionId: 'onboard-tester',
              role: 'TESTER',
              handoffRefs: [{ taskId: 'task-a', msgId: 'role-departure:remove-coder' }],
            },
          },
        }),
      ]),
    });

    await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'remove-pm',
        display: '/role remove PM to TESTER',
      }),
    );
    const replay = await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'onboard-tester',
        display: '/role onboard TESTER',
      }),
    );
    await expect(replay.json()).resolves.toMatchObject({ published: false });
    const replayed = await runtime.store.load(scope);
    const receipt = replayed?.messages.find((message) => message.msgId === 'onboard-tester')
      ?.payload.onboarding;
    expect(receipt).toMatchObject({
      handoffRefs: [{ taskId: 'task-a', msgId: 'role-departure:remove-coder' }],
    });

    await expect(
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'onboard-tester',
          display: '/role onboard COORDINATOR',
        }),
      ),
    ).rejects.toThrow(/conflicts/i);
  });

  it('fails closed when an applied onboarding replay has a persisted malformed receipt', async () => {
    const root = await temporaryRoot();
    const runtime = createMessageRuntime(root, new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const post = createPostMessage(runtime);

    await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'onboard-tester-malformed',
        display: '/role onboard TESTER',
      }),
    );

    const statePath = join(root, 'projects', scope.projectId, 'tasks', scope.taskId, 'state.json');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      messages: Array<{ msgId: string; payload: Record<string, unknown> }>;
    };
    const onboarding = persisted.messages.find(
      (message) => message.msgId === 'onboard-tester-malformed',
    );
    if (onboarding === undefined) throw new Error('expected persisted onboarding message');
    delete onboarding.payload.onboarding;
    await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

    await expect(
      post(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'onboard-tester-malformed',
          display: '/role onboard TESTER',
        }),
      ),
    ).rejects.toThrow(/applied onboarding receipt/i);
  });

  it('requires explicit from refs to claim a leader-hosted departure handoff', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const post = createPostMessage(runtime);

    await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'remove-reviewer',
        display: '/role remove REVIEWER',
      }),
    );
    await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'onboard-tester-hosted',
        display: '/role onboard TESTER from role-departure:remove-reviewer',
      }),
    );

    const state = await runtime.store.load(scope);
    expect(
      state?.messages.find((message) => message.msgId === 'onboard-tester-hosted')?.payload
        .onboarding,
    ).toEqual({
      actionId: 'onboard-tester-hosted',
      role: 'TESTER',
      handoffRefs: [{ taskId: 'task-a', msgId: 'role-departure:remove-reviewer' }],
    });
  });

  it('rejects role onboarding outside main without applying nextRole', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const opened = await runtime.channels.load(scope.projectId);
    if (opened === undefined) throw new Error('expected initialized channels');
    await runtime.channels.commit(scope.projectId, opened.revision, [
      ...opened.channels,
      {
        channelId: 'sub-onboarding',
        kind: 'sub',
        taskId: scope.taskId,
        threadId: 'onboarding-thread',
        topic: 'Onboarding',
        createdBy: 'leader',
        participants: ['leader', 'TESTER'],
        closed: false,
      },
    ]);

    const response = await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'sub-onboarding',
        msgId: 'onboard-tester-in-sub',
        display: '/role onboard TESTER',
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('main') },
    });
    const replay = await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'sub-onboarding',
        msgId: 'onboard-tester-in-sub',
        display: '/role onboard TESTER',
      }),
    );
    await expect(replay.json()).resolves.toMatchObject({
      action: { status: 'rejected', reason: expect.stringContaining('main') },
      published: false,
    });
    const rejectedState = await runtime.store.load(scope);
    expect(rejectedState?.messages).toHaveLength(1);
    expect(rejectedState?.messages[0]).toMatchObject({
      msgId: 'onboard-tester-in-sub',
      payload: { action: { status: 'rejected', reason: expect.stringContaining('main') } },
    });
    expect(rejectedState?.messages[0]?.payload).not.toHaveProperty('onboarding');
    expect(rejectedState?.nextRole).toBeUndefined();
  });

  it('executes a Phase 7 role departure through the single Leader message endpoint', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    runtime.bindRoleDrainPort({
      awaitSafePoint: async (_scope, role) => ({
        role,
        activeWorkers: 0,
        safePointRefs: [],
      }),
    });
    await runtime.initializeState(
      scope,
      applyMutations(createInitialAppState(scope.taskId, 'Task task-a', scope.projectId), [
        mergeByIdMutation('subtasks', 'work-a', {
          title: 'Implement task A',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ]),
    );

    const response = await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'leader-remove-coder',
        display: '/role remove CODER to TESTER',
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'applied' },
    });
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      subtasks: [{ id: 'work-a', ownerRole: 'TESTER', status: 'in_progress' }],
      messages: [
        { msgId: 'role-departure:leader-remove-coder', type: 'handoff' },
        { msgId: 'leader-remove-coder', fromRole: 'leader' },
      ],
      handoffPackets: [{ fromRole: 'CODER', toRole: 'TESTER' }],
    });
    await expect(runtime.collaboration.load(scope.projectId)).resolves.toMatchObject({
      roster: expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({ role: 'CODER' }),
          status: 'departed',
          departure: expect.objectContaining({ stage: 'completed' }),
        }),
      ]),
    });
  });

  it('assigns an enabled successor and completes an awaiting role-departure saga', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initializeState(
      scope,
      applyMutations(createInitialAppState(scope.taskId, 'Task task-a', scope.projectId), [
        mergeByIdMutation('subtasks', 'orphaned-work', {
          title: 'Continue orphaned work',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ]),
    );
    const post = createPostMessage(runtime);
    const departure = await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'remove-coder-without-successor',
        display: '/role remove CODER',
      }),
    );
    await expect(departure.json()).resolves.toMatchObject({
      action: { status: 'blocked', reason: 'role_departure_requires_replacement:CODER' },
    });
    const gateId = (await runtime.store.load(scope))?.humanGate?.gateId;
    if (gateId === undefined) throw new Error('expected role-departure humanGate');
    runtime.bindHumanGateLifecyclePort({
      suspend: async () => {
        throw new Error('unexpected additional suspend');
      },
      resume: async () => undefined,
    });

    const resolution = await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'assign-tester-successor',
        display: `/resolve-gate ${gateId} assign_enabled_successor TESTER`,
      }),
    );
    await expect(resolution.json()).resolves.toMatchObject({
      action: { status: 'applied' },
    });
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      subtasks: [{ id: 'orphaned-work', ownerRole: 'TESTER', status: 'todo' }],
    });
    expect(await runtime.store.load(scope)).not.toHaveProperty('humanGate');
    await expect(runtime.collaboration.load(scope.projectId)).resolves.toMatchObject({
      roster: expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({ role: 'CODER' }),
          status: 'departed',
          departure: expect.objectContaining({
            stage: 'completed',
            successorRole: 'TESTER',
          }),
        }),
      ]),
      channels: [
        expect.objectContaining({
          channelId: 'main',
          participants: expect.not.arrayContaining(['CODER']),
        }),
      ],
    });

    const replay = await post(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'assign-tester-successor',
        display: `/resolve-gate ${gateId} assign_enabled_successor TESTER`,
      }),
    );
    await expect(replay.json()).resolves.toMatchObject({ published: false });
  });

  it('resumes a persisted departure before returning an existing Leader message', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initializeState(
      scope,
      applyMutations(createInitialAppState(scope.taskId, 'Task task-a', scope.projectId), [
        mergeByIdMutation('subtasks', 'work-a', {
          title: 'Implement task A',
          ownerRole: 'CODER',
          dependsOn: [],
          status: 'in_progress',
        }),
      ]),
    );
    const project = await runtime.collaboration.load(scope.projectId);
    if (project === undefined) throw new Error('expected initialized collaboration');
    const departure = beginRoleDeparture(project.roster, 'CODER', {
      actionId: 'persisted-remove-coder',
      taskId: scope.taskId,
      successorRole: 'TESTER',
      requestedTs: 500,
    });
    const enabledRoles = departure.roster
      .filter((entry) => entry.status === 'enabled')
      .map((entry) => entry.spec.role);
    await runtime.collaboration.commit(scope.projectId, project.revision, {
      roster: departure.roster,
      channels: project.channels.map((channel) =>
        channel.kind === 'main'
          ? { ...channel, participants: ['leader' as const, ...enabledRoles] }
          : channel,
      ),
    });
    await runtime.commitMessage(scope, {
      msgId: 'persisted-remove-coder',
      channelId: 'main',
      fromRole: 'leader',
      type: 'chat',
      payload: {
        kind: 'leader_intent',
        action: { status: 'rejected', reason: 'interrupted legacy attempt' },
      },
      display: '/role remove CODER to TESTER',
      ts: 500,
    });

    const response = await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'persisted-remove-coder',
        display: '/role remove CODER to TESTER',
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      published: false,
      action: { status: 'applied' },
    });
    await expect(runtime.collaboration.load(scope.projectId)).resolves.toMatchObject({
      roster: expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({ role: 'CODER' }),
          status: 'departed',
          departure: expect.objectContaining({ stage: 'completed' }),
        }),
      ]),
    });
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      subtasks: [{ id: 'work-a', ownerRole: 'TESTER', status: 'in_progress' }],
      handoffPackets: [{ fromRole: 'CODER', toRole: 'TESTER', ts: 500 }],
    });
  });

  it('keeps a post-begin interruption retryable instead of persisting a rejected Leader message', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    let disableSuccessor = true;
    runtime.bindRoleDrainPort({
      awaitSafePoint: async (_scope, role) => {
        if (disableSuccessor) {
          disableSuccessor = false;
          await runtime.roster.disableRole(scope.projectId, 'TESTER');
        }
        return { role, activeWorkers: 0, safePointRefs: [] };
      },
    });
    const request = () =>
      createPostMessage(runtime)(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'interrupted-remove-coder',
          display: '/role remove CODER to TESTER',
        }),
      );

    await expect(request()).rejects.toThrow(/successor "TESTER" is no longer enabled/);
    await expect(runtime.store.load(scope)).resolves.toMatchObject({ messages: [] });
    await expect(runtime.collaboration.load(scope.projectId)).resolves.toMatchObject({
      roster: expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({ role: 'CODER' }),
          status: 'departing',
          departure: expect.objectContaining({ stage: 'draining' }),
        }),
      ]),
    });

    await runtime.roster.enableRole(scope.projectId, 'TESTER');
    const replay = await request();

    await expect(replay.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'applied' },
    });
  });

  it('persists a structured Agent channel action through the Web composition boundary', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const state = await runtime.initialize(scope, 'Task task-a');

    await runtime.handleWorkerOutput(state, 'CODER', {
      channelAction: {
        kind: 'open_sub_channel',
        actionId: 'assistant-action-1',
        requestedRoles: ['TESTER'],
        topic: 'Reproduce the cache race',
      },
    });

    await expect(runtime.channels.load(scope.projectId)).resolves.toMatchObject({
      revision: 1,
      channels: [
        { channelId: 'main' },
        {
          channelId: 'sub-6-task-a-assistant-action-1',
          createdBy: 'CODER',
          participants: ['leader', 'CODER', 'TESTER'],
        },
      ],
    });
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      messages: [
        {
          msgId: 'channel-open:sub-6-task-a-assistant-action-1',
          payload: { kind: 'sub_channel_opened' },
        },
      ],
    });
  });

  it('opens, lists, and closes a sub-channel through Leader messages', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const postMessage = createPostMessage(runtime);

    const opened = await postMessage(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'leader-open-1',
        display: '/channel open TESTER,CODER Investigate the cache race',
      }),
    );
    await expect(opened.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'applied' },
    });

    const listed = await createGetChannels(runtime)(
      new Request('http://localhost/api/channels?projectId=project-a&taskId=task-a'),
    );
    await expect(listed.json()).resolves.toEqual({
      channels: [
        {
          channelId: 'main',
          kind: 'main',
          participants: ['leader', 'COORDINATOR', 'PM', 'ARCHITECT', 'CODER', 'TESTER', 'REVIEWER'],
          closed: false,
        },
        {
          channelId: 'sub-6-task-a-leader-open-1',
          kind: 'sub',
          taskId: 'task-a',
          threadId: 'leader-open-1',
          topic: 'Investigate the cache race',
          participants: ['leader', 'CODER', 'TESTER'],
          closed: false,
        },
      ],
    });

    const closed = await postMessage(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'leader-close-1',
        display: '/channel close sub-6-task-a-leader-open-1',
      }),
    );
    await expect(closed.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'applied' },
    });
    await expect(runtime.channels.load(scope.projectId)).resolves.toMatchObject({
      revision: 3,
      channels: [
        { channelId: 'main' },
        {
          channelId: 'sub-6-task-a-leader-open-1',
          closed: true,
          bubbledSummaryRef: {
            taskId: 'task-a',
            msgId: 'channel-bubble:sub-6-task-a-leader-open-1',
          },
        },
      ],
    });
  });

  it('persists a rejected Leader message when a channel lifecycle request is invalid', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');

    const response = await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'leader-invalid-open',
        display: '/channel open UNKNOWN Investigate the cache race',
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'rejected', reason: expect.stringContaining('UNKNOWN') },
    });
    await expect(runtime.channels.load(scope.projectId)).resolves.toMatchObject({ revision: 0 });
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      messages: [
        {
          msgId: 'leader-invalid-open',
          payload: { action: { status: 'rejected' } },
        },
      ],
    });
  });

  it('checks a replayed Leader msgId before applying any channel lifecycle side effect', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const postMessage = createPostMessage(runtime);

    await postMessage(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'stable-message',
        display: 'Original text',
      }),
    );
    const replay = await postMessage(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'stable-message',
        display: '/channel open TESTER This must not execute',
      }),
    );

    await expect(replay.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'none' },
      published: false,
    });
    await expect(runtime.channels.load(scope.projectId)).resolves.toMatchObject({
      revision: 0,
      channels: [{ channelId: 'main' }],
    });
  });

  it('omits the bubbled summary reference from the channel list DTO', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const snapshot = await runtime.channels.load(scope.projectId);
    if (snapshot === undefined) throw new Error('expected initialized project channels');
    await runtime.channels.commit(scope.projectId, snapshot.revision, [
      ...snapshot.channels,
      {
        channelId: 'sub-private',
        kind: 'sub',
        taskId: scope.taskId,
        threadId: 'private-thread',
        topic: 'Private topic',
        createdBy: 'leader',
        participants: ['leader', 'CODER'],
        bubbledSummaryRef: { taskId: scope.taskId, msgId: 'channel-bubble:sub-private' },
        closed: true,
      },
    ]);

    const response = await createGetChannels(runtime)(
      new Request('http://localhost/api/channels?projectId=project-a&taskId=task-a'),
    );
    const body = await response.json();

    expect(JSON.stringify(body)).not.toContain('channel-bubble:sub-private');
    expect(body).toMatchObject({ channels: [{ channelId: 'main' }, { channelId: 'sub-private' }] });
  });

  it('reuses one process runtime across separately bundled route modules', async () => {
    const root = await temporaryRoot();
    const registry: { messageRuntime: ReturnType<typeof createMessageRuntime> | undefined } = {
      messageRuntime: undefined,
    };
    let createCount = 0;
    const create = () => {
      createCount += 1;
      return createMessageRuntime(root, new ChannelStream());
    };

    const first = getOrCreateMessageRuntime(registry, create);
    const second = getOrCreateMessageRuntime(registry, create);

    expect(second).toBe(first);
    expect(createCount).toBe(1);
  });

  it('carries a persisted Leader assignment into one real Coordinator dispatch', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    await runtime.initialize({ projectId: 'project-a', taskId: 'task-a' }, 'Task task-a');
    const postMessage = createPostMessage(runtime);

    const posted = await postMessage(
      postRequest({
        projectId: 'project-a',
        taskId: 'task-a',
        channelId: 'main',
        msgId: 'leader-assignment',
        display: '@REVIEWER inspect the cache contract',
      }),
    );
    await expect(posted.json()).resolves.toMatchObject({
      accepted: true,
      action: { status: 'applied' },
    });

    const state = await runtime.store.load({ projectId: 'project-a', taskId: 'task-a' });
    expect(state).toBeDefined();
    if (state === undefined) throw new Error('expected persisted task state');
    const decision = decide(state, {
      roster: DEFAULT_ROSTER,
      newId: (() => {
        let id = 0;
        return () => `coordinator-${++id}`;
      })(),
      now: () => 1000,
    });

    expect(decision.route).toEqual({
      kind: 'worker',
      batch: [{ role: 'REVIEWER' }],
      parallel: false,
    });
    const dispatched = applyMutations(state, decision.mutations);
    expect(latestCoordinationLedger(dispatched)?.progress.instructionOrQuestion.answer).toBe(
      'inspect the cache contract',
    );
    expect(
      dispatched.messages.some(
        (message) =>
          message.fromRole === 'COORDINATOR' && message.payload.sourceMsgId === 'leader-assignment',
      ),
    ).toBe(true);
  });

  it('persists the project main registry and addresses a registered sub channel', async () => {
    const root = await temporaryRoot();
    const runtime = createMessageRuntime(root, new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const initial = await runtime.channels.load(scope.projectId);
    if (initial === undefined) throw new Error('expected initialized project channels');
    await runtime.channels.commit(scope.projectId, initial.revision, [
      ...initial.channels,
      {
        channelId: 'sub-task-a',
        kind: 'sub',
        taskId: scope.taskId,
        threadId: 'legacy-test-sub-task-a',
        topic: 'Private inspection',
        createdBy: 'leader',
        participants: ['leader', 'CODER'],
        closed: false,
      },
    ]);

    const response = await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'sub-task-a',
        msgId: 'leader-sub-message',
        display: 'Please inspect this privately.',
      }),
    );

    expect(response.status).toBe(202);
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      messages: [{ msgId: 'leader-sub-message', channelId: 'sub-task-a', fromRole: 'leader' }],
    });
    await expect(createMessageRuntime(root).channels.load(scope.projectId)).resolves.toMatchObject({
      revision: 1,
      channels: [{ channelId: 'main' }, { channelId: 'sub-task-a' }],
    });
  });

  it('rejects invalid browser Channel scope without persisting or streaming a message', async () => {
    const runtime = createMessageRuntime(await temporaryRoot(), new ChannelStream());
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    await runtime.initialize(scope, 'Task task-a');
    const initial = await runtime.channels.load(scope.projectId);
    if (initial === undefined) throw new Error('expected initialized project channels');
    await runtime.channels.commit(scope.projectId, initial.revision, [
      ...initial.channels,
      {
        channelId: 'other-task',
        kind: 'sub',
        taskId: 'task-b',
        threadId: 'other-task-thread',
        topic: 'Other task',
        createdBy: 'leader',
        participants: ['leader', 'CODER'],
        closed: false,
      },
      {
        channelId: 'closed-task-a',
        kind: 'sub',
        taskId: 'task-a',
        threadId: 'closed-task-thread',
        topic: 'Closed task',
        createdBy: 'leader',
        participants: ['leader', 'CODER'],
        closed: true,
      },
    ]);
    const streamed: unknown[] = [];
    const unsubscribe = runtime.stream.subscribe(
      { ...scope, channelId: 'closed-task-a' },
      (event) => streamed.push(event),
    );

    for (const channelId of ['missing', 'other-task', 'closed-task-a']) {
      const response = await createPostMessage(runtime)(
        postRequest({
          ...scope,
          channelId,
          msgId: `invalid-${channelId}`,
          display: 'This must be rejected.',
        }),
      );
      expect(response.status).toBe(400);
    }

    const invalidStream = await createGetStream(runtime)(
      new Request(
        'http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=other-task',
      ),
    );
    expect(invalidStream.status).toBe(400);
    expect(runtime.stream.subscriberCount({ ...scope, channelId: 'other-task' })).toBe(0);
    await expect(runtime.store.load(scope)).resolves.toMatchObject({ messages: [] });
    expect(streamed).toEqual([]);
    unsubscribe();
  });

  it('server-stamps leader, persists payload, and streams only the display envelope', async () => {
    const stream = new ChannelStream();
    const runtime = createMessageRuntime(await temporaryRoot(), stream);
    await runtime.initialize({ projectId: 'project-a', taskId: 'task-a' }, 'Task task-a');
    const openStream = createGetStream(runtime);
    const postMessage = createPostMessage(runtime);
    const response = await openStream(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.read();

    const posted = await postMessage(
      postRequest({
        projectId: 'project-a',
        taskId: 'task-a',
        channelId: 'main',
        msgId: 'stable-message-1',
        fromRole: 'ATTACKER',
        display: 'Ship the persisted flow.',
        payload: { intent: 'implement', secret: 'agent-only' },
      }),
    );

    expect(posted.status).toBe(202);
    await expect(posted.json()).resolves.toEqual({
      accepted: true,
      action: { status: 'none' },
      published: true,
    });
    const live = decoder.decode((await reader?.read())?.value);
    expect(live).toContain('event: message');
    expect(live).toContain('"fromRole":"leader"');
    expect(live).toContain('"display":"Ship the persisted flow."');
    expect(live).not.toContain('payload');
    expect(live).not.toContain('agent-only');

    const persisted = await runtime.store.load({ projectId: 'project-a', taskId: 'task-a' });
    expect(persisted?.messages[0]).toMatchObject({
      msgId: 'stable-message-1',
      fromRole: 'leader',
      payload: {
        action: { status: 'none' },
        intent: { kind: 'chat', text: 'Ship the persisted flow.' },
        kind: 'leader_intent',
      },
    });
    expect(JSON.stringify(persisted?.messages[0]?.payload)).not.toContain('agent-only');
    await reader?.cancel();
  });

  it('recovers a payload-free snapshot through a fresh runtime and suppresses msgId replays', async () => {
    const root = await temporaryRoot();
    const firstStream = new ChannelStream();
    const firstRuntime = createMessageRuntime(root, firstStream);
    await firstRuntime.initialize({ projectId: 'project-a', taskId: 'task-a' }, 'Task task-a');
    const postMessage = createPostMessage(firstRuntime);
    const body = {
      projectId: 'project-a',
      taskId: 'task-a',
      channelId: 'main',
      msgId: 'stable-message-1',
      display: 'Recover this after restart.',
      payload: { secret: 'never-stream-this' },
    };

    await postMessage(postRequest(body));
    const replay = await postMessage(postRequest(body));
    await expect(replay.json()).resolves.toEqual({
      accepted: true,
      action: { status: 'none' },
      published: false,
    });

    const restarted = createMessageRuntime(root, new ChannelStream());
    const response = await createGetStream(restarted)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    const snapshot = decoder.decode((await reader?.read())?.value);

    expect(snapshot).toContain('event: snapshot');
    expect(snapshot).toContain('"msgId":"stable-message-1"');
    expect(snapshot).toContain('"display":"Recover this after restart."');
    expect(snapshot).not.toContain('payload');
    expect(snapshot).not.toContain('never-stream-this');
    await reader?.cancel();
  });

  it('backfills canonical main for a legacy task snapshot that predates channels.json', async () => {
    const root = await temporaryRoot();
    const scope = { projectId: 'legacy-project', taskId: 'legacy-task' };
    await new JsonTaskStateStore(root).initialize(
      scope,
      createInitialAppState(scope.taskId, 'Legacy task', scope.projectId),
    );
    const runtime = createMessageRuntime(root, new ChannelStream());

    const posted = await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'legacy-message',
        display: 'Continue after upgrade.',
      }),
    );

    expect(posted.status).toBe(202);
    await expect(runtime.channels.load(scope.projectId)).resolves.toMatchObject({
      revision: 0,
      channels: [{ channelId: 'main', kind: 'main', closed: false }],
    });
    await expect(runtime.store.load(scope)).resolves.toMatchObject({
      messages: [{ msgId: 'legacy-message' }],
    });
  });

  it('fails fast instead of overwriting a corrupt legacy channel snapshot', async () => {
    const root = await temporaryRoot();
    const scope = { projectId: 'corrupt-project', taskId: 'legacy-task' };
    await new JsonTaskStateStore(root).initialize(
      scope,
      createInitialAppState(scope.taskId, 'Legacy task', scope.projectId),
    );
    const channelPath = join(root, 'projects', scope.projectId, 'channels.json');
    await mkdir(join(root, 'projects', scope.projectId), { recursive: true });
    await writeFile(channelPath, '{broken', 'utf8');
    const runtime = createMessageRuntime(root, new ChannelStream());

    await expect(
      createPostMessage(runtime)(
        postRequest({
          ...scope,
          channelId: 'main',
          msgId: 'must-not-commit',
          display: 'Do not mask corruption.',
        }),
      ),
    ).rejects.toThrow('invalid project channel JSON');
    await expect(readFile(channelPath, 'utf8')).resolves.toBe('{broken');
    await expect(runtime.store.load(scope)).resolves.toMatchObject({ messages: [] });
  });

  it('bridges commits made while the persisted snapshot is opening into the live SSE tail', async () => {
    const stream = new ChannelStream();
    const runtime = createMessageRuntime(await temporaryRoot(), stream);
    const scope = { projectId: 'project-a', taskId: 'task-a' };
    const address = { ...scope, channelId: 'main' };
    await runtime.initialize(scope, 'Task task-a');

    const realLoad = runtime.store.load.bind(runtime.store);
    let releaseSnapshot: (() => void) | undefined;
    const snapshotPaused = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let markSnapshotRead: (() => void) | undefined;
    const snapshotRead = new Promise<void>((resolve) => {
      markSnapshotRead = resolve;
    });
    let pauseNextLoad = true;
    runtime.store.load = async (...args) => {
      const state = await realLoad(...args);
      if (pauseNextLoad) {
        pauseNextLoad = false;
        markSnapshotRead?.();
        await snapshotPaused;
      }
      return state;
    };

    const opening = createGetStream(runtime)(
      new Request('http://localhost/api/stream?projectId=project-a&taskId=task-a&channelId=main'),
    );
    await snapshotRead;
    const subscriberCountDuringSnapshot = stream.subscriberCount(address);

    await createPostMessage(runtime)(
      postRequest({
        ...scope,
        channelId: 'main',
        msgId: 'during-open',
        display: 'Do not lose this message.',
        payload: { intent: 'chat' },
      }),
    );
    releaseSnapshot?.();

    const response = await opening;
    const reader = response.body?.getReader();
    const connected = decoder.decode((await reader?.read())?.value);
    const snapshot = decoder.decode((await reader?.read())?.value);
    const live = await Promise.race([
      reader?.read().then((result) => decoder.decode(result.value)),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);

    expect(subscriberCountDuringSnapshot).toBe(1);
    expect(connected).toContain('event: connected');
    expect(snapshot).toContain('event: snapshot');
    expect(snapshot).not.toContain('during-open');
    expect(live).toContain('event: message');
    expect(live).toContain('during-open');
    await reader?.cancel();
  });
});
