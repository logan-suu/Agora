import { describe, expect, it } from 'vitest';
import {
  buildCompletionResolution,
  canonicalCompletionDecisionIds,
  currentCompletionEvidence,
  deriveCompletionFeedback,
  deriveCompletionResolution,
} from '../src/completion-resolution';
import {
  currentLocalCompletionEvidence,
  deliveryReaderAssignment,
  isLocalValidationReceipt,
  type LocalValidationReceipt,
  localReviewBindingForValidation,
  localValidationReceipt,
} from '../src/local-validation';
import { appendMutation, applyMutations } from '../src/reducer';
import { type AppState, createInitialAppState } from '../src/state';
import { parseWorkspaceControl } from '../src/workspace-control';
import { workspaceUndoResults } from '../src/workspace-undo-result';
import { workspaceVersionChanges } from '../src/workspace-version-change';

const version = { kind: 'files' as const, manifestId: 'manifest:1', manifestHash: 'a'.repeat(64) };
const receipt: LocalValidationReceipt = {
  kind: 'workspace_validation',
  version: 1,
  projectId: 'project',
  taskId: 'task',
  dispatchId: 'test-dispatch',
  workerId: 'tester',
  sourceWorkspaceId: 'coding',
  validationWorkspaceId: 'validation',
  workspaceVersion: version,
  controlFingerprint: 'b'.repeat(64),
  toolchainHash: 'c'.repeat(64),
  policyHash: 'd'.repeat(64),
  dependenciesHash: 'e'.repeat(64),
  commandReceiptId: 'command:1',
  commandInputHash: 'f'.repeat(64),
  testPaths: ['cache.test.cjs'],
  results: { passed: true, total: 5, failed: 0, failures: [], workspaceVersion: version },
  execution: { exitCode: 0, timedOut: false, quiescent: true },
};
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('missing fixture value');
  return value;
}
function state(): AppState {
  const value = createInitialAppState('task', 'Build a cache', 'project');
  value.phase = 'review';
  value.subtasks = [
    { id: 'subtask', title: 'Cache', ownerRole: 'CODER', dependsOn: [], status: 'done' },
  ];
  value.reviewComments = [{ id: 'verdict', kind: 'verdict', verdict: 'approved' }];
  value.workers = [
    {
      workerId: 'tester',
      role: 'TESTER',
      subtaskId: 'subtask',
      status: 'done',
      executor: 'harness',
      startedTs: 0,
    },
  ];
  value.localExecution = {
    schemaVersion: 'local-execution-v1',
    rootIds: ['root'],
    receipts: [
      {
        receiptId: 'binding:tester',
        actionId: 'bind-tester',
        inputHash: 'a'.repeat(64),
        registryRevision: 1,
      },
    ],
    bindings: [
      {
        workerId: 'tester',
        subtaskId: 'subtask',
        workspaceId: 'validation',
        receiptId: 'binding:tester',
      },
    ],
    workspaces: ['coding', 'validation'].map((workspaceId) => ({
      schemaVersion: 'workspace-v1',
      projectId: 'project',
      taskId: 'task',
      workspaceId,
      rootId: 'root',
      grantId: 'grant',
      purpose: workspaceId === 'coding' ? 'coding' : 'validation',
      mode: 'direct',
      baselineManifestId: version.manifestId,
    })),
  };
  value.testResults = structuredClone(receipt.results);
  value.messages = [
    {
      msgId: 'test-dispatch',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      payload: { nextRole: 'TESTER' },
      display: 'Test',
      ts: 1,
    },
    {
      msgId: 'workspace-validation:test-dispatch',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      payload: { ...structuredClone(receipt) },
      display: '5/5 passed',
      ts: 2,
    },
    {
      msgId: 'review-dispatch',
      channelId: 'main',
      fromRole: 'COORDINATOR',
      type: 'announce',
      payload: {
        nextRole: 'REVIEWER',
        reviewCommentCursor: 0,
        workspaceReviewBinding: {
          kind: 'workspace_review',
          version: 1,
          validationReceiptId: 'workspace-validation:test-dispatch',
          sourceWorkspaceId: 'coding',
          workspaceVersion: version,
          controlFingerprint: receipt.controlFingerprint,
        },
      },
      display: 'Review the validated files',
      ts: 3,
    },
  ];
  return value;
}
describe('local immutable validation evidence', () => {
  it.each([false, true])(
    'preserves historical local feedback with retained parallel metadata=%s',
    (retainedParallel) => {
      const candidate = state();
      if (retainedParallel) {
        candidate.parallelExecution = {
          version: 1,
          planId: 'historical-plan',
          initialBase: { branch: 'base', commit: 'f'.repeat(40) },
        };
        const local = required(candidate.localExecution);
        local.workspaces.push({
          schemaVersion: 'workspace-v1',
          projectId: 'project',
          taskId: 'task',
          workspaceId: 'initial',
          rootId: 'root',
          grantId: 'grant',
          mode: 'linked-worktree',
          purpose: 'integration',
          commonDirId: 'common',
          branch: 'base',
          baseCommit: 'f'.repeat(40),
        });
        local.git = {
          version: 1,
          initialWorkspaceId: 'initial',
          worktrees: [
            { workspaceId: 'initial', path: '/owned/initial', receiptId: 'binding:tester' },
          ],
        };
      }
      const built = buildCompletionResolution(candidate, {
        actionId: 'return',
        reviewId: 'verdict',
        option: 'request_changes',
        rationale: 'Cover zero capacity',
        ts: 4,
      });
      candidate.decisionLedger.push(built.decision);
      candidate.messages.push(
        {
          msgId: 'return',
          fromRole: 'leader',
          channelId: 'main',
          type: 'chat',
          ts: 4,
          display: 'Request changes',
          payload: {
            kind: 'leader_intent',
            action: { status: 'applied' },
            intent: {
              kind: 'resolve_human_gate',
              gateId: 'human-gate:verdict',
              option: 'request_changes',
              argument: 'Cover zero capacity',
            },
            completionResolution: built.action,
            resolution: {
              gateId: 'human-gate:verdict',
              option: 'request_changes',
              argument: 'Cover zero capacity',
              safePointRefs: ['safe'],
              resumeSessionId: 'human-gate-resume:return',
              completionEvidence: currentCompletionEvidence(candidate),
            },
          },
        },
        {
          msgId: 'human-gate-resumed:return',
          fromRole: 'COORDINATOR',
          channelId: 'main',
          type: 'announce',
          ts: 5,
          display: 'Resumed',
          payload: {
            kind: 'human_gate_resumed',
            actionId: 'return',
            gateId: 'human-gate:verdict',
            resumeSessionId: 'human-gate-resume:return',
          },
        },
      );
      expect(deriveCompletionFeedback(candidate)?.rationale).toBe('Cover zero capacity');
      candidate.testResults = {
        passed: false,
        total: 1,
        failed: 1,
        failures: [{ test: 'zero', message: 'failed', file: 'cache.test.cjs', line: 1 }],
        workspaceVersion: { ...version, manifestHash: '0'.repeat(64) },
      };
      candidate.messages.push({ ...required(candidate.messages[0]), msgId: 'new-test', ts: 6 });
      expect(() => deriveCompletionResolution(candidate, 'verdict')).toThrow();
      expect(deriveCompletionFeedback(candidate)?.rationale).toBe('Cover zero capacity');
      expect([...canonicalCompletionDecisionIds(candidate)]).toEqual([built.decision.id]);
    },
  );
  it('uses the same file evidence for D16 and refuses a candidate without that evidence', () => {
    const candidate = state();
    expect(currentCompletionEvidence(candidate)).toEqual(
      required(candidate.messages[2]).payload.workspaceReviewBinding,
    );
    expect(
      buildCompletionResolution(candidate, {
        actionId: 'approve',
        reviewId: 'verdict',
        option: 'approve_completion',
        ts: 4,
      }).action.reviewId,
    ).toBe('verdict');
    delete required(candidate.messages[2]).payload.workspaceReviewBinding;
    expect(() =>
      buildCompletionResolution(candidate, {
        actionId: 'approve',
        reviewId: 'verdict',
        option: 'approve_completion',
        ts: 4,
      }),
    ).toThrow();
  });
  it('keeps a canonical validation message immutable under duplicate message IDs', () => {
    const candidate = state(),
      message = required(candidate.messages[1]);
    expect(() =>
      applyMutations(candidate, [
        appendMutation('messages', {
          ...message,
          payload: { ...message.payload, commandReceiptId: 'different-command' },
        }),
      ]),
    ).toThrow('immutable');
  });
  it('retains a complete failed run as evidence without making it a completion candidate', () => {
    const failed = structuredClone(receipt);
    failed.execution.exitCode = 1;
    failed.results = {
      passed: false,
      total: 5,
      failed: 1,
      failures: [
        { test: 'evicts oldest', message: 'unexpected value', file: 'cache.test.cjs', line: 12 },
      ],
      workspaceVersion: version,
    };
    expect(isLocalValidationReceipt(failed)).toBe(true);
    const changed = state();
    required(changed.messages[1]).payload = { ...failed };
    changed.testResults = failed.results;
    expect(localValidationReceipt(changed, 'workspace-validation:test-dispatch')).toEqual(failed);
    expect(() => currentLocalCompletionEvidence(changed)).toThrow(
      'local_completion_evidence_changed',
    );
  });
  it('requires a complete version, exact shape and consistent actual execution result', () => {
    expect(isLocalValidationReceipt(receipt)).toBe(true);
    for (const patch of [
      { extra: true },
      { projectId: '../other' },
      { workspaceVersion: { ...version, manifestHash: 'bad' } },
      { testPaths: [] },
      { testPaths: ['../outside.test.cjs'] },
      { testPaths: ['cache.test.cjs', 'cache.test.cjs'] },
      { testPaths: ['.env.test.cjs'] },
      { testPaths: ['cache.js'] },
      { execution: { exitCode: 1, timedOut: false, quiescent: true } },
      { execution: { exitCode: 0, timedOut: true, quiescent: true } },
      { execution: { exitCode: 0, timedOut: false, quiescent: false } },
      { results: { ...receipt.results, workspaceVersion: { ...version, manifestId: 'other' } } },
    ])
      expect(isLocalValidationReceipt({ ...receipt, ...patch })).toBe(false);
  });
  it('cross-checks trusted message, dispatch, independent tester binding and task scope', () => {
    expect(localValidationReceipt(state(), 'workspace-validation:test-dispatch')).toEqual(receipt);
    for (const mutate of [
      (s: AppState) => {
        required(s.messages[1]).fromRole = 'TESTER';
      },
      (s: AppState) => {
        required(s.messages[1]).payload.taskId = 'other';
      },
      (s: AppState) => {
        required(s.messages[0]).payload.nextRole = 'CODER';
      },
      (s: AppState) => {
        s.messages.reverse();
      },
      (s: AppState) => {
        required(s.workers[0]).role = 'CODER';
      },
      (s: AppState) => {
        required(required(s.localExecution).bindings[0]).workspaceId = 'coding';
      },
      (s: AppState) => {
        required(required(s.localExecution).workspaces[1]).purpose = 'coding';
      },
      (s: AppState) => {
        required(s.localExecution).receipts = [];
      },
      (s: AppState) => {
        s.messages.push(structuredClone(required(s.messages[1])));
      },
    ]) {
      const changed = state();
      mutate(changed);
      expect(() => localValidationReceipt(changed, 'workspace-validation:test-dispatch')).toThrow();
    }
  });
  it('binds review to the current passing result and rejects a newer test dispatch or drift', () => {
    expect(currentLocalCompletionEvidence(state())).toEqual(
      required(state().messages[2]).payload.workspaceReviewBinding,
    );
    for (const mutate of [
      (s: AppState) => {
        required(s.testResults).workspaceVersion = { ...version, manifestHash: '0'.repeat(64) };
      },
      (s: AppState) => {
        required(s.messages[2]).payload.workspaceReviewBinding = {};
      },
      (s: AppState) => {
        s.messages.push({ ...required(s.messages[0]), msgId: 'new-test' });
      },
      (s: AppState) => {
        delete s.testResults;
      },
      (s: AppState) => {
        required(s.messages[1]).payload.controlFingerprint = '0'.repeat(64);
      },
    ]) {
      const changed = state();
      mutate(changed);
      expect(() => currentLocalCompletionEvidence(changed)).toThrow();
    }
  });
});

it('binds a delivery receipt to C without inventing a coding workspace', async () => {
  const { parseWorkspaceControl } = await import('../src/workspace-control');
  const candidate = state();
  const local = required(candidate.localExecution);
  const workerId = 'worker:test-dispatch:0';
  required(candidate.workers[0]).workerId = workerId;
  required(local.bindings[0]).workerId = workerId;
  const display = `/workspace revalidate ${JSON.stringify({ projectId: 'project', taskId: 'task', actionId: 'revalidate', expectedRevision: 2, deliveryComparisonId: 'comparison:fixed', inputHash: '1'.repeat(64) })}`;
  local.receipts.push({
    receiptId: 'binding:revalidate',
    actionId: 'revalidate',
    inputHash: '2'.repeat(64),
    registryRevision: 3,
  });
  local.delivery = {
    schemaVersion: 'local-delivery-v1',
    rootId: 'root',
    goal: 'artifact_only',
    currentRoundId: 'round',
    rounds: [
      {
        roundId: 'round',
        actionId: 'revalidate',
        deliveryComparisonId: 'comparison:fixed',
        inputHash: '1'.repeat(64),
        grantId: 'grant',
        grantRevision: 0,
        sourceReceiptId: 'older-validation',
        sourceVersion: version,
        candidateVersion: version,
        targetVersion: version,
        targetIndexHash: null,
        controlFingerprint: receipt.controlFingerprint,
      },
    ],
  };
  candidate.messages.unshift({
    msgId: 'revalidate',
    fromRole: 'leader',
    channelId: 'main',
    type: 'chat',
    ts: 0,
    display,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  });
  required(candidate.messages[1]).payload = {
    kind: 'delivery_validation_dispatch',
    nextRole: 'TESTER',
    roundId: 'round',
    workerIds: [workerId],
    workspaceVersion: version,
  };
  const roundReceipt = { ...receipt, workerId, sourceWorkspaceId: 'validation', roundId: 'round' };
  required(candidate.messages[2]).payload = roundReceipt;
  required(candidate.messages[3]).payload.workspaceReviewBinding = {
    kind: 'workspace_review',
    version: 1,
    validationReceiptId: 'workspace-validation:test-dispatch',
    sourceWorkspaceId: 'validation',
    workspaceVersion: version,
    controlFingerprint: receipt.controlFingerprint,
    roundId: 'round',
  };
  expect(isLocalValidationReceipt(roundReceipt)).toBe(true);
  expect(localValidationReceipt(candidate, 'workspace-validation:test-dispatch')).toEqual(
    roundReceipt,
  );
  expect(currentLocalCompletionEvidence(candidate)).toMatchObject({ roundId: 'round' });
  const reviewerId = `worker:${required(candidate.messages[3]).msgId}:0`;
  required(candidate.messages[3]).payload.workerIds = [reviewerId];
  expect(deliveryReaderAssignment(candidate, workerId)?.role).toBe('TESTER');
  expect(deliveryReaderAssignment(candidate, reviewerId)).toMatchObject({
    role: 'REVIEWER',
    round: { roundId: 'round' },
  });
  expect(deliveryReaderAssignment(candidate, 'old-reviewer')).toBeUndefined();
  const forgedReviewer = structuredClone(candidate);
  required(forgedReviewer.messages[3]).payload.workerIds = ['old-reviewer'];
  expect(() => deliveryReaderAssignment(forgedReviewer, reviewerId)).toThrow(
    'delivery_review_dispatch_invalid',
  );
  const staleReview = structuredClone(candidate);
  delete (
    required(staleReview.messages[3]).payload.workspaceReviewBinding as Record<string, unknown>
  ).roundId;
  expect(() => deliveryReaderAssignment(staleReview, reviewerId)).toThrow();
  const wrong = structuredClone(candidate);
  required(wrong.messages[2]).payload.roundId = 'other';
  expect(() => localValidationReceipt(wrong, 'workspace-validation:test-dispatch')).toThrow();
  const oldApproval = structuredClone(candidate);
  delete (
    required(oldApproval.messages[3]).payload.workspaceReviewBinding as Record<string, unknown>
  ).roundId;
  expect(() => currentLocalCompletionEvidence(oldApproval)).toThrow(
    'local_completion_evidence_changed',
  );
  expect(isLocalValidationReceipt({ ...roundReceipt, roundId: undefined })).toBe(false);
});

function returnSource(value: AppState) {
  const display =
    '/workspace return ' +
    JSON.stringify({
      projectId: value.projectId,
      taskId: value.taskId,
      actionId: 'return',
      expectedRevision: 1,
      takeoverReceiptId: 'takeover:take',
    });
  return {
    msgId: 'return',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat' as const,
    display,
    ts: 4,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
}
function versionChange(value: AppState) {
  return {
    msgId: `workspace-change:${'9'.repeat(64)}`,
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce' as const,
    display: 'Private paths and raw edits never enter agent context',
    ts: 5,
    payload: {
      kind: 'workspace_version_change',
      version: 1,
      projectId: value.projectId,
      taskId: value.taskId,
      changeId: `workspace-change:${'9'.repeat(64)}`,
      takeoverId: 'takeover:take',
      returnActionId: 'return',
      source: {
        projectId: value.projectId,
        taskId: value.taskId,
        msgId: 'return',
        workspaceId: 'coding',
        rootId: 'root',
        grantId: 'grant',
        grantRevision: 1,
      },
      workspaceIds: ['coding', 'validation'],
      affectedWorkerIds: ['tester'],
      heldVersion: version,
      returnedVersion: version,
      privateProofHash: '8'.repeat(64),
      invalidatedValidationIds: ['workspace-validation:test-dispatch'],
    },
  };
}
it('preserves immutable validation history while rejecting its current review and completion qualification after return', () => {
  const before = state(),
    fact = versionChange(before);
  const next = applyMutations(before, [
    appendMutation('messages', returnSource(before)),
    appendMutation('messages', fact),
  ]);
  expect(next.testResults).toEqual(before.testResults);
  expect(next.reviewComments).toEqual(before.reviewComments);
  expect(localValidationReceipt(next, 'workspace-validation:test-dispatch')).toEqual(receipt);
  expect(() => currentLocalCompletionEvidence(next)).toThrow('workspace_version_changed');
  expect(() => localReviewBindingForValidation(next)).toThrow('workspace_version_changed');
  const changes = workspaceVersionChanges(next);
  expect(changes[0]?.returnedVersion).toEqual(version);
  if (!changes[0]) throw Error('missing change');
  changes[0].workspaceIds.push('untrusted');
  expect(workspaceVersionChanges(next)[0]?.workspaceIds).toEqual(['coding', 'validation']);
});
it.each([
  'forged-role',
  'unknown-validation',
  'later-validation',
  'extra-field',
  'wrong-task',
  'duplicate',
  'no-native-task',
])('rejects %s version facts without deleting or rewriting old evidence', (reason) => {
  const value = state(),
    fact = versionChange(value);
  if (reason === 'forged-role') fact.fromRole = 'CODER';
  if (reason === 'unknown-validation') fact.payload.invalidatedValidationIds = ['missing'];
  if (reason === 'extra-field') Object.assign(fact.payload, { rawText: 'untrusted' });
  if (reason === 'wrong-task') fact.payload.taskId = 'wrong';
  const next = applyMutations(value, [
    appendMutation('messages', returnSource(value)),
    appendMutation('messages', fact),
  ]);
  if (reason === 'later-validation') next.messages = [fact, ...value.messages];
  if (reason === 'duplicate') next.messages.push(structuredClone(fact));
  if (reason === 'no-native-task') delete next.localExecution;
  expect(() => workspaceVersionChanges(next)).toThrow('workspace_version_change_invalid');
});

it('invalidates present completion after a canonical undo without rewriting validation history', () => {
  const before = state();
  const inputHash = '6'.repeat(64),
    fileApplyReceiptId = `apply:${'7'.repeat(64)}`;
  const intent = {
    projectId: before.projectId,
    taskId: before.taskId,
    actionId: 'undo',
    expectedRevision: 3,
    fileApplyReceiptId,
    inputHash,
  };
  const display = `/workspace undo ${JSON.stringify(intent)}`;
  const source = {
    msgId: 'undo',
    channelId: 'main',
    fromRole: 'leader',
    type: 'chat' as const,
    display,
    ts: 5,
    payload: {
      kind: 'leader_intent',
      intent: parseWorkspaceControl(display),
      action: { status: 'applied' },
    },
  };
  const result = {
    msgId: `workspace-undo:${'5'.repeat(64)}`,
    channelId: 'main',
    fromRole: 'COORDINATOR',
    type: 'announce' as const,
    display: 'Undo result',
    ts: 6,
    payload: {
      kind: 'workspace_undo_result',
      version: 1,
      projectId: before.projectId,
      taskId: before.taskId,
      resultId: `workspace-undo:${'5'.repeat(64)}`,
      source: {
        projectId: before.projectId,
        taskId: before.taskId,
        msgId: 'undo',
        workspaceId: 'coding',
        fileApplyReceiptId,
        inputHash,
      },
      workspaceIds: ['coding', 'validation'],
      originalReceiptHash: '4'.repeat(64),
      privateProofHash: '3'.repeat(64),
      stage: 'applied',
      currentVersion: version,
      invalidatedValidationIds: ['workspace-validation:test-dispatch'],
    },
  };
  const next = applyMutations(before, [
    appendMutation('messages', source),
    appendMutation('messages', result),
  ]);
  expect(workspaceUndoResults(next)).toHaveLength(1);
  expect(localValidationReceipt(next, 'workspace-validation:test-dispatch')).toEqual(receipt);
  expect(next.testResults).toEqual(before.testResults);
  expect(next.reviewComments).toEqual(before.reviewComments);
  expect(() => currentLocalCompletionEvidence(next)).toThrow('workspace_version_changed');
  expect(() => localReviewBindingForValidation(next)).toThrow('workspace_version_changed');
  const forged = structuredClone(next);
  required(forged.messages.at(-1)).fromRole = 'CODER';
  expect(() => workspaceUndoResults(forged)).toThrow('workspace_undo_result_invalid');
  const wrongProposal = structuredClone(next);
  required(wrongProposal.messages.at(-1)).payload.source = {
    ...result.payload.source,
    inputHash: '2'.repeat(64),
  };
  expect(() => workspaceUndoResults(wrongProposal)).toThrow('workspace_undo_result_invalid');
});
