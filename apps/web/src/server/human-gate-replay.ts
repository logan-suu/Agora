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
  if (
    plans === undefined &&
    state.workers.some(
      (worker) =>
        (worker.safePoint !== undefined && receipt.safePointRefs.includes(worker.safePoint)) ||
        worker.sessionId === `human-gate-resume:${actionId}:${worker.workerId}`,
    )
  ) {
    throw Error('missing historical worker resume plans');
  }
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
