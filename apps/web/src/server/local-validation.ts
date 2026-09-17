/** Trusted direct-workspace verification. Callers serialize these operations
 * with task control commits and commit only the returned canonical mutations. */
import { createHash } from 'node:crypto';
import {
  type AppState,
  activeRequirements,
  appendMutation,
  applyMutations,
  canonicalCompletionDecisionIds,
  canonicalJson,
  currentApprovedReviewId,
  currentLocalCompletionEvidence,
  deriveCompletionResolution,
  isLocalValidationReceipt,
  type LocalReviewBinding,
  type LocalValidationReceipt,
  localValidationReceipt,
  type Mutation,
  setMutation,
} from '@agora/core-domain';
import type {
  WorkspaceArchivePort,
  WorkspaceValidationEvidencePort,
  WorkspaceWorkerSession,
} from '@agora/runtime-sandbox';
import { localValidationCommand, parseLocalValidationResult } from './local-validation-command';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const dispatch = (state: AppState) =>
  [...state.messages]
    .reverse()
    .find(
      (m) =>
        m.channelId === 'main' &&
        m.fromRole === 'COORDINATOR' &&
        m.type === 'announce' &&
        m.payload.nextRole === 'TESTER',
    );
export function localControlFingerprint(state: AppState): string {
  const completion = canonicalCompletionDecisionIds(state);
  const inactive = new Set(
    state.decisionLedger.flatMap((d) => [
      ...(d.supersedes ? [d.supersedes] : []),
      ...(d.objectionResolution?.outcome === 'accepted' &&
      d.objectionResolution.target?.kind === 'decision'
        ? [d.objectionResolution.target.id]
        : []),
    ]),
  );
  return hash({
    goal: state.goal,
    requirements: activeRequirements(state)
      .map((r) => ({
        ...r,
        acceptance: [...r.acceptance].sort(),
        nonGoals: [...r.nonGoals].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    decisions: state.decisionLedger
      .filter((d) => !inactive.has(d.id) && !completion.has(d.id))
      .map(({ ts: _ts, ...d }) => d)
      .sort((a, b) => a.id.localeCompare(b.id)),
    architecture: state.architecture,
    conventions: state.conventions,
    subtasks: state.subtasks
      .map(({ id, title, ownerRole, dependsOn }) => ({
        id,
        title,
        ownerRole,
        dependsOn: [...dependsOn].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export class LocalValidationService {
  constructor(
    private readonly evidence: WorkspaceValidationEvidencePort,
    private readonly load: () => Promise<AppState>,
  ) {}
  private assertIdleSource(state: AppState, sourceWorkspaceId: string) {
    const source = state.localExecution?.workspaces.find(
      (w) => w.workspaceId === sourceWorkspaceId,
    );
    if (
      source?.purpose !== 'coding' ||
      source.mode !== 'direct' ||
      state.workers.some(
        (worker) =>
          worker.role === 'CODER' && ['pending', 'running', 'paused'].includes(worker.status),
      )
    )
      throw Error('local_validation_source_not_ready');
    return source;
  }
  async complete(
    state: AppState,
    workerId: string,
    sourceWorkspaceId: string,
    session: WorkspaceWorkerSession,
  ): Promise<readonly Mutation[]> {
    const source = this.assertIdleSource(state, sourceWorkspaceId);
    const currentDispatch = dispatch(state);
    const worker = state.workers.find((w) => w.workerId === workerId);
    const binding = state.localExecution?.bindings.find((b) => b.workerId === workerId);
    if (
      !currentDispatch ||
      state.phase !== 'testing' ||
      worker?.role !== 'TESTER' ||
      worker.status !== 'running' ||
      session.workspace.workspaceId !== binding?.workspaceId ||
      session.workspace.purpose !== 'validation' ||
      source.rootId !== session.workspace.rootId ||
      source.grantId !== session.workspace.grantId
    )
      throw Error('local_validation_assignment_mismatch');
    const receiptId = `workspace-validation:${currentDispatch.msgId}`;
    if (state.messages.some((m) => m.msgId === receiptId)) {
      await this.verify(state, receiptId);
      return [];
    }
    const fingerprint = localControlFingerprint(state);
    const identity = {
      projectId: state.projectId,
      taskId: state.taskId,
      dispatchId: currentDispatch.msgId,
      workerId,
    };
    const inspection = await session.tools.inspect(
      `tool:${hash({ ...identity, kind: 'validation-inspection' })}`,
    );
    const request = localValidationCommand(inspection);
    const actionId = `tool:${hash({ ...identity, fingerprint, version: inspection.version, kind: 'validation-command' })}`;
    const run = await session.tools.run(actionId, request);
    const evidence = await this.evidence.verifyCommand(
      { ...identity, workspaceId: session.workspace.workspaceId },
      run.receiptId,
    );
    if (
      !equal(evidence.command, run) ||
      !equal(evidence.request, request) ||
      run.workerId !== workerId
    )
      throw Error('local_validation_execution_changed');
    const results = parseLocalValidationResult(evidence.command);
    const receipt: LocalValidationReceipt = {
      kind: 'workspace_validation',
      version: 1,
      ...identity,
      sourceWorkspaceId,
      validationWorkspaceId: session.workspace.workspaceId,
      workspaceVersion: inspection.version,
      controlFingerprint: fingerprint,
      toolchainHash: evidence.toolchainHash,
      policyHash: run.policyHash,
      dependenciesHash: evidence.dependenciesHash,
      commandReceiptId: run.receiptId,
      commandInputHash: run.inputHash,
      testPaths: request.argv.slice(2).map((path) => path.slice('@input/'.length)),
      results: { ...results, workspaceVersion: inspection.version },
      execution: { exitCode: run.exitCode as number, timedOut: false, quiescent: true },
    };
    if (!isLocalValidationReceipt(receipt)) throw Error('invalid_trusted_local_validation');
    const latest = await this.load();
    if (
      latest.projectId !== state.projectId ||
      latest.taskId !== state.taskId ||
      latest.phase !== 'testing' ||
      dispatch(latest)?.msgId !== currentDispatch.msgId ||
      localControlFingerprint(latest) !== fingerprint ||
      !equal(latest.localExecution, state.localExecution)
    )
      throw Error('local_validation_control_changed');
    const mutations: Mutation[] = [
      appendMutation('messages', {
        msgId: receiptId,
        channelId: 'main',
        fromRole: 'COORDINATOR',
        type: 'announce',
        payload: { ...receipt },
        display: `Fixed input validation: ${results.total - results.failed}/${results.total} passed`,
        ts: Math.max(Date.now(), currentDispatch.ts + 1),
      }),
      setMutation('testResults', receipt.results),
    ];
    await this.verify(applyMutations(latest, mutations), receiptId);
    return mutations;
  }
  async verify(state: AppState, receiptId: string): Promise<LocalValidationReceipt> {
    const receipt = localValidationReceipt(state, receiptId);
    this.assertIdleSource(state, receipt.sourceWorkspaceId);
    if (
      localControlFingerprint(state) !== receipt.controlFingerprint ||
      dispatch(state)?.msgId !== receipt.dispatchId
    )
      throw Error('local_validation_control_changed');
    const source = await this.evidence.verifyCurrentVersion(
      { projectId: state.projectId, taskId: state.taskId, workspaceId: receipt.sourceWorkspaceId },
      receipt.workspaceVersion,
    );
    const observed = await this.evidence.verifyCommand(
      {
        projectId: state.projectId,
        taskId: state.taskId,
        workspaceId: receipt.validationWorkspaceId,
      },
      receipt.commandReceiptId,
    );
    const expected = localValidationCommand(source.inspection);
    const command = observed.command;
    if (
      !equal(observed.request, expected) ||
      !equal(
        expected.argv.slice(2).map((p) => p.slice(7)),
        receipt.testPaths,
      ) ||
      command.workerId !== receipt.workerId ||
      command.inputHash !== receipt.commandInputHash ||
      command.policyHash !== receipt.policyHash ||
      observed.toolchainHash !== receipt.toolchainHash ||
      source.toolchainHash !== receipt.toolchainHash ||
      observed.dependenciesHash !== receipt.dependenciesHash ||
      !equal(command.inputVersion, receipt.workspaceVersion) ||
      !equal(parseLocalValidationResult(command), receipt.results) ||
      command.exitCode !== receipt.execution.exitCode
    )
      throw Error('local_validation_execution_changed');
    return receipt;
  }
  async reviewBinding(state: AppState, receiptId: string): Promise<LocalReviewBinding> {
    const receipt = await this.verify(state, receiptId);
    if (!receipt.results.passed || !equal(state.testResults, receipt.results))
      throw Error('local_review_requires_passing_validation');
    return {
      kind: 'workspace_review',
      version: 1,
      validationReceiptId: receiptId,
      sourceWorkspaceId: receipt.sourceWorkspaceId,
      workspaceVersion: receipt.workspaceVersion,
      controlFingerprint: receipt.controlFingerprint,
    };
  }
  async verifyCompletion(state: AppState) {
    const binding = currentLocalCompletionEvidence(state);
    if (!equal(await this.reviewBinding(state, binding.validationReceiptId), binding))
      throw Error('local_completion_evidence_changed');
    return binding;
  }
  async archive(state: AppState, archive: WorkspaceArchivePort) {
    const scope = { projectId: state.projectId, taskId: state.taskId };
    await archive.recoverCompletion(scope);
    state = await this.load();
    if (state.projectId !== scope.projectId || state.taskId !== scope.taskId)
      throw Error('workspace_task_scope_mismatch');
    const approval = deriveCompletionResolution(state, currentApprovedReviewId(state));
    if (state.phase !== 'done' || approval?.option !== 'approve_completion' || !approval.resumed)
      throw Error('local_archive_requires_resumed_approval');
    const binding = await this.verifyCompletion(state);
    const artifact = await archive.archiveCompletion({
      projectId: state.projectId,
      taskId: state.taskId,
    });
    if (
      !equal(artifact.workspaceVersion, binding.workspaceVersion) ||
      artifact.sourceWorkspaceId !== binding.sourceWorkspaceId ||
      artifact.validationReceiptId !== binding.validationReceiptId ||
      artifact.approvalActionId !== approval.actionId
    )
      throw Error('local_artifact_conflict');
    const latest = await this.load();
    if (latest.phase !== 'done' || !equal(await this.verifyCompletion(latest), binding))
      throw Error('local_completion_evidence_changed');
    await archive.releaseCompleted({ projectId: state.projectId, taskId: state.taskId });
    return artifact;
  }
}
