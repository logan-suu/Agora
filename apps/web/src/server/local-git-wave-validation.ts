/** Host-owned Git wave validation. Native command facts remain private; the
 * canonical wave_validation/v1 message binds them by artifact hash. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AppState,
  adoptedExecutionPlan,
  appendMutation,
  canonicalJson,
  currentApprovedReviewId,
  currentCompletionEvidence,
  currentReviewDispatch,
  deriveCompletionResolution,
  isParallelExecution,
  isReviewBinding,
  isWaveValidationReceipt,
  isWorkspaceVersionV1,
  isWorktreeRef,
  type Mutation,
  readCodingWorkerLineage,
  setMutation,
  type TestResults,
  validationReceipt,
  validationSourceReceipt,
  validationSubtaskIds,
  type WaveValidationReceipt,
  type WorkspaceVersionV1,
  type WorktreeRef,
} from '@agora/core-domain';
import type {
  WorkspaceValidationEvidencePort,
  WorkspaceWorkerSession,
} from '@agora/runtime-sandbox';
import type { LocalWorkspaceSessions } from '../../../../packages/runtime/sandbox/src/local-workspace-sessions';
import {
  localGitValidationCommand,
  parseLocalGitValidationResult,
} from './local-validation-command';
import { controlFingerprint } from './wave-validation';

type EvidencePort = Pick<WorkspaceValidationEvidencePort, 'verifyCommand'> & {
  readCompletedWorktree(scope: {
    projectId: string;
    taskId: string;
    workerId: string;
  }): Promise<{ workspaceId: string; worktree: WorktreeRef }>;
};
type FixedSession = WorkspaceWorkerSession;
type Identity = {
  projectId: string;
  taskId: string;
  planId: string;
  waveId: string;
  attempt: number;
  dispatchId: string;
  workerId: string;
  integrationId: string;
  inputCommit: string;
  controlFingerprint: string;
};
type NativeEvidence = Identity & {
  schemaVersion: 'local-git-wave-evidence-v1';
  workspaceId: string;
  worktree: WorktreeRef;
  version: WorkspaceVersionV1;
  commandReceiptId: string;
  commandInputHash: string;
  policyHash: string;
  toolchainHash: string;
  dependenciesHash: string;
  results: TestResults;
};
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const strictResults = (value: TestResults): TestResults => ({
  passed: value.passed,
  total: value.total,
  failed: value.failed,
  failures: value.failures,
  ...(value.coverage === undefined ? {} : { coverage: value.coverage }),
});
const artifactPath = (dispatchId: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(dispatchId))
    throw Error('invalid_wave_validation_dispatch');
  return `validation/${dispatchId}.json`;
};

export class LocalGitWaveValidationService {
  constructor(
    private readonly evidence: EvidencePort,
    private readonly load: () => Promise<AppState>,
    private readonly artifactsRoot: string,
  ) {}

  private assignment(state: AppState, workerId: string, session: FixedSession) {
    const execution = state.parallelExecution;
    if (!isParallelExecution(execution)) throw Error('invalid_wave_validation_assignment');
    const wave = execution.activeWave;
    const validation = wave?.validation;
    const worker = state.workers.find((candidate) => candidate.workerId === workerId);
    const binding = state.localExecution?.bindings.find(
      (candidate) => candidate.workerId === workerId,
    );
    const worktree = worker?.worktree;
    const mapping = state.localExecution?.git?.worktrees.find(
      (candidate) => candidate.workspaceId === session.workspace.workspaceId,
    );
    if (
      !wave ||
      !validation ||
      state.phase !== 'testing' ||
      validation.workerId !== workerId ||
      worker?.role !== 'TESTER' ||
      worker.status !== 'running' ||
      !isWorktreeRef(worktree) ||
      !worktree.headCommit ||
      !session.inspectCommittedGit ||
      !session.runFixedGitValidation ||
      session.workspace.mode !== 'linked-worktree' ||
      session.workspace.purpose !== 'validation' ||
      binding?.workspaceId !== session.workspace.workspaceId ||
      worktree.path !== mapping?.path ||
      worktree.branch !== session.workspace.branch ||
      worktree.baseCommit !== session.workspace.baseCommit ||
      worktree.baseCommit !== validation.inputCommit ||
      (validation.worktree !== undefined &&
        (validation.worktree.path !== worktree.path ||
          validation.worktree.branch !== worktree.branch ||
          validation.worktree.baseCommit !== worktree.baseCommit))
    )
      throw Error('invalid_wave_validation_assignment');
    const integration = state.integration;
    const source = validationSourceReceipt(state, validation.dispatchId);
    if (
      integration?.status !== 'done' ||
      integration.integrationId !== validation.integrationId ||
      (source === undefined
        ? integration.resultCommit !== validation.inputCommit
        : source.receipt.worktree.headCommit !== validation.inputCommit) ||
      worktree.path === integration.integrationWorktree.path
    )
      throw Error('invalid_wave_validation_source');
    const identity: Identity = {
      projectId: state.projectId,
      taskId: state.taskId,
      planId: execution.planId,
      waveId: wave.waveId,
      attempt: wave.attempt,
      dispatchId: validation.dispatchId,
      workerId,
      integrationId: validation.integrationId,
      inputCommit: validation.inputCommit,
      controlFingerprint: controlFingerprint(state),
    };
    artifactPath(identity.dispatchId);
    return { execution, wave, validation, worker, worktree, identity, source };
  }

  private async readEvidence(
    identity: Identity,
  ): Promise<{ body: string; value: NativeEvidence } | undefined> {
    let body: string;
    try {
      body = await readFile(join(this.artifactsRoot, artifactPath(identity.dispatchId)), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const value: NativeEvidence = JSON.parse(body);
      if (
        value.schemaVersion !== 'local-git-wave-evidence-v1' ||
        Object.entries(identity).some(
          ([key, expected]) => value[key as keyof NativeEvidence] !== expected,
        ) ||
        !isWorkspaceVersionV1(value.version) ||
        value.version.kind !== 'git' ||
        value.version.commit !== value.worktree?.headCommit ||
        !/^run:[a-f0-9]{64}$/.test(value.commandReceiptId) ||
        !/^[a-f0-9]{64}$/.test(value.commandInputHash) ||
        !/^[a-f0-9]{64}$/.test(value.policyHash) ||
        !/^[a-f0-9]{64}$/.test(value.toolchainHash) ||
        !/^[a-f0-9]{64}$/.test(value.dependenciesHash) ||
        typeof value.workspaceId !== 'string' ||
        !equal(
          Object.keys(value).sort(),
          [
            ...Object.keys(identity),
            'schemaVersion',
            'workspaceId',
            'worktree',
            'version',
            'commandReceiptId',
            'commandInputHash',
            'policyHash',
            'toolchainHash',
            'dependenciesHash',
            'results',
          ].sort(),
        )
      )
        throw Error('invalid_wave_validation_evidence');
      return { body, value };
    } catch (error) {
      throw Error('invalid_wave_validation_evidence', { cause: error });
    }
  }

  private async verifyNative(value: NativeEvidence): Promise<void> {
    const observed = await this.evidence.verifyCommand(
      { projectId: value.projectId, taskId: value.taskId, workspaceId: value.workspaceId },
      value.commandReceiptId,
    );
    const run = observed.command;
    const parsed = parseLocalGitValidationResult(run, value.version);
    if (
      run.receiptId !== value.commandReceiptId ||
      run.workerId !== value.workerId ||
      run.workspaceId !== value.workspaceId ||
      run.inputHash !== value.commandInputHash ||
      run.policyHash !== value.policyHash ||
      observed.toolchainHash !== value.toolchainHash ||
      observed.dependenciesHash !== value.dependenciesHash ||
      !equal(observed.request.inputVersion, value.version) ||
      !equal(strictResults(parsed), value.results)
    )
      throw Error('local_git_wave_execution_changed');
  }

  async complete(
    state: AppState,
    workerId: string,
    session: FixedSession,
  ): Promise<readonly Mutation[]> {
    const assignment = this.assignment(state, workerId, session);
    const { execution, wave, validation, worktree, identity, source } = assignment;
    const receiptId = `wave-validation:${identity.dispatchId}`;
    if (validation.receiptId !== undefined) {
      await this.verifyReceiptHead(state, receiptId);
      return [];
    }
    if (source) await this.verifyReceiptHead(state, source.receiptId);
    const inspect = session.inspectCommittedGit;
    const runFixed = session.runFixedGitValidation;
    if (!inspect || !runFixed) throw Error('local_git_validation_unavailable');
    const inspection = await inspect(`tool:${hash({ ...identity, kind: 'git-wave-inspection' })}`);
    if (inspection.version.kind !== 'git' || inspection.version.commit !== worktree.headCommit)
      throw Error('local_git_wave_version_changed');
    const request = localGitValidationCommand(inspection, worktree.headCommit);
    const relativePath = artifactPath(identity.dispatchId);
    const path = join(this.artifactsRoot, relativePath);
    let saved = await this.readEvidence(identity);
    if (saved === undefined) {
      const actionId = `tool:${hash({ ...identity, version: inspection.version, kind: 'git-wave-command' })}`;
      const run = await runFixed(actionId, request);
      const observed = await this.evidence.verifyCommand(
        { ...identity, workspaceId: session.workspace.workspaceId },
        run.receiptId,
      );
      if (!equal(observed.command, run) || !equal(observed.request, request))
        throw Error('local_git_wave_execution_changed');
      const results = strictResults(parseLocalGitValidationResult(run, inspection.version));
      const value: NativeEvidence = {
        schemaVersion: 'local-git-wave-evidence-v1',
        ...identity,
        workspaceId: session.workspace.workspaceId,
        worktree,
        version: inspection.version,
        commandReceiptId: run.receiptId,
        commandInputHash: run.inputHash,
        policyHash: run.policyHash,
        toolchainHash: observed.toolchainHash,
        dependenciesHash: observed.dependenciesHash,
        results,
      };
      const body = `${canonicalJson(value)}\n`;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      saved = { body, value };
    }
    if (
      !equal(saved.value.version, inspection.version) ||
      !equal(saved.value.worktree, worktree) ||
      saved.value.workspaceId !== session.workspace.workspaceId
    )
      throw Error('local_git_wave_evidence_changed');
    await this.verifyNative(saved.value);
    const observed = await this.evidence.verifyCommand(
      { ...identity, workspaceId: saved.value.workspaceId },
      saved.value.commandReceiptId,
    );
    const receipt: WaveValidationReceipt = {
      kind: 'wave_validation',
      version: 1,
      planId: identity.planId,
      waveId: identity.waveId,
      attempt: identity.attempt,
      dispatchId: identity.dispatchId,
      workerId,
      integrationId: identity.integrationId,
      inputCommit: identity.inputCommit,
      worktree,
      subtaskIds: validationSubtaskIds(state, wave),
      controlFingerprint: identity.controlFingerprint,
      results: saved.value.results,
      evidence: {
        path: relativePath,
        sha256: sha(saved.body),
        exitCode: observed.command.exitCode as number,
        timedOut: observed.command.timedOut,
      },
    };
    if (!isWaveValidationReceipt(receipt)) throw Error('invalid_wave_validation_receipt');
    const latest = await this.load();
    const latestWorker = latest.workers.find((candidate) => candidate.workerId === workerId);
    if (
      latest.projectId !== state.projectId ||
      latest.taskId !== state.taskId ||
      latest.phase !== 'testing' ||
      controlFingerprint(latest) !== identity.controlFingerprint ||
      !equal(latest.parallelExecution, state.parallelExecution) ||
      !equal(latest.integration, state.integration) ||
      latestWorker?.role !== 'TESTER' ||
      latestWorker.status !== 'running' ||
      !equal(latestWorker.worktree, worktree) ||
      !equal(latest.localExecution, state.localExecution)
    )
      throw Error('local_git_wave_control_changed');
    const mutations: Mutation[] = [
      appendMutation('messages', {
        msgId: receiptId,
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        payload: receipt,
        display: `Cumulative validation: ${receipt.results.total - receipt.results.failed}/${receipt.results.total} passed`,
        ts: Date.now(),
      }),
      setMutation('testResults', { ...receipt.results, workspaceVersion: inspection.version }),
      setMutation('parallelExecution', {
        ...execution,
        activeWave: {
          ...wave,
          validation: { ...validation, worktree, receiptId },
        },
      }),
    ];
    return mutations;
  }

  async verifyReceiptHead(state: AppState, receiptId: string): Promise<WorkspaceVersionV1> {
    const receipt = validationReceipt(state, receiptId);
    const identity: Identity = {
      projectId: state.projectId,
      taskId: state.taskId,
      planId: receipt.planId,
      waveId: receipt.waveId,
      attempt: receipt.attempt,
      dispatchId: receipt.dispatchId,
      workerId: receipt.workerId,
      integrationId: receipt.integrationId,
      inputCommit: receipt.inputCommit,
      controlFingerprint: receipt.controlFingerprint,
    };
    const saved = await this.readEvidence(identity);
    const sourceBinding = state.localExecution?.bindings.find(
      (candidate) => candidate.workerId === receipt.workerId,
    );
    if (
      !saved ||
      sourceBinding?.workspaceId !== saved.value.workspaceId ||
      sha(saved.body) !== receipt.evidence.sha256 ||
      receipt.evidence.path !== artifactPath(receipt.dispatchId) ||
      !equal(saved.value.worktree, receipt.worktree) ||
      !equal(saved.value.results, receipt.results)
    )
      throw Error('local_git_wave_evidence_changed');
    await this.verifyNative(saved.value);
    const observed = await this.evidence.verifyCommand(
      { ...identity, workspaceId: saved.value.workspaceId },
      saved.value.commandReceiptId,
    );
    if (
      observed.command.exitCode !== receipt.evidence.exitCode ||
      observed.command.timedOut !== receipt.evidence.timedOut
    )
      throw Error('local_git_wave_evidence_changed');
    const worker = state.workers.find((candidate) => candidate.workerId === receipt.workerId);
    if (worker?.status === 'done') {
      const completed = await this.evidence.readCompletedWorktree({
        projectId: state.projectId,
        taskId: state.taskId,
        workerId: receipt.workerId,
      });
      if (
        completed.workspaceId !== saved.value.workspaceId ||
        !equal(completed.worktree, receipt.worktree)
      )
        throw Error('local_git_wave_worktree_changed');
    } else if (!equal(worker?.worktree, receipt.worktree))
      throw Error('local_git_wave_worktree_changed');
    return structuredClone(saved.value.version);
  }

  /** Reprove the accepted source for later coding registration or integration reads. */
  async verifiedAcceptedVersion(
    state: AppState,
    receipt: WaveValidationReceipt,
    requested: WorkspaceVersionV1,
  ): Promise<void> {
    const acceptedId = state.parallelExecution?.acceptedReceiptId;
    const wave = state.parallelExecution?.activeWave;
    const validation = wave?.validation;
    const integration = state.integration;
    const dispatch = state.messages.find((message) => message.msgId === validation?.dispatchId);
    const provingCurrentValidation =
      state.phase === 'testing' &&
      wave !== undefined &&
      validation !== undefined &&
      integration?.status === 'done' &&
      integration.waveId === wave.waveId &&
      equal(integration.base, wave.base) &&
      integration.integrationId === validation.integrationId &&
      integration.resultCommit === validation.inputCommit &&
      integration.integrationWorktree.headCommit === validation.inputCommit &&
      dispatch?.fromRole === 'COORDINATOR' &&
      dispatch.type === 'announce' &&
      dispatch.channelId === 'main' &&
      dispatch.payload.kind === 'wave_validation_dispatch' &&
      dispatch.payload.planId === state.parallelExecution?.planId &&
      dispatch.payload.waveId === wave.waveId &&
      dispatch.payload.attempt === wave.attempt &&
      dispatch.payload.integrationId === validation.integrationId &&
      dispatch.payload.inputCommit === validation.inputCommit &&
      equal(dispatch.payload.subtaskIds, wave.subtaskIds) &&
      validation.workerId === `worker:${validation.dispatchId}:0` &&
      state.workers.some(
        (worker) =>
          worker.workerId === validation.workerId &&
          worker.role === 'TESTER' &&
          worker.subtaskId === undefined,
      );
    if (
      (!['coding', 'integrating'].includes(state.phase) && !provingCurrentValidation) ||
      !acceptedId ||
      !receipt.results.passed ||
      requested.kind !== 'git' ||
      requested.commit !== receipt.worktree.headCommit ||
      !equal(receipt, validationReceipt(state, acceptedId))
    )
      throw Error('local_git_accepted_source_changed');
    const lineage = readCodingWorkerLineage(state);
    if (lineage.acceptedReceiptId !== acceptedId) throw Error('local_git_accepted_source_changed');
    const verified = await this.verifyReceiptHead(state, acceptedId);
    if (!equal(verified, requested) || !equal(await this.load(), state))
      throw Error('local_git_accepted_source_changed');
  }

  /** Reprove a final accepted candidate without admitting or reviving a worker. */
  async verifiedDeliveryVersion(state: AppState): Promise<WorkspaceVersionV1> {
    const execution = state.parallelExecution;
    const dispatch = currentReviewDispatch(state);
    const binding = dispatch?.payload.reviewBinding;
    if (
      !isParallelExecution(execution) ||
      !state.localExecution?.git ||
      execution.activeWave !== undefined ||
      !isReviewBinding(binding) ||
      execution.acceptedReceiptId !== binding.validationReceiptId ||
      dispatch?.payload.kind !== 'parallel_review_dispatch' ||
      dispatch.payload.reason === 'repeated_test_failures' ||
      binding.planId !== execution.planId ||
      binding.controlFingerprint !== controlFingerprint(state) ||
      adoptedExecutionPlan(state).subtasks.some(
        (node) => state.subtasks.find((entry) => entry.id === node.id)?.status !== 'done',
      )
    )
      throw Error('local_git_delivery_source_changed');
    const receipt = validationReceipt(state, binding.validationReceiptId);
    const { workspaceVersion, ...results } = state.testResults ?? {};
    if (
      !receipt.results.passed ||
      receipt.planId !== binding.planId ||
      receipt.controlFingerprint !== binding.controlFingerprint ||
      receipt.worktree.headCommit !== binding.commit ||
      !equal(results, receipt.results) ||
      state.messages.findIndex((message) => message.msgId === binding.validationReceiptId) >=
        state.messages.indexOf(dispatch)
    )
      throw Error('local_git_delivery_source_changed');
    const version = await this.verifyReceiptHead(state, binding.validationReceiptId);
    if (
      version.kind !== 'git' ||
      version.commit !== binding.commit ||
      !equal(version, workspaceVersion) ||
      !equal(await this.load(), state)
    )
      throw Error('local_git_delivery_source_changed');
    return version;
  }

  async verifyCompletion(state: AppState) {
    if (!state.localExecution?.delivery) throw Error('local_delivery_goal_required');
    const binding = currentCompletionEvidence(state);
    if (!isReviewBinding(binding)) throw Error('local_git_completion_evidence_changed');
    const version = await this.verifiedDeliveryVersion(state);
    return { binding, version };
  }

  async archive(
    state: AppState,
    archive: Pick<
      LocalWorkspaceSessions,
      'recoverCompletion' | 'archiveGitCompletion' | 'releaseGitCompleted'
    >,
  ) {
    const scope = { projectId: state.projectId, taskId: state.taskId };
    await archive.recoverCompletion(scope);
    state = await this.load();
    if (state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    const approval = deriveCompletionResolution(state, currentApprovedReviewId(state));
    if (state.phase !== 'done' || approval?.option !== 'approve_completion' || !approval.resumed)
      throw Error('local_archive_requires_resumed_approval');
    const expected = await this.verifyCompletion(state);
    const receipt = validationReceipt(state, expected.binding.validationReceiptId);
    const source = state.localExecution?.bindings.find((b) => b.workerId === receipt.workerId);
    const verify = async (current: AppState) => (await this.verifyCompletion(current)).version;
    const artifact = await archive.archiveGitCompletion(scope, verify);
    if (
      !equal(artifact.workspaceVersion, expected.version) ||
      artifact.sourceWorkspaceId !== source?.workspaceId ||
      artifact.validationReceiptId !== expected.binding.validationReceiptId ||
      artifact.approvalActionId !== approval.actionId ||
      artifact.roundId !== undefined
    )
      throw Error('local_artifact_conflict');
    const latest = await this.load();
    if (latest.phase !== 'done' || !equal(await this.verifyCompletion(latest), expected))
      throw Error('local_git_completion_evidence_changed');
    await archive.releaseGitCompleted(scope, verify);
    return artifact;
  }

  /** Read-only candidate proof; opening a linked REVIEWER session is separate. */
  async verifiedReviewVersion(
    state: AppState,
    reviewerWorkerId: string,
  ): Promise<WorkspaceVersionV1> {
    const execution = state.parallelExecution;
    const dispatch = currentReviewDispatch(state);
    const binding = dispatch?.payload.reviewBinding;
    const reviewer = state.workers.find((worker) => worker.workerId === reviewerWorkerId);
    if (
      !isParallelExecution(execution) ||
      state.localExecution?.git === undefined ||
      state.phase !== 'review' ||
      state.nextRole !== 'REVIEWER' ||
      dispatch?.payload.kind !== 'parallel_review_dispatch' ||
      !equal(dispatch.payload.workerIds, [reviewerWorkerId]) ||
      reviewerWorkerId !== `worker:${dispatch.msgId}:0` ||
      reviewer?.role !== 'REVIEWER' ||
      !['pending', 'running', 'paused'].includes(reviewer.status) ||
      !isReviewBinding(binding) ||
      binding.planId !== execution.planId ||
      binding.controlFingerprint !== controlFingerprint(state)
    )
      throw Error('local_git_review_binding_changed');
    const receipt = validationReceipt(state, binding.validationReceiptId);
    const receiptIndex = state.messages.findIndex(
      (message) => message.msgId === binding.validationReceiptId,
    );
    const dispatchIndex = state.messages.indexOf(dispatch);
    const rootCause = dispatch.payload.reason === 'repeated_test_failures';
    const { workspaceVersion, ...results } = state.testResults ?? {};
    if (
      receiptIndex < 0 ||
      receiptIndex >= dispatchIndex ||
      receipt.planId !== binding.planId ||
      receipt.worktree.headCommit !== binding.commit ||
      receipt.controlFingerprint !== binding.controlFingerprint ||
      !equal(results, receipt.results) ||
      (rootCause
        ? receipt.results.passed ||
          execution.activeWave?.validation?.receiptId !== binding.validationReceiptId ||
          execution.activeWave.waveId !== receipt.waveId ||
          execution.activeWave.attempt !== receipt.attempt ||
          execution.activeWave.validation.integrationId !== receipt.integrationId
        : !receipt.results.passed ||
          execution.activeWave !== undefined ||
          execution.acceptedReceiptId !== binding.validationReceiptId ||
          adoptedExecutionPlan(state).subtasks.some(
            (node) => state.subtasks.find((subtask) => subtask.id === node.id)?.status !== 'done',
          ))
    )
      throw Error('local_git_review_binding_changed');
    const version = await this.verifyReceiptHead(state, binding.validationReceiptId);
    if (
      !equal(version, workspaceVersion) ||
      version.kind !== 'git' ||
      version.commit !== binding.commit
    )
      throw Error('local_git_review_binding_changed');
    if (!equal(await this.load(), state)) throw Error('local_git_review_binding_changed');
    return version;
  }
}
