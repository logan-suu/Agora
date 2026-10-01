/** Read persisted completion evidence without reopening a worker or committing Git.
 * The integration/validation caller must still prove its own canonical selection. */
import {
  isWorkspaceVersionV1,
  isWorktreeRef,
  type WorkspaceCall,
  type WorktreeRef,
} from '@agora/core-domain';
import type { LocalBindingCoordinator } from './local-binding-coordinator';
import type { LocalControlObjects } from './local-control-objects';
import { type LocalGitCommitReceipt, readLocalGitCommit } from './local-git-commit';
import type { LocalGitWorkspaceOptions } from './local-git-workspaces';
import { verifyLocalLinkedRoot } from './local-linked-root';
import {
  isLocalBindingOperation,
  type LocalClaimRecord,
  localRecordHash,
} from './local-registry-records';
import type { LocalVersionStore } from './local-version-store';

type Scope = { projectId: string; taskId: string; workerId: string };
type Options = {
  control: LocalBindingCoordinator;
  objects: LocalControlObjects;
  versions: LocalVersionStore;
  gitOptions?: LocalGitWorkspaceOptions;
  verifyGrant(scope: Scope, grantId: string): Promise<void>;
  verifyClosure(claim: LocalClaimRecord): Promise<string>;
};
const equal = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);
export async function readCompletedWorktree(input: Scope, options: Options) {
  localRecordHash(input);
  if (
    Object.keys(input).sort().join(',') !== 'projectId,taskId,workerId' ||
    !Object.values(input).every(
      (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
    )
  )
    throw Error('workspace_completion_unavailable');
  const scope = structuredClone(input),
    git = structuredClone(options.gitOptions);
  const { control, objects, versions } = options;
  const state = await control.assertClosed(scope),
    snapshot = await control.snapshot();
  const worker = state.workers.find((w) => w.workerId === scope.workerId);
  const binding = state.localExecution?.bindings.find((b) => b.workerId === scope.workerId);
  const workspace = snapshot.workspaces.find((w) => w.workspaceId === binding?.workspaceId);
  const physical = snapshot.linkedRoots?.find((r) => r.workspaceId === workspace?.workspaceId);
  const mapping = state.localExecution?.git?.worktrees.find(
    (w) => w.workspaceId === workspace?.workspaceId,
  );
  if (
    !git ||
    worker?.status !== 'done' ||
    !worker.sessionId ||
    !isWorktreeRef(worker.worktree) ||
    !worker.worktree.headCommit ||
    !binding ||
    workspace?.mode !== 'linked-worktree' ||
    !physical ||
    !mapping ||
    workspace.projectId !== scope.projectId ||
    workspace.taskId !== scope.taskId ||
    !(
      (worker.role === 'CODER' && workspace.purpose === 'coding') ||
      (worker.role === 'TESTER' && workspace.purpose === 'validation')
    ) ||
    !state.localExecution?.workspaces.some((w) => equal(w, workspace)) ||
    mapping.path !== physical.path ||
    mapping.receiptId !== binding.receiptId ||
    physical.bindingReceiptId !== binding.receiptId ||
    worker.worktree.path !== physical.path ||
    worker.worktree.branch !== workspace.branch ||
    worker.worktree.baseCommit !== workspace.baseCommit
  )
    throw Error('workspace_completion_unavailable');
  const claims = snapshot.claims.filter(
    (c) =>
      c.kind !== 'integration' &&
      c.projectId === scope.projectId &&
      c.taskId === scope.taskId &&
      c.workerId === scope.workerId &&
      c.workspaceId === workspace.workspaceId,
  );
  const claim = claims[0];
  if (
    claims.length !== 1 ||
    !claim ||
    claim.kind === 'integration' ||
    !['active', 'released'].includes(claim.status)
  )
    throw Error('workspace_completion_unavailable');
  const origin = snapshot.operations.find((o) => o.actionId === claim.createdActionId);
  const root = snapshot.roots.find(
    (r) => r.projectId === scope.projectId && r.rootId === workspace.rootId,
  );
  const grant = snapshot.grants.find(
    (g) =>
      g.projectId === scope.projectId &&
      g.grantId === workspace.grantId &&
      g.rootId === workspace.rootId,
  );
  if (
    !origin ||
    !isLocalBindingOperation(origin) ||
    origin.stage !== 'committed' ||
    origin.projectId !== scope.projectId ||
    origin.taskId !== scope.taskId ||
    origin.receiptId !== binding.receiptId ||
    !state.localExecution.receipts.some(
      (r) => r.receiptId === origin.receiptId && r.inputHash === origin.inputHash,
    ) ||
    !root ||
    !grant ||
    grant.status !== 'active' ||
    !grant.actions.includes('read')
  )
    throw Error('workspace_completion_unavailable');
  const check = async () => {
    await options.verifyGrant(scope, grant.grantId);
    const current = await control.assertClosed(scope);
    if (
      (await control.snapshot()).revision !== snapshot.revision ||
      !equal(current.localExecution, state.localExecution) ||
      !equal(current.workers.find((w) => w.workerId === scope.workerId) ?? null, worker)
    )
      throw Error('workspace_completion_changed');
    return true;
  };
  await check();
  const closureReceiptId = await options.verifyClosure(claim);
  if (claim.status === 'released' && claim.closureReceiptId !== closureReceiptId)
    throw Error('workspace_claim_closure_invalid');
  const call: WorkspaceCall = {
    ...scope,
    workspaceId: workspace.workspaceId,
    actionId: `session:${localRecordHash({ identity: localRecordHash(scope), sessionId: worker.sessionId })}`,
    grantRevision: grant.revision,
    writerEpoch: claim.writerEpoch,
  };
  const key = localRecordHash({
    kind: 'worker-git-completion',
    ...call,
    sessionId: worker.sessionId,
  });
  const preparedHash = await objects.getReference(key);
  const completionKey = localRecordHash({ key, stage: 'completed' });
  const completionHash = await objects.getReference(completionKey);
  if (!preparedHash || !completionHash) throw Error('workspace_completion_unavailable');
  const prepared = (await objects.get(preparedHash)) as Record<string, unknown>;
  const { version, worktree: previous, ...fixed } = prepared;
  if (
    !equal(fixed, {
      schemaVersion: 'worker-git-completion-v1',
      ...call,
      sessionId: worker.sessionId,
      sourceReceiptId: origin.receiptId,
      git,
    }) ||
    !isWorkspaceVersionV1(version) ||
    version.kind !== 'files' ||
    !isWorktreeRef(previous) ||
    !equal({ ...previous, headCommit: worker.worktree.headCommit }, worker.worktree)
  )
    throw Error('workspace_completion_invalid');
  const completed = (await objects.get(completionHash)) as {
    inputHash: string;
    receipt: LocalGitCommitReceipt;
    worktree: WorktreeRef;
  };
  if (
    Object.keys(completed).sort().join(',') !== 'inputHash,receipt,worktree' ||
    completed.inputHash !== preparedHash ||
    !equal(completed.worktree, worker.worktree)
  )
    throw Error('workspace_completion_invalid');
  const versionScope = {
    projectId: scope.projectId,
    taskId: scope.taskId,
    rootId: root.rootId,
    policyHash: grant.policyHash,
  };
  const physicalBinding = {
    root: physical.path,
    chain: structuredClone(physical.chain),
    stagingIdentity: physical.staging.identity,
  };
  const linked = {
    ...git,
    projectId: scope.projectId,
    taskId: scope.taskId,
    root: root.path,
    sourceRoot: root,
    workspace,
    record: physical,
    expectedHead: worker.worktree.headCommit,
    actionId: physical.initialization.actionId,
    creationActionId: physical.creation.actionId,
    bindingReceiptId: physical.bindingReceiptId,
    authorize: check,
  };
  await verifyLocalLinkedRoot(linked);
  await versions.verify(version, versionScope, physicalBinding, check);
  const manifest = await versions.read(version, versionScope);
  const files = [];
  for (const file of manifest.files)
    files.push({
      path: file.path,
      content: await objects.getBytes(file.contentHash),
      executable: file.version.executable,
    });
  const receipt = await readLocalGitCommit({
    ...git,
    projectId: scope.projectId,
    taskId: scope.taskId,
    root: root.path,
    actionId: `worker-commit:${key}`,
    workspaceId: workspace.workspaceId,
    creationActionId: physical.creation.actionId,
    expectedHead: previous.headCommit ?? previous.baseCommit,
    stagingIdentity: physical.staging.identity,
    files,
    directories: manifest.directories.map((d) => d.path).filter(Boolean),
    authorize: check,
  });
  if (!equal(receipt, completed.receipt) || receipt.commit !== worker.worktree.headCommit)
    throw Error('workspace_completion_invalid');
  await versions.verify(version, versionScope, physicalBinding, check);
  await verifyLocalLinkedRoot(linked);
  if ((await options.verifyClosure(claim)) !== closureReceiptId)
    throw Error('workspace_claim_closure_invalid');
  await check();
  return {
    ...scope,
    workspaceId: workspace.workspaceId,
    sessionId: worker.sessionId,
    worktree: structuredClone(worker.worktree),
    version,
    sourceReceiptId: origin.receiptId,
    completionReceiptId: `completion:${completionKey}`,
    closureReceiptId,
  };
}
