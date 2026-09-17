import type { AppState } from '@agora/core-domain';
import {
  assertHumanGateResumedMarker,
  type HumanGateResolutionReceipt,
  readHumanGateWorkerResumes,
} from '@agora/core-orchestration';
import { inspectHarnessSafePoint } from '@agora/runtime-executor';

/** Acknowledging an old command must not execute its old source checkpoint again. */
export function humanGateAlreadyResumed(
  state: AppState,
  actionId: string,
  receipt: HumanGateResolutionReceipt,
): boolean {
  const leaderIndex = state.messages.findIndex((message) => message.msgId === actionId);
  const markers = state.messages.filter(
    (message) => message.msgId === `human-gate-resumed:${actionId}`,
  );
  if (markers.length === 0) return false;
  if (state.humanGate?.gateId === receipt.gateId) throw Error('resolved humanGate is still active');
  const marker = markers[0];
  if (
    markers.length !== 1 ||
    !marker ||
    leaderIndex < 0 ||
    state.messages.indexOf(marker) <= leaderIndex
  )
    throw Error('invalid humanGate resumed order');
  assertHumanGateResumedMarker(marker, actionId, receipt);
  const plans = readHumanGateWorkerResumes(actionId, receipt.safePointRefs, receipt.workerResumes);
  if (plans === undefined) assertLegacyResumeEvidence(state, actionId, receipt, leaderIndex);
  for (const plan of plans ?? []) {
    const worker = state.workers.find((candidate) => candidate.workerId === plan.workerId);
    if (!worker) throw Error('missing resumed worker');
    const source = inspectHarnessSafePoint(plan.sourceSafePointRef);
    if (
      source.projectId !== state.projectId ||
      source.taskId !== state.taskId ||
      source.role !== worker.role
    )
      throw Error('resumed worker scope drift');
    let latest = plan;
    let latestMarkerIndex = state.messages.indexOf(marker);
    // Later gates may legitimately replace a worker's child session. Each link
    // must be a canonical resolution followed by its matching resumed marker.
    for (let index = latestMarkerIndex + 1; index < state.messages.length; index++) {
      const message = state.messages[index];
      const value = message?.payload.resolution;
      if (!message || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const later = value as HumanGateResolutionReceipt;
      if (
        !Array.isArray(later.workerResumes) ||
        !later.workerResumes.some((p) => p?.workerId === plan.workerId)
      )
        continue;
      const laterMarkers = state.messages.filter(
        (candidate) => candidate.msgId === `human-gate-resumed:${message.msgId}`,
      );
      if (laterMarkers.length === 0) continue;
      const laterMarker = laterMarkers[0];
      const intent = message.payload.intent as Record<string, unknown> | undefined;
      const action = message.payload.action as Record<string, unknown> | undefined;
      if (
        laterMarkers.length !== 1 ||
        !laterMarker ||
        state.messages.indexOf(laterMarker) <= index ||
        index <= latestMarkerIndex ||
        message.fromRole !== 'leader' ||
        message.type !== 'chat' ||
        message.channelId !== 'main' ||
        message.payload.kind !== 'leader_intent' ||
        intent?.kind !== 'resolve_human_gate' ||
        intent.gateId !== later.gateId ||
        intent.option !== later.option ||
        intent.argument !== later.argument ||
        action?.status !== 'applied' ||
        later.resumeSessionId !== `human-gate-resume:${message.msgId}` ||
        !Array.isArray(later.safePointRefs)
      )
        throw Error('invalid later humanGate resolution');
      assertHumanGateResumedMarker(laterMarker, message.msgId, later);
      const next = readHumanGateWorkerResumes(
        message.msgId,
        later.safePointRefs,
        later.workerResumes,
      )?.find((p) => p.workerId === worker.workerId);
      if (!next) throw Error('missing later worker plan');
      const identity = inspectHarnessSafePoint(next.sourceSafePointRef);
      if (
        identity.projectId !== source.projectId ||
        identity.taskId !== source.taskId ||
        identity.role !== source.role ||
        identity.cwd !== source.cwd ||
        identity.sourceSessionId !== latest.resumeSessionId
      )
        throw Error('broken humanGate worker lineage');
      latest = next;
      latestMarkerIndex = state.messages.indexOf(laterMarker);
    }
    const latestSource = inspectHarnessSafePoint(latest.sourceSafePointRef);
    const notStarted =
      worker.status === 'paused' &&
      worker.safePoint === latest.sourceSafePointRef &&
      ((latest === plan && worker.sessionId === undefined) ||
        worker.sessionId === latestSource.sourceSessionId);
    if (notStarted) continue;
    if (worker.sessionId !== latest.resumeSessionId) throw Error('resumed worker session drift');
    if (worker.safePoint !== latest.sourceSafePointRef) {
      if (!worker.safePoint) throw Error('missing resumed worker safe point');
      const identity = inspectHarnessSafePoint(worker.safePoint);
      if (
        identity.projectId !== source.projectId ||
        identity.taskId !== source.taskId ||
        identity.role !== source.role ||
        identity.cwd !== source.cwd ||
        identity.sourceSessionId !== latest.resumeSessionId
      )
        throw Error('resumed worker checkpoint drift');
    }
  }
  return true;
}

/** Mutable workers cannot establish that an immutable receipt used the legacy format. */
function assertLegacyResumeEvidence(
  state: AppState,
  actionId: string,
  receipt: HumanGateResolutionReceipt,
  leaderIndex: number,
): void {
  const missing = () => {
    throw Error('missing historical worker resume plans');
  };
  // The legacy composition can restore at most one shared Harness session.
  if (receipt.safePointRefs.length > 1) missing();
  const inspectSource = (ref: string, workerId?: string) => {
    const source = inspectHarnessSafePoint(ref);
    if (source.projectId !== state.projectId || source.taskId !== state.taskId)
      throw Error('legacy humanGate checkpoint scope drift');
    if (
      workerId !== undefined &&
      source.sourceSessionId === `human-gate-resume:${actionId}:${workerId}`
    )
      missing();
  };
  for (const ref of receipt.safePointRefs) inspectSource(ref);
  for (const worker of state.workers) {
    if (worker.safePoint !== undefined) {
      if (receipt.safePointRefs.includes(worker.safePoint)) missing();
      inspectSource(worker.safePoint, worker.workerId);
    }
    if (worker.sessionId === `human-gate-resume:${actionId}:${worker.workerId}`) missing();
  }
  // Later immutable sources still identify the original per-worker child even
  // after every worker has advanced several gates or a worker record is missing.
  for (const message of state.messages.slice(leaderIndex + 1)) {
    if (message.channelId !== 'main') continue;
    let plans: unknown;
    if (
      message.fromRole === 'leader' &&
      message.type === 'chat' &&
      message.payload.kind === 'leader_intent'
    ) {
      const value = message.payload.resolution;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const later = value as Record<string, unknown>;
      plans = later.workerResumes;
      if (Array.isArray(later.safePointRefs)) {
        for (const ref of later.safePointRefs) if (typeof ref === 'string') inspectSource(ref);
      }
    } else if (
      message.fromRole === 'COORDINATOR' &&
      message.type === 'announce' &&
      message.payload.kind === 'human_gate_resumed'
    ) {
      plans = message.payload.workerResumes;
    }
    if (!Array.isArray(plans)) continue;
    for (const plan of plans) {
      if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) continue;
      if (typeof plan.workerId === 'string' && typeof plan.sourceSafePointRef === 'string')
        inspectSource(plan.sourceSafePointRef, plan.workerId);
    }
  }
}
