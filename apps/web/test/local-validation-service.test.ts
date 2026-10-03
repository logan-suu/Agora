// Port doubles isolate control-flow failures; real native evidence is covered by
// the Phase 12 grant integration fixture, not substituted by these tests.
import { createInitialAppState } from '@agora/core-domain';
import { expect, it } from 'vitest';

it('invalidates local validation when requirements, architecture or conventions change', async () => {
  const { localControlFingerprint } = await import('../src/server/local-validation');
  const state = createInitialAppState('task', 'Build a cache', 'project');
  const original = localControlFingerprint(state);
  const next = structuredClone(state);
  next.goal = 'Build a different cache';
  expect(localControlFingerprint(next)).not.toBe(original);
  next.goal = state.goal;
  next.conventions = { style: 'different' };
  expect(localControlFingerprint(next)).not.toBe(original);
  delete next.conventions;
  next.iterationCount++;
  expect(localControlFingerprint(next)).toBe(original);
});

it('changes both native control fingerprints after a canonical return while retaining unchanged legacy hashes', async () => {
  const { localControlFingerprint } = await import('../src/server/local-validation');
  const { controlFingerprint } = await import('../src/server/wave-validation');
  const { parseWorkspaceControl } = await import('@agora/core-domain');
  const state = createInitialAppState('task', 'g', 'project');
  state.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    bindings: [],
    receipts: [],
    workspaces: [
      {
        schemaVersion: 'workspace-v1',
        projectId: 'project',
        taskId: 'task',
        rootId: 'root',
        grantId: 'grant',
        workspaceId: 'coding',
        purpose: 'coding',
        mode: 'direct',
        baselineManifestId: 'manifest:base',
      },
    ],
  };
  const priorLocal = localControlFingerprint(state),
    priorGit = controlFingerprint(state);
  const display =
    '/workspace return ' +
    JSON.stringify({
      projectId: 'project',
      taskId: 'task',
      actionId: 'return',
      expectedRevision: 1,
      takeoverReceiptId: 'takeover:take',
    });
  state.messages.push({
    msgId: 'return',
    fromRole: 'leader',
    channelId: 'main',
    type: 'chat',
    display,
    ts: 1,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  });
  expect(localControlFingerprint(state)).toBe(priorLocal);
  expect(controlFingerprint(state)).toBe(priorGit);
  state.messages.push({
    msgId: `workspace-change:${'9'.repeat(64)}`,
    fromRole: 'COORDINATOR',
    channelId: 'main',
    type: 'announce',
    display: 'raw private edit',
    ts: 2,
    payload: {
      kind: 'workspace_version_change',
      version: 1,
      projectId: 'project',
      taskId: 'task',
      changeId: `workspace-change:${'9'.repeat(64)}`,
      takeoverId: 'takeover:take',
      returnActionId: 'return',
      source: {
        projectId: 'project',
        taskId: 'task',
        msgId: 'return',
        workspaceId: 'coding',
        rootId: 'root',
        grantId: 'grant',
        grantRevision: 1,
      },
      workspaceIds: ['coding'],
      affectedWorkerIds: [],
      heldVersion: { kind: 'files', manifestId: 'manifest:base', manifestHash: 'a'.repeat(64) },
      returnedVersion: {
        kind: 'files',
        manifestId: 'manifest:changed',
        manifestHash: 'b'.repeat(64),
      },
      privateProofHash: '8'.repeat(64),
      invalidatedValidationIds: [],
    },
  });
  expect(localControlFingerprint(state)).not.toBe(priorLocal);
  expect(controlFingerprint(state)).not.toBe(priorGit);
});
