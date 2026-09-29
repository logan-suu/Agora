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

/** Control lineage for an initial or accepted wave's first attempt and its
 * worker-only retries. Validation/conflict rework needs another consumer. */
export function readCodingWorkerLineage(state: AppState) {
  assertParallelState(state);
  const execution = state.parallelExecution,
    wave = execution?.activeWave;
  if (!execution || !wave || wave.attempt !== 1 || wave.preparationWorkerId)
    throw Error('coding_lineage_unsupported');
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
    !equal(origin.payload.base, wave.base) ||
    !equal(origin.payload.subtaskIds, wave.subtaskIds) ||
    !ids(origin.payload.workerIds) ||
    origin.payload.workerIds.length !== wave.subtaskIds.length
  )
    throw Error('coding_lineage_mismatch');
  if (origin.payload.reworkSourceMsgId !== undefined) throw Error('coding_lineage_unsupported');
  const acceptedId = execution.acceptedReceiptId;
  if (acceptedId === undefined) {
    if (!equal(wave.base, execution.initialBase)) throw Error('coding_lineage_mismatch');
  } else {
    const acceptedIndex = state.messages.findIndex((message) => message.msgId === acceptedId);
    const accepted = validationReceipt(state, acceptedId);
    if (
      acceptedIndex < 0 ||
      acceptedIndex >= originIndex ||
      accepted.planId !== execution.planId ||
      !accepted.results.passed ||
      !equal(wave.base, {
        branch: accepted.worktree.branch,
        commit: accepted.worktree.headCommit,
      })
    )
      throw Error('coding_lineage_mismatch');
  }
  validationSubtaskIds(state, wave);
  const seen = new Set<string>();
  const originalWorkerIds = origin.payload.workerIds;
  const assignments = wave.subtaskIds.map((subtaskId, index) => ({
    subtaskId,
    workerId: originalWorkerIds[index] as string,
    dispatchId: origin.msgId,
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
  for (const [index, m] of state.messages.entries()) {
    const p = m.payload;
    if (p.kind !== 'coding_retry' || p.waveId !== wave.waveId) continue;
    if (
      index <= originIndex ||
      !canonical(m) ||
      p.nextRole !== 'CODER' ||
      p.attempt !== 1 ||
      (p.planId !== undefined && p.planId !== execution.planId) ||
      p.reason !== undefined ||
      p.failedReceiptId !== undefined ||
      !equal(p.base, wave.base) ||
      !ids(p.failedWorkerIds) ||
      !ids(p.workerIds) ||
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
      assignments[position] = { ...assignment, workerId, dispatchId: m.msgId };
    }
  }
  if (
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
    assignments,
  });
}
