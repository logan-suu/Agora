/** Trusted composition-only companion. It does not grant workspace or execution authority. */
import type { AppState, WorkspaceVersionV1 } from '@agora/core-domain';

export type ValidationDispatchScope = {
  projectId: string;
  taskId: string;
  waveId: string;
  attempt: number;
  integrationId: string;
};
export type ValidationDispatchReference = {
  scope: ValidationDispatchScope;
  planHash: string;
};
export type ValidationDispatchVerification = {
  identity: {
    scope: ValidationDispatchScope;
    dispatchId: string;
    workerId: string;
  };
  /** The runtime must derive this from the bound, verified handoff object graph. */
  before: AppState;
  current: AppState;
  plan: unknown;
};
export interface ValidationDispatchVerifier {
  verify(input: ValidationDispatchVerification): Promise<'released' | 'dispatched'>;
}

/** Trusted L2 commit companion. The fixed plan comes only from the unique durable slot;
 * this source must verify current control and physical completion on every read. */
export interface ValidationDispatchCommitSource {
  /** Read the immutable plan and current control without repeating the physical
   * chain; readForCommit still must prove that chain before and after CAS. */
  readFixedForCommit(reference: ValidationDispatchReference): Promise<{
    stage: 'released' | 'dispatched';
    planHash: string;
    call: ValidationDispatchCall;
    version: WorkspaceVersionV1;
    before: AppState;
    plan: unknown;
  }>;
  readForCommit(reference: ValidationDispatchReference): Promise<{
    stage: 'released' | 'dispatched';
    planHash: string;
    call: ValidationDispatchCall;
    version: WorkspaceVersionV1;
    before: AppState;
    plan: unknown;
  }>;
}

export type ValidationDispatchCall = {
  projectId: string;
  taskId: string;
  integrationId: string;
  claimId: string;
  workspaceId: string;
  writerEpoch: number;
  grantRevision: number;
};

/** Fixed first-TESTER registration input. This is a control request, not a
 * workspace claim or execution lease. The runtime must reprove its sources. */
export type ValidationGitRegistrationRequest = ValidationDispatchScope & {
  planHash: string;
  dispatchId: string;
  actionId: string;
  rootId: string;
  grantId: string;
  expectedRevision: number;
  sourceWorkspaceId: string;
  version: WorkspaceVersionV1;
  targets: [{ purpose: 'validation'; workspaceId: string; workerId: string }];
};
export type ValidationHandoffOrigin = {
  state: AppState;
  version: WorkspaceVersionV1;
  registry: unknown;
  handoffPlanHash: string;
  handoffConfirmedHash: string;
};

/** Trusted preparation companion. Only the unique slot publishes a plan;
 * physical proof and Coordinator reconstruction remain separate obligations. */
export interface ValidationPreparationPublication {
  load(scope: ValidationDispatchScope): Promise<
    | {
        planHash: string;
        actionId: string;
        validationWorkspaceId: string;
        call: ValidationDispatchCall;
      }
    | undefined
  >;
  readHandoff(call: ValidationDispatchCall): Promise<ValidationHandoffOrigin>;
  publish(input: {
    scope: ValidationDispatchScope;
    call: ValidationDispatchCall;
    actionId: string;
    validationWorkspaceId: string;
    origin: ValidationHandoffOrigin;
    dispatchPlan: unknown;
  }): Promise<{ planHash: string }>;
}
