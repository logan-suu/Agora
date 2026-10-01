/** Immutable artifact addressing. New rounds never reuse the legacy task key. */
import { isWorkspaceVersionV1 } from '@agora/core-domain';
import { localRecordHash } from './local-registry-records';
import type { WorkspaceFileArtifact } from './workspace-worker-port';

type Identity = { projectId: string; taskId: string; roundId?: string; reviewId?: string };
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
export function localFileArtifactKey(identity: Identity): string {
  const hasRound = Object.hasOwn(identity, 'roundId');
  if (
    !id(identity.projectId) ||
    !id(identity.taskId) ||
    hasRound !== Object.hasOwn(identity, 'reviewId') ||
    (hasRound && (!id(identity.roundId) || !id(identity.reviewId)))
  )
    throw Error('local_artifact_conflict');
  return localRecordHash({
    kind: hasRound ? 'round-file-artifact' : 'task-file-artifact',
    projectId: identity.projectId,
    taskId: identity.taskId,
    ...(hasRound ? { roundId: identity.roundId, reviewId: identity.reviewId } : {}),
  });
}
export function parseLocalFileArtifact(
  value: unknown,
  key: string,
): WorkspaceFileArtifact & Identity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('local_artifact_conflict');
  const artifact = value as WorkspaceFileArtifact & Identity;
  const fields = [
    'schemaVersion',
    'receiptId',
    'projectId',
    'taskId',
    'sourceWorkspaceId',
    'validationReceiptId',
    'approvalActionId',
    'workspaceVersion',
    'path',
    'fixedInputHash',
    ...(Object.hasOwn(value, 'roundId') ? ['roundId', 'reviewId'] : []),
  ];
  if (
    Object.keys(value).sort().join(',') !== fields.sort().join(',') ||
    artifact.schemaVersion !== 'workspace-file-artifact-v1' ||
    ![artifact.sourceWorkspaceId, artifact.validationReceiptId, artifact.approvalActionId].every(
      id,
    ) ||
    !isWorkspaceVersionV1(artifact.workspaceVersion) ||
    typeof artifact.path !== 'string' ||
    !artifact.path.startsWith('/') ||
    artifact.path.includes('\0') ||
    !/^[a-f0-9]{64}$/.test(artifact.fixedInputHash) ||
    localFileArtifactKey(artifact) !== key ||
    artifact.receiptId !== `artifact:${key}`
  )
    throw Error('local_artifact_conflict');
  return structuredClone(artifact);
}
