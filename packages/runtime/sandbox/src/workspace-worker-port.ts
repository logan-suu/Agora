/** L3 worker lifecycle companion. A closure proves current lease ownership;
 * serialized worker IDs or grant revisions cannot replace this capability. */
import type { WorkspaceRefV1, WorkspaceVersionV1 } from '@agora/core-domain';
import type {
  BoundWorkspaceTools,
  WorkspaceCommandRequest,
  WorkspaceCommandResult,
  WorkspaceInspection,
} from './workspace-port';

/** Trusted evidence consumer, never exposed in the model tool catalog. */
export interface WorkspaceValidationEvidencePort {
  verifyCommand(
    scope: { projectId: string; taskId: string; workspaceId: string },
    receiptId: string,
  ): Promise<{
    command: WorkspaceCommandResult;
    request: WorkspaceCommandRequest;
    toolchainHash: string;
    dependenciesHash: string;
  }>;
  verifyCurrentVersion(
    scope: { projectId: string; taskId: string; workspaceId: string },
    version: WorkspaceVersionV1,
  ): Promise<{ policyHash: string; toolchainHash: string; inspection: WorkspaceInspection }>;
}

export interface WorkspaceWorkerAdmission {
  projectId: string;
  taskId: string;
  workerId: string;
  role: string;
  subtaskId?: string;
  sessionId: string;
  assertLease(): void;
}
export interface WorkspaceWorkerSession {
  readonly sessionId: string;
  readonly workspace: WorkspaceRefV1;
  readonly tools: BoundWorkspaceTools;
  /** Verify authority and no incomplete file/command operation at a safe boundary. */
  checkpoint(reason: 'step' | 'pause' | 'complete'): Promise<void>;
  /** Close new tool admission and persist bounded quiescence before returning.
   * Retains the task's write claim; final task release is a control operation. */
  close(): Promise<void>;
}
export interface WorkspaceWorkerPort {
  open(admission: WorkspaceWorkerAdmission): Promise<WorkspaceWorkerSession>;
  openControl?(admission: WorkspaceWorkerAdmission): Promise<WorkspaceControlSession>;
}
export interface WorkspaceControlSession {
  readonly kind: 'control';
  readonly sessionId: string;
  checkpoint(reason: 'step' | 'pause' | 'complete'): Promise<void>;
  close(): Promise<void>;
}
export interface WorkspaceFileArtifact {
  schemaVersion: 'workspace-file-artifact-v1';
  receiptId: string;
  projectId: string;
  taskId: string;
  sourceWorkspaceId: string;
  validationReceiptId: string;
  approvalActionId: string;
  workspaceVersion: WorkspaceVersionV1;
  path: string;
  fixedInputHash: string;
}
export interface WorkspaceArchivePort {
  recoverCompletion(scope: { projectId: string; taskId: string }): Promise<void>;
  archiveCompletion(scope: { projectId: string; taskId: string }): Promise<WorkspaceFileArtifact>;
  releaseCompleted(scope: { projectId: string; taskId: string }): Promise<void>;
}
