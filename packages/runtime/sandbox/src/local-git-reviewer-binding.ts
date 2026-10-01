/** Trusted control registration for a REVIEWER of an already validated Git tree.
 * It shares the TESTER's physical validation workspace without borrowing its
 * worker binding or opening a writer claim. No model or HTTP input reaches here. */
import {
  type AppState,
  canonicalJson,
  currentReviewDispatch,
  isReviewBinding,
  validationReceipt,
  type WorkspaceRefV1,
  type WorkspaceVersionV1,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import { isLocalBindingOperation } from './local-registry-records';

type Scope = { projectId: string; taskId: string; workerId: string };
type Control = Pick<
  LocalBindingCoordinator,
  'assertClosed' | 'snapshot' | 'commitBinding' | 'recover'
>;
type Options = {
  control: Control;
  /** Must reprove the private command receipt and physical completed worktree. */
  verifyCandidate(state: AppState, workerId: string): Promise<WorkspaceVersionV1>;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
};
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const safe = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

export class LocalGitReviewerBinding {
  constructor(private readonly options: Options) {}

  async register(input: Scope): Promise<WorkspaceRefV1> {
    return this.registerOnce(input, true);
  }

  private async registerOnce(input: Scope, mayRecover: boolean): Promise<WorkspaceRefV1> {
    if (
      Object.keys(input).sort().join(',') !== 'projectId,taskId,workerId' ||
      !Object.values(input).every((value) => typeof value === 'string' && safe(value))
    )
      throw Error('local_git_review_registration_invalid');
    const scope = structuredClone(input);
    const { control } = this.options;
    const snapshot = await control.snapshot();
    const prepared = snapshot.operations.filter((operation) => operation.stage === 'prepared');
    if (prepared.length) {
      const match = /^worker:(.+):0$/.exec(scope.workerId);
      const actionId = match ? `review-binding:${match[1]}` : '';
      const operation = prepared[0];
      const binding =
        operation && isLocalBindingOperation(operation) && operation.nextLocalExecution
          ? operation.nextLocalExecution.bindings.filter(
              (entry) => entry.workerId === scope.workerId,
            )
          : [];
      const workspace =
        operation && isLocalBindingOperation(operation) && operation.nextLocalExecution
          ? operation.nextLocalExecution.workspaces.find(
              (entry) => entry.workspaceId === binding[0]?.workspaceId,
            )
          : undefined;
      if (
        !mayRecover ||
        prepared.length !== 1 ||
        !operation ||
        !isLocalBindingOperation(operation) ||
        !operation.nextLocalExecution ||
        !safe(actionId) ||
        actionId.length > 120 ||
        operation.actionId !== actionId ||
        operation.receiptId !== `binding:${actionId}` ||
        operation.projectId !== scope.projectId ||
        operation.taskId !== scope.taskId ||
        binding.length !== 1 ||
        binding[0]?.subtaskId !== undefined ||
        binding[0]?.receiptId !== operation.receiptId ||
        workspace?.mode !== 'linked-worktree' ||
        workspace.purpose !== 'validation' ||
        snapshot.claims.some(
          (claim) =>
            claim.projectId === scope.projectId &&
            claim.taskId === scope.taskId &&
            claim.workerId === scope.workerId &&
            claim.status === 'active',
        )
      )
        throw Error('review_binding_recovery_required');
      const recovered = await control.recover(operation.actionId, operation.inputHash);
      if (recovered.stage !== 'committed') throw Error('review_binding_recovery_required');
      return this.registerOnce(scope, false);
    }
    const state = await control.assertClosed(scope);
    const dispatch = currentReviewDispatch(state);
    const reviewBinding = dispatch?.payload.reviewBinding;
    const reviewer = state.workers.find((worker) => worker.workerId === scope.workerId);
    const existing = state.localExecution?.bindings.find(
      (binding) => binding.workerId === scope.workerId,
    );
    if (
      !dispatch ||
      !isReviewBinding(reviewBinding) ||
      !same(dispatch.payload.workerIds, [scope.workerId]) ||
      scope.workerId !== `worker:${dispatch.msgId}:0` ||
      reviewer?.role !== 'REVIEWER' ||
      (reviewer.status !== 'pending' && !(existing && reviewer.status === 'paused')) ||
      reviewer.subtaskId !== undefined ||
      state.phase !== 'review' ||
      state.nextRole !== 'REVIEWER' ||
      state.projectId !== scope.projectId ||
      state.taskId !== scope.taskId
    )
      throw Error('local_git_review_registration_invalid');
    const actionId = `review-binding:${dispatch.msgId}`;
    if (!safe(actionId) || actionId.length > 120)
      throw Error('local_git_review_registration_invalid');
    const receipt = validationReceipt(state, reviewBinding.validationReceiptId);
    const local = state.localExecution;
    const sourceBinding = local?.bindings.find((binding) => binding.workerId === receipt.workerId);
    const workspace = local?.workspaces.find(
      (candidate) => candidate.workspaceId === sourceBinding?.workspaceId,
    );
    const mapping = local?.git?.worktrees.find(
      (candidate) => candidate.workspaceId === workspace?.workspaceId,
    );
    const physical = snapshot.linkedRoots?.find(
      (candidate) => candidate.workspaceId === workspace?.workspaceId,
    );
    const grant = snapshot.grants.find(
      (candidate) =>
        candidate.grantId === workspace?.grantId && candidate.projectId === scope.projectId,
    );
    const source = state.workers.find((worker) => worker.workerId === receipt.workerId);
    const original = snapshot.operations.find(
      (operation) => operation.receiptId === sourceBinding?.receiptId,
    );
    if (
      source?.role !== 'TESTER' ||
      source.status !== 'done' ||
      !same(source.worktree, receipt.worktree) ||
      workspace?.mode !== 'linked-worktree' ||
      workspace.purpose !== 'validation' ||
      !mapping ||
      !physical ||
      !snapshot.linkedRoots ||
      mapping.path !== receipt.worktree.path ||
      physical.path !== mapping.path ||
      physical.bindingReceiptId !== mapping.receiptId ||
      sourceBinding?.receiptId !== mapping.receiptId ||
      !original ||
      !isLocalBindingOperation(original) ||
      original.stage !== 'committed' ||
      !grant ||
      grant.status !== 'active' ||
      grant.rootId !== workspace.rootId ||
      !grant.actions.includes('read')
    )
      throw Error('local_git_review_source_invalid');
    await this.options.verifyGrant(scope, grant.grantId);
    const version = await this.options.verifyCandidate(state, scope.workerId);
    if (version.kind !== 'git' || version.commit !== receipt.worktree.headCommit)
      throw Error('local_git_review_source_invalid');
    const newReceiptId = `binding:${actionId}`;
    if (existing) {
      const operation = snapshot.operations.find((candidate) => candidate.actionId === actionId);
      if (
        existing.workspaceId !== workspace.workspaceId ||
        existing.receiptId !== newReceiptId ||
        existing.subtaskId !== undefined ||
        !operation ||
        !isLocalBindingOperation(operation) ||
        operation.stage !== 'committed' ||
        operation.receiptId !== newReceiptId
      )
        throw Error('local_git_review_registration_conflict');
      if (
        !same(await control.assertClosed(scope), state) ||
        (await control.snapshot()).revision !== snapshot.revision
      )
        throw Error('local_git_review_registration_changed');
      await this.options.verifyGrant(scope, grant.grantId);
      return structuredClone(workspace);
    }
    if (
      !same(await control.assertClosed(scope), state) ||
      (await control.snapshot()).revision !== snapshot.revision
    )
      throw Error('local_git_review_registration_changed');
    const next = structuredClone(local);
    if (!next) throw Error('local_git_review_registration_invalid');
    next.bindings.push({
      workerId: scope.workerId,
      workspaceId: workspace.workspaceId,
      receiptId: newReceiptId,
    });
    await control.commitBinding({
      projectId: scope.projectId,
      taskId: scope.taskId,
      actionId,
      sourceMessageId: grant.leaderMessageId,
      expectedRevision: snapshot.revision,
      nextLocalExecution: next,
      records: {
        roots: snapshot.roots,
        grants: snapshot.grants,
        workspaces: snapshot.workspaces,
        claims: snapshot.claims,
        linkedRoots: snapshot.linkedRoots,
      },
    });
    const current = await control.assertClosed(scope);
    const bound = current.localExecution?.bindings.find(
      (binding) => binding.workerId === scope.workerId,
    );
    if (
      bound?.workspaceId !== workspace.workspaceId ||
      bound.receiptId !== newReceiptId ||
      !same(await this.options.verifyCandidate(current, scope.workerId), version)
    )
      throw Error('local_git_review_registration_changed');
    await this.options.verifyGrant(scope, grant.grantId);
    return structuredClone(workspace);
  }
}
