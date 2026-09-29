// Composition sentinel isolates admission only. Native launch/Harness/D16/archive
// behavior is exercised by the Phase 12 delivery acceptance fixture.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState, parseWorkspaceControl } from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect, it } from 'vitest';
import { ChannelStream } from '../src/server/channel-stream';
import { MessageRuntime } from '../src/server/message-runtime';
import { TaskOrchestrationRuntime } from '../src/server/task-orchestration-runtime';

function registered() {
  const state = createInitialAppState('task', 'fixed', 'project');
  const version = {
    kind: 'files' as const,
    manifestId: 'manifest:1',
    manifestHash: 'a'.repeat(64),
  };
  const display = `/workspace revalidate ${JSON.stringify({ projectId: 'project', taskId: 'task', actionId: 'action', expectedRevision: 1, deliveryComparisonId: 'comparison:c', inputHash: 'b'.repeat(64) })}`;
  state.phase = 'testing';
  state.nextRole = 'TESTER';
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    workspaces: [
      {
        schemaVersion: 'workspace-v1',
        projectId: 'project',
        taskId: 'task',
        workspaceId: 'source',
        rootId: 'root',
        grantId: 'grant',
        purpose: 'coding',
        mode: 'direct',
        baselineManifestId: version.manifestId,
      },
    ],
    bindings: [],
    receipts: [
      {
        actionId: 'action',
        receiptId: 'binding:action',
        inputHash: 'c'.repeat(64),
        registryRevision: 2,
      },
    ],
    delivery: {
      schemaVersion: 'local-delivery-v1',
      goal: 'artifact_only',
      rootId: 'root',
      currentRoundId: 'round',
      rounds: [
        {
          roundId: 'round',
          actionId: 'action',
          deliveryComparisonId: 'comparison:c',
          inputHash: 'b'.repeat(64),
          grantId: 'grant',
          grantRevision: 0,
          sourceReceiptId: 'source-receipt',
          sourceVersion: version,
          candidateVersion: version,
          targetVersion: version,
          targetIndexHash: null,
          controlFingerprint: 'd'.repeat(64),
        },
      ],
    },
  };
  state.messages = [
    {
      msgId: 'action',
      fromRole: 'leader',
      channelId: 'main',
      type: 'chat',
      ts: 1,
      display,
      payload: {
        kind: 'leader_intent',
        intent: parseWorkspaceControl(display),
        action: { status: 'applied' },
      },
    },
    {
      msgId: 'dispatch',
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      ts: 2,
      display: 'Validate C',
      payload: {
        kind: 'delivery_validation_dispatch',
        nextRole: 'TESTER',
        roundId: 'round',
        workerIds: ['worker:dispatch:0'],
        workspaceVersion: version,
      },
    },
  ];
  return state;
}
it('keeps ordinary start read-only and rejects a stale or already admitted launch before composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-delivery-launch-'));
  try {
    const runtime = new MessageRuntime(root, new ChannelStream(), DEFAULT_ROSTER);
    const state = registered();
    const scope = { projectId: state.projectId, taskId: state.taskId };
    await runtime.initializeState(scope, state);
    let prepared = 0;
    const tasks = new TaskOrchestrationRuntime(runtime, async () => {
      prepared++;
      throw Error('composition-sentinel');
    });
    expect(
      (await tasks.start({ ...scope, goal: state.goal, requestId: 'ordinary' })).startOutcome,
    ).toBe('interrupted');
    expect(prepared).toBe(0);
    const canonical = await runtime.store.load(scope);
    if (!canonical) throw Error('missing fixture');
    await expect(tasks.startDeliveryRound({ ...canonical, iterationCount: 99 })).rejects.toThrow(
      'delivery_launch_not_ready',
    );
    await expect(
      tasks.startDeliveryRound(createInitialAppState('task', 'fixed', 'project')),
    ).rejects.toThrow('delivery_launch_requires_registration');
    expect(prepared).toBe(0);
    await expect(tasks.startDeliveryRound(canonical)).rejects.toThrow('composition-sentinel');
    expect(prepared).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
