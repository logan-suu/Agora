/** Trusted initial batch preparation. Never expose this service as a model tool.
 * Physical preparation precedes one registry/TaskState transaction; no worker is started. */
import {
  type AppState,
  currentReviewDispatch,
  isReviewBinding,
  isWorkspaceVersionV1,
  isWorktreeRef,
  readCodingWorkerLineage,
  validationReceipt,
  type WaveValidationReceipt,
  type WorkspaceRefV1,
  type WorkspaceVersionV1,
  type WorktreeRef,
} from '@agora/core-domain';
import { readAcceptedCodingBaseline } from './local-accepted-coding-baseline';
import type { LocalBindingCoordinator, LocalBindingRequest } from './local-binding-coordinator';
import { readInitialCodingBaseline } from './local-coding-baseline';
import type { LocalControlObjects } from './local-control-objects';
import { readLocalDeliveryGitBaseline } from './local-delivery-git-baseline';
import { createLocalGitBaseline } from './local-git-baseline';
import { LocalGitReviewerBinding } from './local-git-reviewer-binding';
import type { LocalGitSessionOptions } from './local-git-session';
import { LocalGitVersionStore } from './local-git-version-store';
import { createLocalGitWorktree } from './local-git-worktree';
import type { ApplicationRequest } from './local-integration-application-records';
import type {
  LocalIntegrationAuthority,
  LocalIntegrationCall,
} from './local-integration-authority';
import { initializeLocalLinkedRoot, verifyLocalLinkedRoot } from './local-linked-root';
import { assertLocalRangeAdmission } from './local-range-admission';
import {
  isLocalBindingOperation,
  type LocalLinkedRootRecord,
  type LocalRegistryRecords,
  localRecordHash,
} from './local-registry-records';
import type { LocalRootCoordinator } from './local-root-coordinator';
import { assertValidationSourceWave } from './local-validation-source-wave';
import type { LocalVersionStore } from './local-version-store';
import { localRootBinding } from './local-workspace-authority';
import type { ValidationGitRegistrationRequest } from './validation-dispatch-port';

export type LocalGitWorkspaceOptions = Pick<
  LocalGitSessionOptions,
  'privateRoot' | 'git' | 'metadataHelper'
> & {
  helpers: { inspector: string; initializer: string };
  journalRoot: string;
};
type Scope = { projectId: string; taskId: string };
type Target = { workspaceId: string } & (
  | { purpose: 'integration' }
  | { purpose: 'coding' | 'validation'; workerId: string }
);
type Request = Scope & {
  actionId: string;
  rootId: string;
  grantId: string;
  expectedRevision: number;
  version: WorkspaceVersionV1;
  targets: Target[];
};
type WaveRequest = Request & { waveId: string; attempt: number; sourceWorkspaceId: string };
export type LocalGitBatchRequest = Request | WaveRequest | ValidationGitRegistrationRequest;
type Options = {
  control: LocalBindingCoordinator;
  roots: LocalRootCoordinator;
  objects: LocalControlObjects;
  versions: LocalVersionStore;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  gitOptions: LocalGitWorkspaceOptions;
  /** Original base proof for a canonical native conflict replacement; never caller supplied. */
  readConflictBase?(
    state: AppState,
  ): Promise<{ version: WorkspaceVersionV1; sourceWorkspaceId: string; actionId: string }>;
  /** Must verify canonical command evidence and its exact Git version, not model claims. */
  verifyAcceptedVersion?(
    state: AppState,
    receipt: WaveValidationReceipt,
    version: WorkspaceVersionV1,
  ): Promise<void>;
  /** Trusted composition must reprove the unique preparation slot and original
   * native completion. This is never supplied by a model or HTTP request. */
  verifyValidationPreparation?(
    request: ValidationGitRegistrationRequest,
    state: AppState,
  ): Promise<void>;
  verifyValidationSlot?(request: ValidationGitRegistrationRequest): Promise<void>;
  verifyValidationRegistered?(
    request: ValidationGitRegistrationRequest,
    state: AppState,
    registry: LocalRegistryRecords,
    binding: LocalBindingRequest,
  ): Promise<void>;
  /** A bound first-TESTER worktree is not executable until the separate
   * preparation confirmation and current admission have both been proven. */
  verifyValidationAdmission?(state: AppState, workerId: string): Promise<void>;
  /** Host-owned private receipt/physical proof before a REVIEWER binding. */
  verifyReviewCandidate?(state: AppState, workerId: string): Promise<WorkspaceVersionV1>;
};
export type LocalCodingBaselineOptions = Pick<
  Options,
  'objects' | 'versions' | 'verifyGrant' | 'gitOptions' | 'verifyAcceptedVersion'
> & { control: Pick<LocalBindingCoordinator, 'assertClosed' | 'snapshot'> };
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys;

export class LocalGitWorkspaces {
  /** Historical initial base, never the current user checkout HEAD. */
  async readInitialBase(expected: AppState) {
    const scope = { projectId: expected.projectId, taskId: expected.taskId };
    const state = await this.options.control.assertClosed(scope);
    if (localRecordHash(state) !== localRecordHash(expected))
      throw Error('local_parallel_state_changed');
    const initial = state.localExecution?.workspaces.find(
      (w) => w.workspaceId === state.localExecution?.git?.initialWorkspaceId,
    );
    if (initial?.mode !== 'linked-worktree' || initial.purpose !== 'integration')
      throw Error('local_parallel_base_changed');
    const proved = await readLocalDeliveryGitBaseline(
      { ...this.options, gitOptions: this.git },
      scope,
    );
    if (
      proved.receipt.commit !== initial.baseCommit ||
      localRecordHash(await this.options.control.assertClosed(scope)) !== localRecordHash(state)
    )
      throw Error('local_parallel_base_changed');
    return { branch: initial.branch, commit: initial.baseCommit };
  }
  private tail: Promise<unknown> = Promise.resolve();
  private readonly git: LocalGitWorkspaceOptions;
  constructor(private readonly options: Options) {
    localRecordHash(options.gitOptions);
    this.git = structuredClone(options.gitOptions);
  }

  readCodingBaseline(input: Scope & { workerId: string }) {
    return readInitialCodingBaseline({ ...this.options, gitOptions: this.git }, input);
  }

  /** Historical baseline only through a proof-bound integration reader. No writer is created. */
  async readIntegrationCodingBaseline(
    input: Scope & { workerId: string },
    authority: LocalIntegrationAuthority,
    call: LocalIntegrationCall,
    published?: ApplicationRequest,
  ) {
    const checkpoint = () =>
      published ? authority.readPublishedCheckpoint(published) : authority.readCheckpoint(call);
    const before = await checkpoint();
    if (
      input.projectId !== call.projectId ||
      input.taskId !== call.taskId ||
      !before.integration.pendingBranches.some((b) => b.workerId === input.workerId)
    )
      throw Error('coding_baseline_proof_mismatch');
    const checked = async () => {
      await before.authorize();
      return before;
    };
    const control: LocalCodingBaselineOptions['control'] = {
      assertClosed: async (scope) => {
        if (scope.projectId !== call.projectId || scope.taskId !== call.taskId)
          throw Error('coding_baseline_proof_mismatch');
        return (await checked()).state;
      },
      snapshot: async () => (await checked()).snapshot,
    };
    const verifyAcceptedVersion = this.options.verifyAcceptedVersion;
    const options: LocalCodingBaselineOptions = {
      ...this.options,
      gitOptions: this.git,
      control,
    };
    if (verifyAcceptedVersion) {
      options.verifyAcceptedVersion = async (_historical, receipt, version) => {
        await checked();
        // The baseline is historical, but command evidence must still be
        // admitted against the current canonical selection and state.
        const current = await this.options.control.assertClosed(input);
        await verifyAcceptedVersion(current, receipt, version);
        await checked();
      };
    }
    const result = readCodingWorkerLineage(before.state).sourceReceiptId
      ? await readAcceptedCodingBaseline(options, input)
      : await readInitialCodingBaseline(options, input, published);
    await checked();
    return result;
  }

  readAcceptedCodingBaseline(input: Scope & { workerId: string }) {
    return readAcceptedCodingBaseline({ ...this.options, gitOptions: this.git }, input);
  }

  readPublishedCodingBaseline(input: Scope & { workerId: string }, published: ApplicationRequest) {
    return readInitialCodingBaseline(
      { ...this.options, gitOptions: this.git },
      input,
      structuredClone(published),
    );
  }

  /** Registration only; no REVIEWER writer claim or new worktree is created. */
  registerReviewer(input: Scope & { workerId: string }) {
    if (!this.options.verifyReviewCandidate)
      return Promise.reject(Error('local_git_review_proof_unavailable'));
    return new LocalGitReviewerBinding({
      control: this.options.control,
      verifyCandidate: this.options.verifyReviewCandidate,
      verifyGrant: this.options.verifyGrant,
    }).register(input);
  }

  /** Read-only resolution for WorkerRuntime. Does not allocate, start or lease a worker. */
  async resolveAssignment(input: Scope & { workerId: string }) {
    localRecordHash(input);
    if (
      !exact(input, 'projectId,taskId,workerId') ||
      ![input.projectId, input.taskId, input.workerId].every(id)
    )
      throw Error('workspace_assignment_mismatch');
    const scope = structuredClone(input);
    const { control, verifyGrant } = this.options;
    const initial = await control.assertClosed(scope);
    const initialWorker = initial.workers.find((w) => w.workerId === scope.workerId);
    if (initialWorker?.role === 'REVIEWER') {
      // Resolution must never register a missing binding as a side effect.
      if (!initial.localExecution?.bindings.some((b) => b.workerId === scope.workerId))
        throw Error('workspace_assignment_mismatch');
      await this.registerReviewer(scope);
    }
    const state = await control.assertClosed(scope),
      snapshot = await control.snapshot();
    const worker = state.workers.find((w) => w.workerId === scope.workerId);
    const reviewer = worker?.role === 'REVIEWER';
    const dispatch = reviewer ? currentReviewDispatch(state) : undefined;
    const reviewBinding = dispatch?.payload.reviewBinding;
    const reviewReceipt =
      reviewer && isReviewBinding(reviewBinding)
        ? validationReceipt(state, reviewBinding.validationReceiptId)
        : undefined;
    const binding = state.localExecution?.bindings.find((b) => b.workerId === scope.workerId);
    const workspace = state.localExecution?.workspaces.find(
      (w) => w.workspaceId === binding?.workspaceId,
    );
    const record = snapshot.linkedRoots?.find((r) => r.workspaceId === workspace?.workspaceId);
    const mapping = state.localExecution?.git?.worktrees.find(
      (m) => m.workspaceId === workspace?.workspaceId,
    );
    const sourceRoot = snapshot.roots.find(
      (r) => r.rootId === workspace?.rootId && r.projectId === scope.projectId,
    );
    const physicalReceiptId = reviewer ? mapping?.receiptId : binding?.receiptId;
    if (
      !worker ||
      !['pending', 'paused'].includes(worker.status) ||
      !binding ||
      binding.subtaskId !== worker.subtaskId ||
      workspace?.mode !== 'linked-worktree' ||
      !record ||
      !mapping ||
      !sourceRoot ||
      !['CODER', 'TESTER', 'REVIEWER'].includes(worker.role) ||
      workspace.purpose !== (worker.role === 'CODER' ? 'coding' : 'validation') ||
      mapping.path !== record.path ||
      mapping.receiptId !== physicalReceiptId ||
      record.bindingReceiptId !== physicalReceiptId ||
      (reviewer &&
        (!reviewReceipt ||
          !isReviewBinding(reviewBinding) ||
          reviewBinding.commit !== reviewReceipt.worktree.headCommit ||
          reviewReceipt.worktree.path !== record.path ||
          snapshot.claims.some(
            (claim) =>
              claim.projectId === scope.projectId &&
              claim.taskId === scope.taskId &&
              claim.workerId === scope.workerId &&
              claim.status === 'active',
          )))
    )
      throw Error('workspace_assignment_mismatch');
    const worktree =
      worker.worktree ??
      (reviewer
        ? reviewReceipt?.worktree
        : { path: record.path, branch: workspace.branch, baseCommit: workspace.baseCommit });
    if (
      !isWorktreeRef(worktree) ||
      worktree.path !== record.path ||
      worktree.branch !== workspace.branch ||
      worktree.baseCommit !== workspace.baseCommit ||
      (reviewer && localRecordHash(worktree) !== localRecordHash(reviewReceipt?.worktree))
    )
      throw Error('workspace_assignment_mismatch');
    if (
      worker.role === 'TESTER' &&
      worker.subtaskId === undefined &&
      state.parallelExecution?.activeWave?.validation?.workerId === worker.workerId
    ) {
      if (!this.options.verifyValidationAdmission)
        throw Error('validation_preparation_unconfirmed');
      await this.options.verifyValidationAdmission(state, worker.workerId);
    }
    let reviewVersion: WorkspaceVersionV1 | undefined;
    if (reviewer) {
      if (!this.options.verifyReviewCandidate) throw Error('local_git_review_proof_unavailable');
      reviewVersion = await this.options.verifyReviewCandidate(state, scope.workerId);
      if (reviewVersion.kind !== 'git' || reviewVersion.commit !== worktree.headCommit)
        throw Error('local_git_review_binding_changed');
    }
    const authorize = async () => {
      await verifyGrant(scope, workspace.grantId);
      const current = await control.assertClosed(scope);
      if (
        (await control.snapshot()).revision !== snapshot.revision ||
        localRecordHash(current.localExecution) !== localRecordHash(state.localExecution) ||
        localRecordHash(current.workers.find((w) => w.workerId === scope.workerId) ?? null) !==
          localRecordHash(worker)
      )
        throw Error('workspace_assignment_mismatch');
      return true;
    };
    await verifyLocalLinkedRoot({
      ...this.git,
      projectId: scope.projectId,
      taskId: scope.taskId,
      root: sourceRoot.path,
      sourceRoot,
      workspace,
      record,
      expectedHead: worktree.headCommit ?? worktree.baseCommit,
      actionId: record.initialization.actionId,
      creationActionId: record.creation.actionId,
      bindingReceiptId: record.bindingReceiptId,
      authorize,
    });
    await authorize();
    if (reviewer) {
      const version = await this.options.verifyReviewCandidate?.(state, scope.workerId);
      if (!version || localRecordHash(version) !== localRecordHash(reviewVersion))
        throw Error('local_git_review_binding_changed');
      await authorize();
    }
    return structuredClone(worktree);
  }

  registerInitial(input: Request): Promise<WorkspaceRefV1[]> {
    localRecordHash(input);
    if (
      !exact(input, 'actionId,expectedRevision,grantId,projectId,rootId,targets,taskId,version') ||
      ![input.projectId, input.taskId, input.actionId, input.rootId, input.grantId].every(id) ||
      input.actionId.length > 120 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !isWorkspaceVersionV1(input.version) ||
      input.version.kind !== 'files' ||
      !Array.isArray(input.targets) ||
      input.targets.length < 1 ||
      input.targets.length > 64 ||
      input.targets.filter((t) => t.purpose === 'integration').length !== 1 ||
      new Set(input.targets.map((t) => t.workspaceId)).size !== input.targets.length ||
      new Set(input.targets.filter((t) => t.purpose !== 'integration').map((t) => t.workerId))
        .size !==
        input.targets.length - 1 ||
      input.targets.some(
        (t) =>
          !id(t.workspaceId) ||
          (t.purpose === 'integration'
            ? !exact(t, 'purpose,workspaceId')
            : !['coding', 'validation'].includes(t.purpose) ||
              !id(t.workerId) ||
              !exact(t, 'purpose,workerId,workspaceId')),
      )
    )
      return Promise.reject(Error('invalid_workspace_registration'));
    const request = structuredClone(input);
    const run = this.tail.catch(() => undefined).then(() => this.prepare(request));
    this.tail = run.catch(() => undefined);
    return run;
  }

  registerCodingWave(input: WaveRequest): Promise<WorkspaceRefV1[]> {
    localRecordHash(input);
    if (
      !exact(
        input,
        'actionId,attempt,expectedRevision,grantId,projectId,rootId,sourceWorkspaceId,targets,taskId,version,waveId',
      ) ||
      ![
        input.projectId,
        input.taskId,
        input.actionId,
        input.rootId,
        input.grantId,
        input.waveId,
        input.sourceWorkspaceId,
      ].every(id) ||
      input.actionId.length > 120 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      !isWorkspaceVersionV1(input.version) ||
      input.version.kind !== 'git' ||
      !Array.isArray(input.targets) ||
      input.targets.length < 1 ||
      input.targets.length > 64 ||
      new Set(input.targets.map((t) => t.workspaceId)).size !== input.targets.length ||
      input.targets.some(
        (t) =>
          !exact(t, 'purpose,workerId,workspaceId') ||
          t.purpose !== 'coding' ||
          !id(t.workspaceId) ||
          !id(t.workerId),
      ) ||
      new Set(input.targets.map((t) => (t.purpose === 'coding' ? t.workerId : ''))).size !==
        input.targets.length
    )
      return Promise.reject(Error('invalid_workspace_registration'));
    const request = structuredClone(input);
    const run = this.tail.catch(() => undefined).then(() => this.prepare(request));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Trusted next-wave integration target; the accepted validation tree supplies its base. */
  registerIntegrationWave(input: WaveRequest): Promise<WorkspaceRefV1[]> {
    localRecordHash(input);
    if (
      !exact(
        input,
        'actionId,attempt,expectedRevision,grantId,projectId,rootId,sourceWorkspaceId,targets,taskId,version,waveId',
      ) ||
      ![
        input.projectId,
        input.taskId,
        input.actionId,
        input.rootId,
        input.grantId,
        input.waveId,
        input.sourceWorkspaceId,
      ].every(id) ||
      input.actionId.length > 120 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      !isWorkspaceVersionV1(input.version) ||
      input.version.kind !== 'git' ||
      !Array.isArray(input.targets) ||
      input.targets.length !== 1 ||
      !input.targets[0] ||
      !exact(input.targets[0], 'purpose,workspaceId') ||
      input.targets[0]?.purpose !== 'integration' ||
      !id(input.targets[0].workspaceId) ||
      input.sourceWorkspaceId === input.targets[0].workspaceId
    )
      return Promise.reject(Error('invalid_workspace_registration'));
    const request = structuredClone(input);
    const run = this.tail.catch(() => undefined).then(() => this.prepare(request));
    this.tail = run.catch(() => undefined);
    return run;
  }

  registerValidation(input: ValidationGitRegistrationRequest): Promise<WorkspaceRefV1[]> {
    localRecordHash(input);
    if (
      !this.options.verifyValidationPreparation ||
      !this.options.verifyValidationSlot ||
      !this.options.verifyValidationRegistered ||
      !exact(
        input,
        'actionId,attempt,dispatchId,expectedRevision,grantId,integrationId,planHash,projectId,rootId,sourceWorkspaceId,targets,taskId,version,waveId',
      ) ||
      ![
        input.projectId,
        input.taskId,
        input.actionId,
        input.rootId,
        input.grantId,
        input.waveId,
        input.integrationId,
        input.dispatchId,
        input.sourceWorkspaceId,
      ].every(id) ||
      input.actionId.length > 120 ||
      !/^[a-f0-9]{64}$/.test(input.planHash) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 0 ||
      !isWorkspaceVersionV1(input.version) ||
      input.version.kind !== 'git' ||
      !Array.isArray(input.targets) ||
      input.targets.length !== 1 ||
      !exact(input.targets[0], 'purpose,workerId,workspaceId') ||
      input.targets[0]?.purpose !== 'validation' ||
      !id(input.targets[0].workspaceId) ||
      !id(input.targets[0].workerId) ||
      input.targets[0].workerId !== `worker:${input.dispatchId}:0` ||
      input.sourceWorkspaceId === input.targets[0].workspaceId
    )
      return Promise.reject(Error('invalid_workspace_registration'));
    const request = structuredClone(input);
    const run = this.tail.catch(() => undefined).then(() => this.prepare(request));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async prepare(
    request: Request | WaveRequest | ValidationGitRegistrationRequest,
  ): Promise<WorkspaceRefV1[]> {
    const validationRequest = 'planHash' in request ? request : undefined;
    const validationCommit =
      validationRequest?.version.kind === 'git' ? validationRequest.version.commit : undefined;
    if (validationRequest && !validationCommit) throw Error('invalid_workspace_registration');
    const waveRequest =
      'waveId' in request && !validationRequest ? (request as WaveRequest) : undefined;
    const integrationWaveRequest =
      waveRequest?.targets.length === 1 && waveRequest.targets[0]?.purpose === 'integration'
        ? waveRequest
        : undefined;
    const { control, roots, objects, versions, verifyGrant } = this.options;
    const key = localRecordHash({
      kind: validationRequest
        ? 'validation-git-registration'
        : waveRequest
          ? integrationWaveRequest
            ? 'integration-git-batch'
            : 'coding-git-batch'
          : 'initial-git-batch',
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
    });
    const inputHash = localRecordHash({ request, gitOptions: this.git });
    const preparedKey = localRecordHash({ key, stage: 'binding' });
    const previous = await objects.getReference(key);
    if (previous) {
      if (previous !== inputHash) throw Error('operation_conflict');
      if (validationRequest) {
        const stored = await objects.getReference(preparedKey);
        const snapshot = await control.snapshot();
        const operation = snapshot.operations.find((o) => o.actionId === request.actionId);
        if (
          !stored ||
          !operation ||
          !isLocalBindingOperation(operation) ||
          operation.stage !== 'committed'
        )
          throw Error('validation_registration_recovery_required');
        const binding = (await objects.get(stored)) as LocalBindingRequest;
        if (operation.inputHash !== stored || localRecordHash(binding) !== stored)
          throw Error('operation_conflict');
        const state = await control.assertClosed(request);
        await this.options.verifyValidationRegistered?.(
          validationRequest,
          state,
          snapshot,
          binding,
        );
        await verifyGrant(request, request.grantId);
        const sourceRoot = snapshot.roots.find(
          (r) => r.rootId === request.rootId && r.projectId === request.projectId,
        );
        const sourceWorkspace = snapshot.workspaces.find(
          (w) => w.workspaceId === validationRequest.sourceWorkspaceId,
        );
        const sourceRecord = snapshot.linkedRoots?.find(
          (r) => r.workspaceId === validationRequest.sourceWorkspaceId,
        );
        const grant = snapshot.grants.find(
          (g) => g.grantId === request.grantId && g.projectId === request.projectId,
        );
        const workspace = snapshot.workspaces.find(
          (w) => w.workspaceId === validationRequest.targets[0]?.workspaceId,
        );
        const record = snapshot.linkedRoots?.find(
          (r) => r.workspaceId === validationRequest.targets[0]?.workspaceId,
        );
        if (
          !sourceRoot ||
          !grant ||
          sourceWorkspace?.mode !== 'linked-worktree' ||
          !sourceRecord ||
          workspace?.mode !== 'linked-worktree' ||
          !record ||
          validationRequest.version.kind !== 'git' ||
          workspace.baseCommit !== validationRequest.version.commit
        )
          throw Error('workspace_validation_source_mismatch');
        const authorize = async () => {
          await verifyGrant(request, request.grantId);
          if (
            localRecordHash(await control.assertClosed(request)) !== localRecordHash(state) ||
            localRecordHash(await control.snapshot()) !== localRecordHash(snapshot)
          )
            throw Error('workspace_assignment_mismatch');
          return true;
        };
        await new LocalGitVersionStore(objects, versions).verify(
          validationRequest.version,
          {
            projectId: request.projectId,
            taskId: request.taskId,
            rootId: sourceRoot.rootId,
            policyHash: grant.policyHash,
          },
          {
            ...this.git,
            projectId: request.projectId,
            taskId: request.taskId,
            root: sourceRoot.path,
            sourceRoot,
            workspace: sourceWorkspace,
            record: sourceRecord,
            expectedHead: validationRequest.version.commit,
            actionId: sourceRecord.initialization.actionId,
            creationActionId: sourceRecord.creation.actionId,
            bindingReceiptId: sourceRecord.bindingReceiptId,
            authorize,
          },
        );
        await verifyLocalLinkedRoot({
          ...this.git,
          projectId: request.projectId,
          taskId: request.taskId,
          root: sourceRoot.path,
          sourceRoot,
          workspace,
          record,
          expectedHead: validationRequest.version.commit,
          actionId: record.initialization.actionId,
          creationActionId: record.creation.actionId,
          bindingReceiptId: `binding:${request.actionId}`,
          authorize,
        });
        await this.options.verifyValidationSlot?.(validationRequest);
        await authorize();
        return [structuredClone(workspace)];
      }
      const stored = await objects.getReference(preparedKey);
      const operation = (await control.snapshot()).operations.find(
        (o) => o.actionId === request.actionId,
      );
      // Replaying partial creation would erase the distinction between preparation and recovery.
      if (!stored || !operation || !isLocalBindingOperation(operation))
        throw Error('local_git_recovery_required');
      const binding = (await objects.get(stored)) as LocalBindingRequest;
      if (operation.inputHash !== localRecordHash(binding)) throw Error('operation_conflict');
      await control.commitBinding(binding);
      await verifyGrant(request, request.grantId);
      const snapshot = await control.snapshot();
      const state = await control.assertClosed(request);
      const authorize = async () => {
        await verifyGrant(request, request.grantId);
        const current = await control.assertClosed(request);
        if (
          (await control.snapshot()).revision !== snapshot.revision ||
          localRecordHash(current) !== localRecordHash(state)
        )
          throw Error('workspace_assignment_mismatch');
        return true;
      };
      const sourceRoot = snapshot.roots.find(
        (r) => r.rootId === request.rootId && r.projectId === request.projectId,
      );
      if (!sourceRoot) throw Error('authorization_closed');
      const result: WorkspaceRefV1[] = [];
      for (const target of request.targets) {
        const workspace = snapshot.workspaces.find(
          (w) =>
            w.workspaceId === target.workspaceId &&
            w.projectId === request.projectId &&
            w.taskId === request.taskId,
        );
        const record = snapshot.linkedRoots?.find((r) => r.workspaceId === target.workspaceId);
        if (workspace?.mode !== 'linked-worktree' || !record)
          throw Error('workspace_binding_incomplete');
        // Registration fixes physical identity; later trusted commits advance the
        // canonical HEAD. Never adopt the live Git HEAD merely to make replay pass.
        const candidates = [
          ...state.workers.map((worker) => worker.worktree),
          state.integration?.integrationWorktree,
          state.parallelExecution?.activeWave?.validation?.worktree,
        ];
        if (candidates.some((ref) => ref === record.path))
          throw Error('workspace_assignment_mismatch');
        const refs = candidates.filter(
          (ref): ref is WorktreeRef =>
            typeof ref === 'object' && ref !== null && ref.path === record.path,
        );
        if (
          refs.some(
            (ref) =>
              !isWorktreeRef(ref) ||
              ref.branch !== workspace.branch ||
              ref.baseCommit !== workspace.baseCommit,
          )
        )
          throw Error('workspace_assignment_mismatch');
        const heads = new Set(refs.map((ref) => ref.headCommit ?? ref.baseCommit));
        if (heads.size > 1) throw Error('workspace_assignment_mismatch');
        await verifyLocalLinkedRoot({
          ...this.git,
          projectId: request.projectId,
          taskId: request.taskId,
          root: sourceRoot.path,
          sourceRoot,
          workspace,
          record,
          expectedHead: [...heads][0] ?? workspace.baseCommit,
          actionId: record.initialization.actionId,
          creationActionId: record.creation.actionId,
          bindingReceiptId: record.bindingReceiptId,
          authorize,
        });
        result.push(workspace);
      }
      await authorize();
      return result;
    }
    const snapshot = await control.snapshot();
    if (snapshot.revision !== request.expectedRevision) throw Error('registry_revision_conflict');
    if (snapshot.operations.some((o) => o.actionId === request.actionId))
      throw Error('operation_conflict');
    const state = await control.assertClosed(request);
    // A proven replay above reconciles only its exact immutable operation.
    // Fresh registration must pass the barrier before any new Git effects;
    // ordinary admission remains closed while another operation is prepared.
    if (state.localExecution)
      for (const workspace of state.localExecution.workspaces)
        assertLocalRangeAdmission(snapshot, workspace, state.localExecution.workspaces);
    if ((await control.snapshot()).revision !== snapshot.revision)
      throw Error('registry_revision_conflict');
    const local = state.localExecution;
    const root = snapshot.roots.find(
      (r) => r.rootId === request.rootId && r.projectId === request.projectId,
    );
    const grant = snapshot.grants.find(
      (g) =>
        g.grantId === request.grantId &&
        g.rootId === request.rootId &&
        g.projectId === request.projectId,
    );
    if (
      !root ||
      !grant ||
      grant.status !== 'active' ||
      !['read', 'edit'].every((a) => grant.actions.includes(a as 'read' | 'edit'))
    )
      throw Error('authorization_closed');
    if (
      !local ||
      Boolean(local.git) !== Boolean(waveRequest || validationRequest) ||
      !local.rootIds.includes(root.rootId)
    )
      throw Error('workspace_assignment_mismatch');
    if (
      state.phase === 'done' ||
      state.humanGate ||
      state.workers.some((w) => w.status === 'running' || w.status === 'paused')
    )
      throw Error('workspace_busy');
    if (integrationWaveRequest) assertIntegrationWave(state, integrationWaveRequest);
    else if (waveRequest) assertCodingWave(state, waveRequest);
    if (validationRequest) {
      const worker = state.workers.find(
        (w) => w.workerId === validationRequest.targets[0]?.workerId,
      );
      const validation = state.parallelExecution?.activeWave?.validation;
      if (
        state.phase !== 'testing' ||
        state.nextRole !== 'TESTER' ||
        state.integration?.status !== 'done' ||
        state.integration.integrationId !== validationRequest.integrationId ||
        state.integration.resultCommit !== validationCommit ||
        state.parallelExecution?.activeWave?.waveId !== validationRequest.waveId ||
        state.parallelExecution.activeWave.attempt !== validationRequest.attempt ||
        validation?.dispatchId !== validationRequest.dispatchId ||
        validation.workerId !== worker?.workerId ||
        validation.inputCommit !== validationCommit ||
        worker?.subtaskId !== undefined ||
        worker?.role !== 'TESTER' ||
        worker.status !== 'pending'
      )
        throw Error('workspace_validation_source_mismatch');
      await this.options.verifyValidationPreparation?.(validationRequest, state);
    }
    // Initial batches do not implement direct-to-linked handoff. Never release an
    // existing claim here; that transition must persist its new binding first.
    if (
      snapshot.claims.some(
        (c) =>
          c.status !== 'released' &&
          snapshot.workspaces.some(
            (w) =>
              w.workspaceId === c.workspaceId &&
              w.rootId === root.rootId &&
              (!(waveRequest || validationRequest) || w.mode === 'direct'),
          ),
      )
    )
      throw Error('workspace_busy');
    for (const target of request.targets) {
      if (snapshot.workspaces.some((w) => w.workspaceId === target.workspaceId))
        throw Error('workspace_assignment_mismatch');
      if (target.purpose === 'integration') continue;
      const worker = state.workers.find((w) => w.workerId === target.workerId);
      const subtask = state.subtasks.find((s) => s.id === worker?.subtaskId);
      if (
        worker?.executor !== 'harness' ||
        worker.status !== 'pending' ||
        worker.worktree !== undefined ||
        worker.role !== (target.purpose === 'coding' ? 'CODER' : 'TESTER') ||
        local.bindings.some((b) => b.workerId === worker.workerId) ||
        (worker.subtaskId !== undefined &&
          (!subtask ||
            !['todo', 'in_progress'].includes(subtask.status) ||
            !subtask.dependsOn.every((id) =>
              state.subtasks.some((s) => s.id === id && s.status === 'done'),
            ))) ||
        (target.purpose === 'coding' && !subtask)
      )
        throw Error('workspace_assignment_mismatch');
    }
    await verifyGrant(request, grant.grantId);
    const initialization = snapshot.operations.find(
      (o) => !isLocalBindingOperation(o) && o.rootId === root.rootId && o.grantId === grant.grantId,
    );
    if (
      !initialization ||
      isLocalBindingOperation(initialization) ||
      initialization.stage !== 'committed'
    )
      throw Error('workspace_root_not_initialized');
    await roots.initialize({
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: initialization.actionId,
      rootId: root.rootId,
      grantId: grant.grantId,
      expectedRevision: initialization.preparedRevision - 1,
    });
    const authorize = async () => {
      await verifyGrant(request, grant.grantId);
      const current = await control.assertClosed(request);
      if (
        (await control.snapshot()).revision !== snapshot.revision ||
        localRecordHash(current) !== localRecordHash(state)
      )
        throw Error('workspace_assignment_mismatch');
      return true;
    };
    const scope = {
      projectId: request.projectId,
      taskId: request.taskId,
      rootId: root.rootId,
      policyHash: grant.policyHash,
    };
    let sourceCommit: string | undefined;
    const verifySource = async () => {
      if (validationRequest) {
        if (!validationCommit) throw Error('invalid_workspace_registration');
        const workspace = local.workspaces.find(
          (w) => w.workspaceId === validationRequest.sourceWorkspaceId,
        );
        const record = snapshot.linkedRoots?.find((r) => r.workspaceId === workspace?.workspaceId);
        const mapping = local.git?.worktrees.find((m) => m.workspaceId === workspace?.workspaceId);
        const originalClaims = snapshot.claims.filter(
          (c) =>
            c.workspaceId === workspace?.workspaceId &&
            c.projectId === request.projectId &&
            c.taskId === request.taskId,
        );
        if (
          workspace?.mode !== 'linked-worktree' ||
          workspace.purpose !== 'integration' ||
          workspace.rootId !== root.rootId ||
          workspace.grantId !== grant.grantId ||
          !record ||
          !mapping ||
          record.path !== mapping.path ||
          record.bindingReceiptId !== mapping.receiptId ||
          originalClaims.length !== 1 ||
          originalClaims[0]?.status !== 'released' ||
          state.integration?.integrationWorktree.path !== record.path ||
          state.integration.integrationWorktree.branch !== workspace.branch ||
          state.integration.integrationWorktree.headCommit !== validationCommit
        )
          throw Error('workspace_validation_source_mismatch');
        assertValidationSourceWave(state, workspace.workspaceId, workspace.baseCommit);
        await new LocalGitVersionStore(objects, versions).verify(validationRequest.version, scope, {
          ...this.git,
          projectId: request.projectId,
          taskId: request.taskId,
          root: root.path,
          sourceRoot: root,
          workspace,
          record,
          expectedHead: validationCommit,
          actionId: record.initialization.actionId,
          creationActionId: record.creation.actionId,
          bindingReceiptId: record.bindingReceiptId,
          authorize,
        });
        await authorize();
        sourceCommit = validationCommit;
        return;
      }
      if (!waveRequest) {
        await versions.verify(request.version, scope, localRootBinding(root), authorize);
        return;
      }
      const workspace = local.workspaces.find(
        (w) => w.workspaceId === waveRequest.sourceWorkspaceId,
      );
      const record = snapshot.linkedRoots?.find((r) => r.workspaceId === workspace?.workspaceId);
      const mapping = local.git?.worktrees.find((m) => m.workspaceId === workspace?.workspaceId);
      const wave = state.parallelExecution?.activeWave;
      if (
        workspace?.mode !== 'linked-worktree' ||
        !record ||
        !mapping ||
        !wave ||
        workspace.rootId !== root.rootId ||
        workspace.grantId !== grant.grantId ||
        workspace.branch !== wave.base.branch ||
        waveRequest.version.kind !== 'git' ||
        waveRequest.version.commit !== wave.base.commit ||
        record.path !== mapping.path ||
        record.bindingReceiptId !== mapping.receiptId
      )
        throw Error('workspace_wave_source_mismatch');
      const lineage = readCodingWorkerLineage(state);
      const acceptedId = lineage.sourceReceiptId;
      if (acceptedId === undefined) {
        if (
          workspace.workspaceId !== local.git?.initialWorkspaceId ||
          workspace.purpose !== 'integration' ||
          workspace.baseCommit !== wave.base.commit
        )
          throw Error('workspace_wave_source_mismatch');
      } else {
        const accepted = validationReceipt(state, acceptedId);
        if (
          workspace.purpose !== 'validation' ||
          accepted.worktree.path !== record.path ||
          accepted.worktree.branch !== workspace.branch ||
          accepted.worktree.headCommit !== wave.base.commit
        )
          throw Error('workspace_wave_source_mismatch');
        if (!this.options.verifyAcceptedVersion)
          throw Error('local_git_validation_verifier_required');
        await this.options.verifyAcceptedVersion(
          structuredClone(state),
          structuredClone(accepted),
          structuredClone(request.version),
        );
      }
      const currentSource = {
        ...this.git,
        projectId: request.projectId,
        taskId: request.taskId,
        root: root.path,
        sourceRoot: root,
        workspace,
        record,
        expectedHead: wave.base.commit,
        actionId: record.initialization.actionId,
        creationActionId: record.creation.actionId,
        bindingReceiptId: record.bindingReceiptId,
        authorize,
      };
      if (lineage.conflictReworks.at(-1)?.attempt === lineage.attempt) {
        if (!this.options.readConflictBase) throw Error('local_git_conflict_verifier_required');
        const original = await this.options.readConflictBase(state);
        if (
          original.sourceWorkspaceId !== workspace.workspaceId ||
          localRecordHash(original.version) !== localRecordHash(request.version)
        )
          throw Error('workspace_wave_source_mismatch');
      } else {
        await new LocalGitVersionStore(objects, versions).verify(
          request.version,
          scope,
          currentSource,
        );
      }
      await authorize();
      sourceCommit = wave.base.commit;
    };
    await verifySource();
    const manifest = await versions.read(request.version, scope);
    const directories = manifest.directories.map((directory) => directory.path).filter(Boolean);
    const files: { path: string; content: Buffer; executable: boolean }[] = [];
    for (const file of manifest.files)
      files.push({
        path: file.path,
        content: await objects.getBytes(file.contentHash),
        executable: file.version.executable,
      });
    await objects.put({ request, gitOptions: this.git });
    await objects.bindReference(key, inputHash);
    const childAction = (kind: string, workspaceId?: string) =>
      `git-${localRecordHash({ key, kind, workspaceId: workspaceId ?? null })}`;
    const session = {
      ...this.git,
      projectId: request.projectId,
      taskId: request.taskId,
      root: root.path,
      authorize,
    };
    const baseCommit =
      sourceCommit ??
      (
        await createLocalGitBaseline({
          ...session,
          actionId: childAction('baseline'),
          files,
        })
      ).commit;
    const workspaces: WorkspaceRefV1[] = [],
      physical: LocalLinkedRootRecord[] = [];
    const next = structuredClone(local),
      claims = structuredClone(snapshot.claims);
    let epoch = Math.max(0, ...claims.map((c) => c.writerEpoch));
    const receiptId = `binding:${request.actionId}`;
    for (const target of request.targets) {
      const creation = await createLocalGitWorktree({
        ...session,
        actionId: childAction('create', target.workspaceId),
        workspaceId: target.workspaceId,
        baseCommit,
        files,
        directories,
      });
      const workspace: WorkspaceRefV1 = {
        schemaVersion: 'workspace-v1',
        projectId: request.projectId,
        taskId: request.taskId,
        workspaceId: target.workspaceId,
        rootId: root.rootId,
        grantId: grant.grantId,
        purpose: target.purpose,
        mode: 'linked-worktree',
        branch: creation.branch,
        baseCommit: creation.baseCommit,
        commonDirId: `common:${localRecordHash({ path: creation.commonDir, identity: creation.commonDirIdentity })}`,
      };
      const record = await initializeLocalLinkedRoot({
        ...session,
        actionId: childAction('initialize', target.workspaceId),
        creationActionId: creation.actionId,
        bindingReceiptId: receiptId,
        sourceRoot: root,
        workspace,
      });
      workspaces.push(workspace);
      physical.push(record);
      next.workspaces.push(workspace);
      if (target.purpose !== 'integration') {
        const worker = state.workers.find((w) => w.workerId === target.workerId);
        if (!worker || !Number.isSafeInteger(++epoch)) throw Error('workspace_epoch_exhausted');
        next.bindings.push({
          workerId: target.workerId,
          workspaceId: target.workspaceId,
          receiptId,
          ...(worker.subtaskId === undefined ? {} : { subtaskId: worker.subtaskId }),
        });
        claims.push({
          claimId: `claim:${localRecordHash({ key, workerId: target.workerId })}`,
          projectId: request.projectId,
          taskId: request.taskId,
          workspaceId: target.workspaceId,
          workerId: target.workerId,
          writerEpoch: epoch,
          createdActionId: request.actionId,
          status: 'active',
          closureReceiptId: null,
        });
      }
    }
    const initial = request.targets.find((t) => t.purpose === 'integration');
    if ((waveRequest || validationRequest) && next.git) {
      next.git.worktrees.push(
        ...physical.map((r) => ({ workspaceId: r.workspaceId, path: r.path, receiptId })),
      );
    } else if (initial)
      next.git = {
        version: 1,
        initialWorkspaceId: initial.workspaceId,
        worktrees: physical.map((r) => ({ workspaceId: r.workspaceId, path: r.path, receiptId })),
      };
    else throw Error('invalid_workspace_registration');
    await verifySource();
    const binding: LocalBindingRequest = {
      projectId: request.projectId,
      taskId: request.taskId,
      actionId: request.actionId,
      sourceMessageId: grant.leaderMessageId,
      expectedRevision: snapshot.revision,
      nextLocalExecution: next,
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        workspaces: [...snapshot.workspaces, ...workspaces],
        claims,
        linkedRoots: [...(snapshot.linkedRoots ?? []), ...physical],
      },
    };
    await objects.bindReference(preparedKey, await objects.put(binding));
    if (validationRequest) await this.options.verifyValidationSlot?.(validationRequest);
    await authorize();
    await control.commitBinding(binding);
    const committedState = await control.assertClosed(request);
    if (validationRequest) {
      if (!validationCommit) throw Error('invalid_workspace_registration');
      const committedRegistry = await control.snapshot();
      const sourceWorkspace = committedRegistry.workspaces.find(
        (w) => w.workspaceId === validationRequest.sourceWorkspaceId,
      );
      const sourceRecord = committedRegistry.linkedRoots?.find(
        (r) => r.workspaceId === validationRequest.sourceWorkspaceId,
      );
      const targetWorkspace = committedRegistry.workspaces.find(
        (w) => w.workspaceId === validationRequest.targets[0]?.workspaceId,
      );
      const targetRecord = committedRegistry.linkedRoots?.find(
        (r) => r.workspaceId === validationRequest.targets[0]?.workspaceId,
      );
      if (
        sourceWorkspace?.mode !== 'linked-worktree' ||
        sourceWorkspace.purpose !== 'integration' ||
        !sourceRecord ||
        targetWorkspace?.mode !== 'linked-worktree' ||
        targetWorkspace.purpose !== 'validation' ||
        !targetRecord ||
        targetWorkspace.baseCommit !== validationCommit ||
        targetRecord.bindingReceiptId !== receiptId ||
        !committedState.localExecution?.bindings.some(
          (binding) =>
            binding.workerId === validationRequest.targets[0]?.workerId &&
            binding.workspaceId === targetWorkspace.workspaceId &&
            binding.receiptId === receiptId,
        ) ||
        committedState.integration?.resultCommit !== validationCommit
      )
        throw Error('workspace_validation_source_mismatch');
      const authorizeAfter = async () => {
        await verifyGrant(request, grant.grantId);
        if (
          localRecordHash(await control.assertClosed(request)) !==
            localRecordHash(committedState) ||
          localRecordHash(await control.snapshot()) !== localRecordHash(committedRegistry)
        )
          throw Error('workspace_assignment_mismatch');
        return true;
      };
      await new LocalGitVersionStore(objects, versions).verify(validationRequest.version, scope, {
        ...this.git,
        projectId: request.projectId,
        taskId: request.taskId,
        root: root.path,
        sourceRoot: root,
        workspace: sourceWorkspace,
        record: sourceRecord,
        expectedHead: validationCommit,
        actionId: sourceRecord.initialization.actionId,
        creationActionId: sourceRecord.creation.actionId,
        bindingReceiptId: sourceRecord.bindingReceiptId,
        authorize: authorizeAfter,
      });
      await verifyLocalLinkedRoot({
        ...this.git,
        projectId: request.projectId,
        taskId: request.taskId,
        root: root.path,
        sourceRoot: root,
        workspace: targetWorkspace,
        record: targetRecord,
        expectedHead: validationCommit,
        actionId: targetRecord.initialization.actionId,
        creationActionId: targetRecord.creation.actionId,
        bindingReceiptId: receiptId,
        authorize: authorizeAfter,
      });
      await this.options.verifyValidationSlot?.(validationRequest);
      await authorizeAfter();
    }
    return workspaces;
  }
}

function assertCodingWave(state: AppState, request: WaveRequest): void {
  readCodingWorkerLineage(state);
  const execution = state.parallelExecution,
    wave = execution?.activeWave;
  if (
    state.phase !== 'coding' ||
    !wave ||
    wave.waveId !== request.waveId ||
    wave.attempt !== request.attempt ||
    wave.validation ||
    wave.coderWorkerIds.some(
      (id) =>
        !['pending', 'done'].includes(state.workers.find((w) => w.workerId === id)?.status ?? ''),
    )
  )
    throw Error('workspace_wave_mismatch');
  const pending = wave.coderWorkerIds.filter(
    (id) => state.workers.find((w) => w.workerId === id)?.status === 'pending',
  );
  const requested = request.targets.map((t) => (t.purpose === 'coding' ? t.workerId : ''));
  if (localRecordHash([...pending].sort()) !== localRecordHash([...requested].sort()))
    throw Error('workspace_wave_mismatch');
  for (const workerId of pending) {
    const worker = state.workers.find((w) => w.workerId === workerId);
    if (!worker || worker.subtaskId !== wave.subtaskIds[wave.coderWorkerIds.indexOf(workerId)])
      throw Error('workspace_wave_mismatch');
  }
}

function assertIntegrationWave(state: AppState, request: WaveRequest): void {
  const lineage = readCodingWorkerLineage(state);
  const wave = state.parallelExecution?.activeWave;
  if (
    state.phase !== 'coding' ||
    state.integration !== undefined ||
    (!lineage.sourceReceiptId && !lineage.conflictReworks.length) ||
    !wave ||
    wave.waveId !== request.waveId ||
    wave.attempt !== request.attempt ||
    wave.validation ||
    request.version.kind !== 'git' ||
    request.version.commit !== wave.base.commit ||
    wave.coderWorkerIds.some((workerId, index) => {
      const worker = state.workers.find((entry) => entry.workerId === workerId);
      const subtask = state.subtasks.find((entry) => entry.id === wave.subtaskIds[index]);
      return (
        worker?.status !== 'done' ||
        !isWorktreeRef(worker.worktree) ||
        !isWorktreeRef(subtask?.worktree) ||
        localRecordHash(worker.worktree) !== localRecordHash(subtask.worktree) ||
        worker.worktree.baseCommit !== wave.base.commit
      );
    })
  )
    throw Error('workspace_wave_mismatch');
}
