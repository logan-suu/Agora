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
  isLocalValidationReceipt,
  type LocalValidationReceipt,
  localValidationReceipt,
} from '../src/local-validation';
import { appendMutation, applyMutations } from '../src/reducer';
import { type AppState, createInitialAppState } from '../src/state';

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
  it('preserves verified historical Leader feedback after new testing changes the current result', () => {
    const candidate = state();
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
  });
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
