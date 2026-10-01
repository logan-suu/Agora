import { readIntegrationRework } from './integration-rework';
import {
  assertParallelState,
  canonicalJson,
  validationReceipt,
  validationSubtaskIds,
} from './parallel-execution';
import type { AppState, Message } from './state';

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const ids = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((s) => typeof s === 'string') &&
  new Set(v).size === v.length;
const canonical = (m: Message) =>
  m.fromRole === 'COORDINATOR' && m.type === 'announce' && m.channelId === 'main';

/** Replay canonical coding transitions while keeping successful acceptance
 * separate from the validation receipt that actually supplies the coding base. */
export function readCodingWorkerLineage(state: AppState) {
  assertParallelState(state);
  const execution = state.parallelExecution,
    wave = execution?.activeWave;
  if (!execution || !wave || wave.preparationWorkerId) throw Error('coding_lineage_unsupported');
  if (
    new Set(state.messages.map((m) => m.msgId)).size !== state.messages.length ||
    new Set(state.workers.map((w) => w.workerId)).size !== state.workers.length
  )
    throw Error('coding_lineage_mismatch');
  const originIndex = state.messages.findIndex((m) => m.msgId === wave.waveId);
  const origin = state.messages[originIndex];
  const planIndex = state.messages.findIndex((m) => m.msgId === execution.planId);
  const plan = state.messages[planIndex];
  if (
    !origin ||
    !plan ||
    !canonical(plan) ||
    planIndex >= originIndex ||
    !canonical(origin) ||
    origin.payload.kind !== 'coding_wave' ||
    origin.payload.nextRole !== 'CODER' ||
    origin.payload.planId !== execution.planId ||
    origin.payload.attempt !== 1 ||
    !equal(origin.payload.subtaskIds, wave.subtaskIds) ||
    !ids(origin.payload.workerIds) ||
    origin.payload.workerIds.length !== wave.subtaskIds.length
  )
    throw Error('coding_lineage_mismatch');
  validationSubtaskIds(state, wave);
  const acceptedId = execution.acceptedReceiptId;
  let sourceReceiptId: string | undefined;
  let base = origin.payload.base as typeof wave.base;
  let attempt = 1;
  if (origin.payload.reworkSourceMsgId !== undefined) {
    const rework = state.messages.find((m) => m.msgId === origin.payload.reworkSourceMsgId);
    if (typeof rework?.payload.failedReceiptId !== 'string') throw Error('coding_lineage_mismatch');
    sourceReceiptId = rework.payload.failedReceiptId;
    const receipt = validationReceipt(state, sourceReceiptId);
    if (!equal(base, { branch: receipt.worktree.branch, commit: receipt.worktree.headCommit }))
      throw Error('coding_lineage_mismatch');
  } else if (acceptedId === undefined) {
    if (!equal(base, execution.initialBase)) throw Error('coding_lineage_mismatch');
  } else {
    const acceptedIndex = state.messages.findIndex((message) => message.msgId === acceptedId);
    const accepted = validationReceipt(state, acceptedId);
    if (
      acceptedIndex < 0 ||
      acceptedIndex >= originIndex ||
      accepted.planId !== execution.planId ||
      !accepted.results.passed ||
      !equal(base, {
        branch: accepted.worktree.branch,
        commit: accepted.worktree.headCommit,
      })
    )
      throw Error('coding_lineage_mismatch');
    sourceReceiptId = acceptedId;
  }
  const seen = new Set<string>();
  const originalWorkerIds = origin.payload.workerIds;
  const assignments = wave.subtaskIds.map((subtaskId, index) => ({
    subtaskId,
    workerId: originalWorkerIds[index] as string,
    dispatchId: origin.msgId,
    attempt: 1,
  }));
  const verifyNew = (workerId: string, subtaskId: string, m: Message, index: number) => {
    const worker = state.workers.find((w) => w.workerId === workerId);
    if (
      workerId !== `worker:${m.msgId}:${index}` ||
      seen.has(workerId) ||
      worker?.role !== 'CODER' ||
      worker.subtaskId !== subtaskId
    )
      throw Error('coding_lineage_mismatch');
    seen.add(workerId);
  };
  for (const [i, a] of assignments.entries()) verifyNew(a.workerId, a.subtaskId, origin, i);
  const conflictReworks: (NonNullable<ReturnType<typeof readIntegrationRework>> & {
    attempt: number;
  })[] = [];
  let lastTransition = originIndex;
  for (const [index, m] of state.messages.entries()) {
    const p = m.payload;
    const rework = readIntegrationRework(m);
    if (rework?.integration.waveId === wave.waveId) {
      const old = rework.integration,
        position = assignments.findIndex((a) => a.workerId === rework.conflict.workerId);
      if (
        index <= lastTransition ||
        position < 0 ||
        !equal(old.base, base) ||
        old.pendingBranches.length !== assignments.length ||
        old.pendingBranches.some((branch) => {
          const assignment = assignments.find((a) => a.workerId === branch.workerId);
          const worker = state.workers.find((w) => w.workerId === branch.workerId);
          return (
            !assignment ||
            assignment.subtaskId !== branch.subtaskId ||
            worker?.status !== 'done' ||
            worker.role !== 'CODER' ||
            worker.subtaskId !== branch.subtaskId ||
            !equal(worker.worktree, branch.worktree) ||
            branch.worktree.baseCommit !== base.commit
          );
        })
      )
        throw Error('coding_lineage_mismatch');
      const previous = assignments[position];
      const worker = state.workers.find((w) => w.workerId === rework.replacementId);
      if (
        !previous ||
        seen.has(rework.replacementId) ||
        worker?.role !== 'CODER' ||
        worker.subtaskId !== previous.subtaskId ||
        conflictReworks.some((r) => r.integration.integrationId === old.integrationId)
      )
        throw Error('coding_lineage_mismatch');
      attempt++;
      seen.add(rework.replacementId);
      assignments[position] = {
        ...previous,
        workerId: rework.replacementId,
        dispatchId: `integration-rework:${m.msgId}`,
        attempt,
      };
      conflictReworks.push({ ...rework, attempt });
      lastTransition = index;
      continue;
    }
    if (p.kind !== 'coding_retry' || p.waveId !== wave.waveId) continue;
    if (
      index <= lastTransition ||
      !canonical(m) ||
      p.nextRole !== 'CODER' ||
      (p.planId !== undefined && p.planId !== execution.planId) ||
      !ids(p.workerIds)
    )
      throw Error('coding_lineage_mismatch');
    if (p.reason === 'tests_failed') {
      if (
        p.attempt !== attempt + 1 ||
        typeof p.failedReceiptId !== 'string' ||
        p.failedWorkerIds !== undefined ||
        p.base !== undefined ||
        p.workerIds.length !== assignments.length
      )
        throw Error('coding_lineage_mismatch');
      const receiptIndex = state.messages.findIndex((entry) => entry.msgId === p.failedReceiptId);
      const receipt = validationReceipt(state, p.failedReceiptId);
      const dispatchIndex = state.messages.findIndex((entry) => entry.msgId === receipt.dispatchId);
      if (
        receiptIndex >= index ||
        dispatchIndex <= lastTransition ||
        receipt.planId !== execution.planId ||
        receipt.waveId !== wave.waveId ||
        receipt.attempt !== attempt ||
        receipt.results.passed ||
        !equal(receipt.subtaskIds, validationSubtaskIds(state, wave)) ||
        state.workers.find((w) => w.workerId === receipt.workerId)?.status !== 'done' ||
        assignments.some(
          (a) => state.workers.find((w) => w.workerId === a.workerId)?.status !== 'done',
        )
      )
        throw Error('coding_lineage_mismatch');
      sourceReceiptId = p.failedReceiptId;
      if (!receipt.worktree.headCommit) throw Error('coding_lineage_mismatch');
      base = { branch: receipt.worktree.branch, commit: receipt.worktree.headCommit };
      attempt++;
      for (const [i, assignment] of assignments.entries()) {
        const workerId = p.workerIds[i] as string;
        verifyNew(workerId, assignment.subtaskId, m, i);
        assignments[i] = { ...assignment, workerId, dispatchId: m.msgId, attempt };
      }
    } else {
      if (
        p.reason !== undefined ||
        p.attempt !== attempt ||
        !equal(p.base, base) ||
        (p.failedReceiptId !== undefined && p.failedReceiptId !== sourceReceiptId) ||
        !ids(p.failedWorkerIds) ||
        p.failedWorkerIds.length !== p.workerIds.length
      )
        throw Error('coding_lineage_mismatch');
      const positions = p.failedWorkerIds.map((id) =>
        assignments.findIndex((a) => a.workerId === id),
      );
      const predecessors = p.failedWorkerIds.map((id) =>
        state.workers.find((w) => w.workerId === id),
      );
      if (
        positions.some((position) => position < 0) ||
        predecessors.some((w) => !w || !['failed', 'pending'].includes(w.status)) ||
        !predecessors.some((w) => w?.status === 'failed')
      )
        throw Error('coding_lineage_mismatch');
      for (const [replacementIndex, position] of positions.entries()) {
        const assignment = assignments[position],
          workerId = p.workerIds[replacementIndex];
        if (!assignment || !workerId) throw Error('coding_lineage_mismatch');
        verifyNew(workerId, assignment.subtaskId, m, replacementIndex);
        assignments[position] = { ...assignment, workerId, dispatchId: m.msgId, attempt };
      }
    }
    lastTransition = index;
  }
  if (
    attempt !== wave.attempt ||
    !equal(base, wave.base) ||
    !equal(
      assignments.map((a) => a.workerId),
      wave.coderWorkerIds,
    )
  )
    throw Error('coding_lineage_mismatch');
  return structuredClone({
    planId: execution.planId,
    waveId: wave.waveId,
    attempt: wave.attempt,
    base: wave.base,
    ...(acceptedId === undefined ? {} : { acceptedReceiptId: acceptedId }),
    ...(sourceReceiptId === undefined ? {} : { sourceReceiptId }),
    assignments,
    conflictReworks,
  });
}
