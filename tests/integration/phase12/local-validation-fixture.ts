// Real native files, grant, lease and command evidence. No model is involved in
// this deterministic trusted-validation fixture; Harness is verified separately.
// Mock reason (R11): the lifecycle port and encoded cursor model a closed legacy
// turn only; replay still validates its format and scope before checking files.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendMutation, applyMutations, mergeByIdMutation, setMutation } from '@agora/core-domain';
import { decide, type GlobalScheduler } from '@agora/core-orchestration';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { expect } from 'vitest';
import { LocalValidationService } from '../../../apps/web/src/server/local-validation';
import type { MessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { LocalWorkspaceSessions } from '../../../packages/runtime/sandbox/src/local-workspace-sessions';

export async function exerciseLocalValidation(input: {
  options: Parameters<typeof LocalWorkspaceSessions.create>[0];
  runtime: MessageRuntime;
  scheduler: GlobalScheduler;
  root: string;
  sourceWorkspaceId: string;
  interruptedRelease?: boolean;
}) {
  const scope = { projectId: 'project', taskId: 'task' };
  const load = async () => {
    const state = await input.runtime.store.load(scope);
    if (!state) throw Error('missing state');
    return state;
  };
  const local = await LocalWorkspaceSessions.create(input.options);
  await input.runtime.commitMutations(scope, [
    mergeByIdMutation('workers', 'worker', { sessionId: 'session:worker' }),
  ]);
  const coderLease = await input.scheduler.acquire(scope.projectId, scope.taskId, 'worker');
  const coder = await local.open({
    ...scope,
    workerId: 'worker',
    role: 'CODER',
    subtaskId: 'work',
    sessionId: 'session:worker',
    assertLease: () => input.scheduler.assertActive(coderLease),
  });
  try {
    await coder.checkpoint('complete');
  } finally {
    await coder.close();
    await input.scheduler.release(coderLease);
  }
  await input.runtime.commitMutations(scope, [
    mergeByIdMutation('workers', 'worker', { status: 'done' }),
    mergeByIdMutation('workers', 'tester', {
      role: 'TESTER',
      executor: 'harness',
      status: 'running',
      startedTs: 1,
    }),
    setMutation('phase', 'testing'),
    appendMutation('messages', {
      msgId: 'test-dispatch',
      fromRole: 'COORDINATOR',
      channelId: 'main',
      type: 'announce',
      payload: { nextRole: 'TESTER' },
      display: 'Validate the fixed files',
      ts: Date.now(),
    }),
  ]);
  const lease = await input.scheduler.acquire(scope.projectId, scope.taskId, 'tester');
  const session = await local.open({
    ...scope,
    workerId: 'tester',
    role: 'TESTER',
    sessionId: 'session:tester',
    assertLease: () => input.scheduler.assertActive(lease),
  });
  const service = new LocalValidationService(local, load);
  try {
    const mutations = await service.complete(
      await load(),
      'tester',
      input.sourceWorkspaceId,
      session,
    );
    const committed = await input.runtime.commitMutations(scope, mutations);
    expect(committed.state.testResults).toMatchObject({
      passed: true,
      total: 2,
      failed: 0,
      failures: [],
    });
    expect(
      await service.complete(committed.state, 'tester', input.sourceWorkspaceId, session),
    ).toEqual([]);
    await session.checkpoint('complete');
    await session.close();
    await input.scheduler.release(lease);
    const receiptId = 'workspace-validation:test-dispatch';
    // Durable proof remains verifiable after the command worker releases its
    // lease, without granting a new execution capability.
    const receipt = await service.verify(await load(), receiptId);
    expect(receipt.execution).toEqual({ exitCode: 0, timedOut: false, quiescent: true });
    const binding = await service.reviewBinding(await load(), receiptId);
    await input.runtime.commitMutations(scope, [
      mergeByIdMutation('workers', 'tester', { status: 'done' }),
    ]);
    const decision = decide(await load(), { roster: DEFAULT_ROSTER });
    expect(decision.route).toMatchObject({ kind: 'worker', batch: [{ role: 'REVIEWER' }] });
    await input.runtime.commitMutations(scope, decision.mutations);
    const review = [...(await load()).messages]
      .reverse()
      .find((m) => m.payload.nextRole === 'REVIEWER');
    expect(review?.payload.workspaceReviewBinding).toEqual(binding);
    expect(await service.verifyCompletion(await load())).toEqual(binding);
    await input.runtime.commitMutations(scope, [
      appendMutation('reviewComments', {
        id: 'local-verdict',
        kind: 'verdict',
        verdict: 'approved',
      }),
      setMutation('humanGate', {
        gateId: 'human-gate:local-verdict',
        reason: 'completion_confirmation:local-verdict',
        options: ['approve_completion', 'request_changes'],
        phase: 'review',
        openedTs: Date.now(),
        safePointRefs: [
          `agora-safe-point:v1:${Buffer.from(
            JSON.stringify({
              version: 1,
              ...scope,
              role: 'REVIEWER',
              sourceSessionId: 'fixture:reviewer',
              boundary: 0,
              cwd: input.root,
              agentPreset: 'agora-role:REVIEWER',
            }),
          ).toString('base64url')}`,
        ],
      }),
    ]);
    const approval = {
      msgId: 'local-approval',
      channelId: 'main',
      display: '/resolve-gate human-gate:local-verdict approve_completion',
      ts: Date.now(),
    };
    await expect(input.runtime.commitLeaderMessage(scope, approval)).rejects.toThrow(
      'local_completion_verifier_required',
    );
    expect((await load()).humanGate?.gateId).toBe('human-gate:local-verdict');
    input.runtime.bindLocalCompletionVerifier(async (_scope, state) => {
      await service.verifyCompletion(state);
    });
    // This port records dispatch only; real Harness Fork remains a separate G5.
    let resumed = 0;
    input.runtime.bindHumanGateLifecyclePort({
      suspend: async () => {
        throw Error('unexpected suspend');
      },
      resume: async () => {
        resumed++;
      },
    });
    await input.runtime.commitLeaderMessage(scope, approval);
    expect(resumed).toBe(1);
    expect((await load()).humanGate).toBeUndefined();
    expect((await load()).phase).toBe('review');
    await input.runtime.commitLeaderMessage(scope, approval);
    expect((await load()).messages.filter((m) => m.msgId === approval.msgId)).toHaveLength(1);
    await expect(service.archive(await load(), local)).rejects.toThrow(
      'local_archive_requires_resumed_approval',
    );
    await input.runtime.commitMutations(scope, [
      ...(await load()).workers
        .filter((w) => w.role === 'REVIEWER')
        .map((w) => mergeByIdMutation('workers', w.workerId, { status: 'done' })),
      appendMutation('messages', {
        msgId: 'human-gate-resumed:local-approval',
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        ts: Date.now(),
        display: 'Fixed fixture resumed marker',
        payload: {
          kind: 'human_gate_resumed',
          actionId: 'local-approval',
          gateId: 'human-gate:local-verdict',
          resumeSessionId: 'human-gate-resume:local-approval',
        },
      }),
      setMutation('phase', 'done'),
    ]);
    if (input.interruptedRelease) {
      await expect(service.archive(await load(), local)).rejects.toThrow(
        'fixed terminal release interruption',
      );
      expect(
        (await input.options.control.snapshot()).operations.some(
          (o) => o.actionId.startsWith('release:') && o.stage === 'prepared',
        ),
      ).toBe(true);
    }
    const archived = await service.archive(await load(), local);
    expect(archived.workspaceVersion).toEqual(receipt.workspaceVersion);
    expect(readFileSync(join(archived.path, 'sentinel'), 'utf8')).toBe('fixed user content');
    expect(await service.archive(await load(), local)).toEqual(archived);
    expect(
      (await input.options.control.snapshot()).claims.filter(
        (claim) => claim.status !== 'released',
      ),
    ).toEqual([]);
    const changed = applyMutations(await load(), [
      setMutation('conventions', { testing: 'changed acceptance convention' }),
    ]);
    await expect(service.verifyCompletion(changed)).rejects.toThrow(
      'local_validation_control_changed',
    );
    const forged = structuredClone(await load());
    const validation = forged.messages.find((m) => m.msgId === receiptId);
    if (!validation) throw Error('missing validation');
    validation.payload.commandInputHash = '0'.repeat(64);
    await expect(service.verifyCompletion(forged)).rejects.toThrow(
      'local_validation_execution_changed',
    );
    const previous = readFileSync(join(input.root, 'sentinel'), 'utf8');
    writeFileSync(join(input.root, 'sentinel'), 'external newer contents');
    await expect(service.reviewBinding(await load(), receiptId)).rejects.toThrow(
      'file_version_conflict',
    );
    await expect(service.verifyCompletion(await load())).rejects.toThrow('file_version_conflict');
    await expect(input.runtime.commitLeaderMessage(scope, approval)).rejects.toThrow(
      'file_version_conflict',
    );
    expect(readFileSync(join(input.root, 'sentinel'), 'utf8')).toBe('external newer contents');
    return {
      archived,
      receipt,
      binding,
      previous,
      externalEditPreserved: true,
      leaseCount: input.scheduler.activeCount,
    };
  } finally {
    await session.close();
    await input.scheduler.release(lease);
  }
}
