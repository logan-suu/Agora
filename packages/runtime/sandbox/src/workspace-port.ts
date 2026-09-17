/** L3 workspace contracts. Data references never confer live authority. */
import type { FileVersionV1, WorkspaceCall, WorkspaceVersionV1 } from '@agora/core-domain';
import type { RunResult } from './types';

export type WorkspaceFileApply = WorkspaceCall & {
  schemaVersion: 'workspace-file-apply-v1';
  receiptId: string;
  inputHash: string;
  stage: 'applied' | 'conflict' | 'recoveryRequired';
  createdAt: number;
  canonicalSourceRef: string;
  quiescent: boolean;
  effect: boolean | null;
  needsAttention: boolean;
  items: {
    path: string;
    expected: FileVersionV1;
    observed: FileVersionV1 | null;
    result: FileVersionV1 | null;
    baselineContentRef: string | null;
    candidateContentRef: string;
    nativeReceiptRef: string | null;
  }[];
};

export type WorkspaceFileBatchApply = Omit<WorkspaceFileApply, 'schemaVersion' | 'stage'> & {
  schemaVersion: 'workspace-file-batch-v1';
  stage: 'applied' | 'conflict' | 'partial' | 'recoveryRequired';
  childReceipts: string[];
  reason:
    | 'none'
    | 'preflight_conflict'
    | 'item_failed'
    | 'read_set_changed'
    | 'authority_or_evidence_changed';
};

export type WorkspaceCommandRequest = {
  toolId: 'node' | 'node-generate' | 'pnpm-install';
  argv: string[];
  inputVersion: WorkspaceVersionV1;
  outputRoot: 'private-per-operation';
  networkGrantId: null;
  timeoutMs: number;
};

export type WorkspaceCommandReceipt = WorkspaceCall & {
  schemaVersion: 'workspace-command-receipt-v1';
  receiptId: string;
  commandId: string;
  inputHash: string;
  canonicalSourceRef: string;
  inputVersion: WorkspaceVersionV1;
  policyHash: string;
  toolVersion: string;
  stage: 'exited' | 'timedOut' | 'needsAttention';
  createdAt: number;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  quiescent: boolean;
  assurance: 'bounded';
  reason:
    | 'none'
    | 'authority_changed'
    | 'fixed_input_changed'
    | 'source_version_changed'
    | 'launch_failed'
    | 'cleanup_incomplete'
    | 'output_incomplete';
  stdoutRef: string;
  stderrRef: string;
  nativeRecordHash: string;
  fixedInputHash: string;
};
export type WorkspaceCommandResult = WorkspaceCommandReceipt & RunResult;

export type WorkspaceFileRead = { readReceiptId: string; version: FileVersionV1 } & (
  | { kind: 'file'; content: Buffer }
  | { kind: 'absent' }
);
export type WorkspaceReadSetEntry = { path: string; version: FileVersionV1; readReceiptId: string };

export type WorkspaceToolChange = {
  path: string;
  expected: FileVersionV1;
  readReceiptId: string;
  content: string;
  encoding: 'utf8' | 'base64';
};
export type WorkspaceInspection = {
  version: WorkspaceVersionV1;
  files: { path: string; version: FileVersionV1 }[];
  excludedPaths: string[];
};
/** Bound by the trusted composition. Model arguments cannot supply authority. */
export interface BoundWorkspaceTools {
  generated?(
    actionId: string,
    receiptId: string,
    path: string,
  ): Promise<{ kind: 'generated'; inputVersion: WorkspaceVersionV1; content: Buffer }>;
  inspect(actionId: string): Promise<WorkspaceInspection>;
  read(actionId: string, path: string): Promise<WorkspaceFileRead>;
  apply(
    actionId: string,
    changes: readonly WorkspaceToolChange[],
    dependencies: readonly WorkspaceReadSetEntry[],
  ): Promise<WorkspaceFileApply | WorkspaceFileBatchApply>;
  run(actionId: string, request: WorkspaceCommandRequest): Promise<WorkspaceCommandResult>;
}
