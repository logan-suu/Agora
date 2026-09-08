import {
  type AppState,
  appendMutation,
  applyMutations,
  createInitialAppState,
  type Integration,
  mergeByIdMutation,
  setMutation,
  validationSourceReceipt,
  validationSubtaskIds,
  type WorktreeRef,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { decide } from '../src/coordinator';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected test fixture value');
  return value;
}

let sequence = 0;
const options = () => ({
  newId: () => `control-${++sequence}`,
  now: () => 100,
  parallel: {
    initialBase: { branch: 'base', commit: 'a'.repeat(40) },
    controlFingerprint: 'f'.repeat(64),
  },
});
function planned() {
  return applyMutations(createInitialAppState('parallel', 'Implement A and B, then C'), [
    setMutation('complexity', { tier: 2, signals: {} }),
    setMutation('phase', 'planning'),
    setMutation('architecture', {
      executionPlan: {
        version: 1,
        subtasks: [
          { id: 'C', title: 'Compose', dependsOn: ['A', 'B'] },
          { id: 'A', title: 'First independent unit', dependsOn: [] },
          { id: 'B', title: 'Second independent unit', dependsOn: [] },
        ],
      },
    }),
  ]);
}

// These are domain facts for pure routing tests; real execution evidence is
// covered by tests/integration/phase9/phase9-parallel-flow.test.ts.
function testedWave(input: AppState, passed = true): AppState {
  const execution = input.parallelExecution;
  const wave = execution?.activeWave;
  if (wave === undefined) throw new Error('expected coding wave');
  const ref = (key: string, baseCommit: string, headCommit: string): WorktreeRef => ({
    path: `/data/${key}`,
    branch: key,
    baseCommit,
    headCommit,
  });
  const branches = wave.coderWorkerIds.map((workerId, index) => ({
    workerId,
    subtaskId: wave.subtaskIds[index] as string,
    topologicalRank: 0,
    worktree: ref(`coder-${++sequence}`, wave.base.commit, 'b'.repeat(40)),
  }));
  let state = applyMutations(
    input,
    branches.flatMap((branch) => [
      mergeByIdMutation('workers', branch.workerId, { status: 'done', worktree: branch.worktree }),
      mergeByIdMutation('subtasks', branch.subtaskId, { worktree: branch.worktree }),
    ]),
  );
  state = applyMutations(state, decide(state, options()).mutations);
  const integration: Integration = {
    integrationId: `integration-${++sequence}`,
    waveId: wave.waveId,
    base: wave.base,
    integrationWorktree: ref(`integration-${sequence}`, wave.base.commit, 'c'.repeat(40)),
    pendingBranches: branches,
    mergedBranches: branches.map((branch) => ({
      workerId: branch.workerId,
      subtaskId: branch.subtaskId,
      branch: branch.worktree.branch,
      headCommit: branch.worktree.headCommit as string,
      mergeCommit: 'c'.repeat(40),
    })),
    conflicts: [],
    resultCommit: 'c'.repeat(40),
    status: 'done',
  };
  state = applyMutations(state, [setMutation('integration', integration)]);
  state = applyMutations(state, decide(state, options()).mutations);
  const testing = state.parallelExecution?.activeWave;
  const validation = testing?.validation;
  if (validation === undefined || testing === undefined)
    throw new Error('expected validation dispatch');
  const worktree = ref(`validation-${++sequence}`, validation.inputCommit, 'd'.repeat(40));
  const results = {
    passed,
    total: 2,
    failed: passed ? 0 : 1,
    failures: passed
      ? []
      : [{ test: 'acceptance', message: 'incorrect behavior', file: 'test.mjs', line: 1 }],
  };
  const receiptId = `wave-validation:${validation.dispatchId}`;
  return applyMutations(state, [
    mergeByIdMutation('workers', validation.workerId, { status: 'done', worktree }),
    appendMutation('messages', {
      msgId: receiptId,
      fromRole: 'COORDINATOR',
      type: 'announce',
      channelId: 'main',
      display: 'Verified test execution',
      ts: 1,
      payload: {
        kind: 'wave_validation',
        version: 1,
        planId: execution?.planId,
        waveId: wave.waveId,
        attempt: wave.attempt,
        dispatchId: validation.dispatchId,
        workerId: validation.workerId,
        integrationId: validation.integrationId,
        inputCommit: validation.inputCommit,
        worktree,
        subtaskIds: state.messages.find((message) => message.msgId === validation.dispatchId)
          ?.payload.subtaskIds,
        controlFingerprint: 'f'.repeat(64),
        results,
        evidence: {
          path: `validation/${validation.dispatchId}.json`,
          sha256: 'e'.repeat(64),
          exitCode: passed ? 0 : 1,
          timedOut: false,
        },
      },
    }),
    setMutation('testResults', results),
    setMutation('parallelExecution', {
      ...state.parallelExecution,
      activeWave: { ...testing, validation: { ...validation, worktree, receiptId } },
    }),
  ]);
}

function awaitingReview() {
  const initial = planned();
  const first = applyMutations(initial, decide(initial, options()).mutations);
  const tested = testedWave(first);
  const second = applyMutations(tested, decide(tested, options()).mutations);
  const testedSecond = testedWave(second);
  return applyMutations(testedSecond, decide(testedSecond, options()).mutations);
}

function reviewed(state: AppState, subtaskIds?: unknown, issueScope?: string) {
  const reviewer = [...state.workers].reverse().find((worker) => worker.role === 'REVIEWER');
  if (reviewer === undefined) throw new Error('expected reviewer');
  return applyMutations(state, [
    mergeByIdMutation('workers', reviewer.workerId, { status: 'done' }),
    appendMutation('reviewComments', {
      id: `verdict-${++sequence}`,
      kind: 'verdict',
      verdict: 'changes_requested',
      summary: 'Rework',
      ...(issueScope === undefined ? {} : { issueScope }),
      ...(subtaskIds === undefined ? {} : { subtaskIds }),
    }),
  ]);
}

describe('Phase 9 wave coordinator', () => {
  it('validates retained root-cause contributions without redispatching their CODER', () => {
    const initial = planned();
    const started = applyMutations(initial, decide(initial, options()).mutations);
    const failed = testedWave(started, false);
    const retry = applyMutations(failed, decide(failed, options()).mutations);
    const failedAgain = testedWave(retry, false);
    const reviewing = applyMutations(failedAgain, decide(failedAgain, options()).mutations);
    const verdict = reviewed(reviewing, ['A']);
    const repairing = applyMutations(verdict, decide(verdict, options()).mutations);
    expect(repairing.parallelExecution?.activeWave?.subtaskIds).toEqual(['A']);
    const bWorkers = repairing.workers.filter((worker) => worker.subtaskId === 'B');
    const fixed = testedWave(repairing);
    const receipt = fixed.messages.find(
      (message) => message.msgId === fixed.parallelExecution?.activeWave?.validation?.receiptId,
    );
    expect(receipt?.payload.subtaskIds).toEqual(['A', 'B']);
    const next = applyMutations(fixed, decide(fixed, options()).mutations);
    expect(next.parallelExecution?.activeWave?.subtaskIds).toEqual(['C']);
    expect(next.subtasks.find((node) => node.id === 'B')?.status).toBe('done');
    expect(next.workers.filter((worker) => worker.subtaskId === 'B')).toEqual(bWorkers);
    const finalTested = testedWave(next);
    expect(
      finalTested.messages.find(
        (message) =>
          message.msgId === finalTested.parallelExecution?.activeWave?.validation?.receiptId,
      )?.payload.subtaskIds,
    ).toEqual(['C']);
  });

  it('preserves retained validation scope through repair failure and semantic revalidation', () => {
    const initial = planned();
    const first = applyMutations(initial, decide(initial, options()).mutations);
    const failed = testedWave(first, false);
    const retry = applyMutations(failed, decide(failed, options()).mutations);
    const twice = testedWave(retry, false);
    const reviewing = applyMutations(twice, decide(twice, options()).mutations);
    const verdict = reviewed(reviewing, ['A']);
    const repair = applyMutations(verdict, decide(verdict, options()).mutations);
    const broken = testedWave(repair, false);
    const repeat = applyMutations(broken, decide(broken, options()).mutations);
    expect(repeat.parallelExecution?.activeWave?.subtaskIds).toEqual(['A']);
    const passed = testedWave(repeat);
    const changed = applyMutations(
      passed,
      decide(passed, {
        ...options(),
        parallel: { ...options().parallel, controlFingerprint: '0'.repeat(64) },
      }).mutations,
    );
    expect(validationSubtaskIds(changed, required(changed.parallelExecution?.activeWave))).toEqual([
      'A',
      'B',
    ]);
    expect(changed.subtasks.find((node) => node.id === 'B')?.status).toBe('in_progress');
    expect(changed.parallelExecution?.activeWave?.validation?.inputCommit).toBe('d'.repeat(40));
    expect(
      validationSourceReceipt(
        changed,
        required(required(changed.parallelExecution?.activeWave).validation).dispatchId,
      )?.receipt.subtaskIds,
    ).toEqual(['A', 'B']);
    const badBase = structuredClone(changed);
    required(
      badBase.messages.find(
        (message) => message.msgId === required(badBase.parallelExecution?.activeWave).waveId,
      ),
    ).payload.base = { branch: 'wrong', commit: '0'.repeat(40) };
    expect(() =>
      validationSubtaskIds(badBase, required(badBase.parallelExecution?.activeWave)),
    ).toThrow(/repair base/);
    const corrupted = structuredClone(changed);
    const wave = required(
      corrupted.messages.find(
        (message) => message.msgId === required(corrupted.parallelExecution?.activeWave).waveId,
      ),
    );
    wave.payload.reworkSourceMsgId = 'missing';
    expect(() =>
      validationSubtaskIds(corrupted, required(corrupted.parallelExecution?.activeWave)),
    ).toThrow(/rework/);
  });

  it('keeps historical retained scope stable when an unchanged plan is adopted again', () => {
    const initial = applyMutations(planned(), [
      setMutation('architecture', {
        executionPlan: {
          version: 1,
          subtasks: [
            { id: 'A', title: 'A', dependsOn: [] },
            { id: 'B', title: 'B', dependsOn: [] },
          ],
        },
      }),
    ]);
    const first = applyMutations(initial, decide(initial, options()).mutations);
    const failed = testedWave(first, false);
    const retry = applyMutations(failed, decide(failed, options()).mutations);
    const twice = testedWave(retry, false);
    const reviewing = applyMutations(twice, decide(twice, options()).mutations);
    const verdict = reviewed(reviewing, ['A']);
    const repairing = applyMutations(verdict, decide(verdict, options()).mutations);
    const repaired = testedWave(repairing);
    const accepted = applyMutations(repaired, decide(repaired, options()).mutations);
    const reviewedState = reviewed(accepted);
    const replanning = applyMutations(reviewedState, [setMutation('phase', 'planning')]);
    const next = applyMutations(replanning, decide(replanning, options()).mutations);
    expect(next.parallelExecution?.planId).not.toBe(accepted.parallelExecution?.planId);
    expect(next.phase).toBe('testing');
    expect(validationSubtaskIds(next, required(next.parallelExecution?.activeWave))).toEqual([
      'A',
      'B',
    ]);
  });

  it('preserves the cumulative failed HEAD during a full architecture replan', () => {
    const initial = planned();
    const first = applyMutations(initial, decide(initial, options()).mutations);
    const failed = testedWave(first, false);
    const retry = applyMutations(failed, decide(failed, options()).mutations);
    const twice = testedWave(retry, false);
    const reviewing = applyMutations(twice, decide(twice, options()).mutations);
    const architectureVerdict = reviewed(reviewing, ['A'], 'architecture');
    const replanning = applyMutations(
      architectureVerdict,
      decide(architectureVerdict, options()).mutations,
    );
    const architect = required(replanning.workers.at(-1));
    const replanned = applyMutations(replanning, [
      mergeByIdMutation('workers', architect.workerId, { status: 'done' }),
    ]);
    const next = applyMutations(replanned, decide(replanned, options()).mutations);
    expect(next.parallelExecution?.activeWave?.subtaskIds).toEqual(['A', 'B']);
    expect(next.parallelExecution?.activeWave?.base.commit).toBe('d'.repeat(40));
    expect(next.subtasks.find((node) => node.id === 'C')?.status).toBe('todo');
  });

  it('rejects corrupted receipt/control references and immutable receipt replacement', () => {
    const state = awaitingReview();
    const receipt = state.messages.find(
      (message) => message.msgId === state.parallelExecution?.acceptedReceiptId,
    );
    if (receipt === undefined) throw new Error('missing bound receipt');
    expect(() =>
      applyMutations(state, [
        appendMutation('messages', {
          ...receipt,
          payload: { ...receipt.payload, controlFingerprint: '0'.repeat(64) },
        }),
      ]),
    ).toThrow(/immutable/);
    for (const override of [{ acceptedReceiptId: 'missing' }, { planId: 'missing' }])
      expect(() =>
        applyMutations(state, [
          setMutation('parallelExecution', { ...state.parallelExecution, ...override }),
        ]),
      ).toThrow();
  });

  it('replans only at quiescence, preserves history and revalidates even an unchanged plan identity', () => {
    const previous = reviewed(awaitingReview());
    const state = applyMutations(previous, [setMutation('phase', 'planning')]);
    const next = applyMutations(state, decide(state, options()).mutations);
    expect(next.parallelExecution?.planId).not.toBe(state.parallelExecution?.planId);
    expect(next.phase).toBe('testing');
    expect(next.subtasks.every((node) => node.status === 'done')).toBe(true);
    const changed = applyMutations(state, [
      setMutation('architecture', {
        executionPlan: {
          version: 1,
          subtasks: state.subtasks.map((node) => ({
            id: node.id,
            title: node.id === 'A' ? 'Revised A' : node.title,
            dependsOn: node.dependsOn,
          })),
        },
      }),
    ]);
    const replanned = applyMutations(changed, decide(changed, options()).mutations);
    expect(replanned.parallelExecution?.activeWave?.subtaskIds).toEqual(['A']);
    expect(replanned.subtasks.find((node) => node.id === 'B')?.status).toBe('done');
    expect(replanned.subtasks.find((node) => node.id === 'C')?.status).toBe('todo');
    const removed = applyMutations(state, [
      setMutation('architecture', {
        executionPlan: {
          version: 1,
          subtasks: [{ id: 'A', title: 'A', dependsOn: [] }],
        },
      }),
    ]);
    expect(() => decide(removed, options())).toThrow(/delete historical/);
  });

  it('rejects malformed, unknown and duplicate review references and degrades only absent references', () => {
    const state = awaitingReview();
    for (const references of [[], ['unknown'], ['A', 'A'], 'A', ['A', 1]])
      expect(() => decide(reviewed(state, references), options())).toThrow(/subtaskIds/);
    const missing = reviewed(state);
    const result = decide(missing, options());
    const reopened = applyMutations(missing, result.mutations);
    expect(
      reopened.messages.find((message) => message.payload.kind === 'review_rework')?.payload,
    ).toMatchObject({
      degraded: true,
      reason: 'missing_subtask_refs',
      subtaskIds: ['C', 'A', 'B'],
    });
    expect(reopened.parallelExecution?.activeWave?.subtaskIds).toEqual(['A', 'B']);
    expect(reopened.subtasks.find((subtask) => subtask.id === 'C')?.status).toBe('todo');
  });

  it('starts test rework from the failed validation HEAD without advancing the accepted base', () => {
    const initial = planned();
    const first = applyMutations(initial, decide(initial, options()).mutations);
    const failed = testedWave(first, false);
    const retry = applyMutations(failed, decide(failed, options()).mutations);
    expect(retry.parallelExecution?.acceptedReceiptId).toBeUndefined();
    expect(retry.parallelExecution?.activeWave).toMatchObject({
      attempt: 2,
      base: { commit: 'd'.repeat(40) },
      subtaskIds: ['A', 'B'],
    });
    expect(retry.integration).toBeUndefined();
    expect(retry.parallelExecution?.activeWave?.validation).toBeUndefined();
    expect(retry.subtasks.find((subtask) => subtask.id === 'C')?.status).toBe('todo');
    expect(retry.iterationCount).toBe(1);
  });

  it('requires fresh evidence after semantic change but preserves priority-only dispatch membership', () => {
    const reviewing = awaitingReview();
    const complete = reviewed(reviewing, ['A']);
    const changed = decide(complete, {
      ...options(),
      parallel: { ...options().parallel, controlFingerprint: '0'.repeat(64) },
    });
    expect(changed.route.kind === 'worker' && changed.route.batch[0].role).toBe('TESTER');
    const next = applyMutations(complete, changed.mutations);
    expect(next.subtasks.every((subtask) => subtask.status === 'done')).toBe(true);
    expect(next.parallelExecution?.activeWave?.validation?.receiptId).toBeUndefined();
    expect(next.parallelExecution?.activeWave?.validation?.inputCommit).toBe('d'.repeat(40));
    const dispatch = next.messages.find(
      (message) => message.msgId === next.parallelExecution?.activeWave?.validation?.dispatchId,
    );
    expect(dispatch?.payload.sourceReceiptId).toBe(complete.parallelExecution?.acceptedReceiptId);
    if (dispatch === undefined) throw new Error('expected cumulative revalidation dispatch');
    for (const sourceReceiptId of [
      null,
      'missing',
      dispatch.msgId,
      next.messages.find((message) => message.payload.kind === 'wave_validation')?.msgId,
    ]) {
      const corrupt = structuredClone(next);
      const fact = corrupt.messages.find((message) => message.msgId === dispatch.msgId);
      if (fact === undefined) throw new Error('missing dispatch');
      fact.payload.sourceReceiptId = sourceReceiptId;
      expect(() => validationSourceReceipt(corrupt, dispatch.msgId)).toThrow(/source receipt/);
    }
    const drifted = structuredClone(next);
    const fact = drifted.messages.find((message) => message.msgId === dispatch.msgId);
    if (fact === undefined) throw new Error('missing dispatch');
    fact.payload.inputCommit = 'e'.repeat(40);
    expect(() => validationSourceReceipt(drifted, dispatch.msgId)).toThrow(/source receipt/);
    const initial = planned();
    const started = applyMutations(initial, decide(initial, options()).mutations);
    const reprioritized = applyMutations(started, [
      mergeByIdMutation('subtasks', 'B', { priority: 100 }),
    ]);
    expect(decide(reprioritized, options()).route).toEqual(decide(started, options()).route);
  });
  it('dispatches every ready node atomically with stable assignments and no premature completion', () => {
    const state = planned();
    const result = decide(state, options());
    expect(result.route.kind).toBe('worker');
    if (result.route.kind !== 'worker') throw new Error('expected workers');
    expect(result.route.parallel).toBe(true);
    expect(result.route.batch.map((assignment) => assignment.subtaskId)).toEqual(['A', 'B']);
    const started = applyMutations(state, result.mutations);
    expect(started.parallelExecution?.activeWave?.coderWorkerIds).toEqual(
      result.route.batch.map((assignment) => assignment.workerId),
    );
    expect(started.subtasks.map((subtask) => [subtask.id, subtask.status])).toEqual([
      ['C', 'todo'],
      ['A', 'in_progress'],
      ['B', 'in_progress'],
    ]);
    expect(decide(started, options())).toEqual({ route: result.route, mutations: [] });
    const settled = applyMutations(
      started,
      started.workers.map((worker) =>
        mergeByIdMutation('workers', worker.workerId, { status: 'done' }),
      ),
    );
    const integrate = decide(settled, options());
    expect(integrate.route).toEqual({ kind: 'integrate' });
    const integrating = applyMutations(settled, integrate.mutations);
    expect(integrating.phase).toBe('integrating');
    expect(integrating.subtasks.every((subtask) => subtask.status !== 'done')).toBe(true);
    expect(integrating.iterationCount).toBe(0);
  });

  it('retries a legacy failed batch before recovering its not-started pending identities', () => {
    const state = planned();
    const started = applyMutations(state, decide(state, options()).mutations);
    const [a, b] = started.workers;
    if (a === undefined || b === undefined) throw new Error('expected coding batch');
    const failed = applyMutations(started, [
      mergeByIdMutation('workers', a.workerId, { status: 'failed' }),
    ]);
    const decision = decide(failed, options());
    if (decision.route.kind !== 'worker') throw new Error('expected retry');
    expect(decision.route.batch.map((worker) => worker.subtaskId)).toEqual(['A', 'B']);
    expect(
      decision.route.batch.every(
        (worker) => worker.workerId !== a.workerId && worker.workerId !== b.workerId,
      ),
    ).toBe(true);
    const next = applyMutations(failed, decision.mutations);
    expect(next.iterationCount).toBe(1);
    expect(next.workers.find((worker) => worker.workerId === b.workerId)?.status).toBe('pending');
  });

  it('preserves authorized D4 paused identities even when a sibling has failed', () => {
    const state = planned();
    const started = applyMutations(state, decide(state, options()).mutations);
    const [a, b] = started.workers;
    if (a === undefined || b === undefined) throw new Error('expected coding batch');
    const paused = applyMutations(started, [
      mergeByIdMutation('workers', a.workerId, { status: 'failed' }),
      mergeByIdMutation('workers', b.workerId, { status: 'paused', safePoint: 'safe-b' }),
    ]);
    const decision = decide(paused, { ...options(), resumingWorkerIds: [b.workerId] });
    expect(decision.route).toEqual({
      kind: 'worker',
      parallel: false,
      batch: [{ workerId: b.workerId, role: 'CODER', subtaskId: 'B' }],
    });
    expect(decision.mutations).toEqual([]);
    expect(() => decide(paused, options())).toThrow(/has not settled/);
  });

  it('preserves successful workers and replaces only failed workers on retry', () => {
    const state = planned();
    const started = applyMutations(state, decide(state, options()).mutations);
    const [a, b] = started.workers;
    if (a === undefined || b === undefined) throw new Error('expected two workers');
    const failed = applyMutations(started, [
      mergeByIdMutation('workers', a.workerId, { status: 'done' }),
      mergeByIdMutation('workers', b.workerId, { status: 'failed' }),
    ]);
    const retry = decide(failed, options());
    expect(retry.route.kind).toBe('worker');
    if (retry.route.kind !== 'worker') throw new Error('expected retry');
    expect(retry.route.batch.map((assignment) => assignment.subtaskId)).toEqual(['B']);
    expect(retry.route.batch[0].workerId).not.toBe(b.workerId);
    const resumed = applyMutations(failed, retry.mutations);
    expect(resumed.parallelExecution?.activeWave?.coderWorkerIds[0]).toBe(a.workerId);
    expect(resumed.parallelExecution?.activeWave?.base.commit).toBe('a'.repeat(40));
    expect(resumed.iterationCount).toBe(1);
    expect(resumed.workers.find((worker) => worker.workerId === b.workerId)?.status).toBe('failed');
  });
});
