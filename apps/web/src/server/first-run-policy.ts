import { createHash } from 'node:crypto';
import type { AppState } from '@agora/core-domain';

export function firstRunScope(operationId: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId))
    throw Error('invalid_entry_operation');
  const id = createHash('sha256').update(operationId).digest('hex').slice(0, 32);
  return { projectId: `project-${id}`, taskId: `work-${id}` };
}
/** This predicate is only one part of startup; the host must also prove the
 * immutable entry receipt, grant, selection scope and absence of a launch receipt. */
export function firstRunStartEligible(state: AppState) {
  return (
    Boolean(state.localExecution) &&
    state.phase === 'clarifying' &&
    state.iterationCount === 0 &&
    state.workers.length === 0 &&
    state.subtasks.length === 0 &&
    state.requirements.length === 0 &&
    state.handoffPackets.length === 0 &&
    state.reviewComments.length === 0 &&
    state.decisionLedger.length === 0 &&
    state.humanGate === undefined &&
    state.messages.every(
      (m) =>
        m.fromRole === 'leader' &&
        m.channelId === 'main' &&
        typeof m.display === 'string' &&
        m.display.startsWith('/workspace grant '),
    )
  );
}
