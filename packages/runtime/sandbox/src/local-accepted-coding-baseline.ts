/** Read a coding wave from its canonical validation source, including failed tests.
 * Source provenance does not advance accepted progress. */
import { isWorktreeRef, readCodingWorkerLineage, validationReceipt } from '@agora/core-domain';
import type { LocalBindingRequest } from './local-binding-coordinator';
import { withLocalGitSession } from './local-git-session';
import { LocalGitVersionStore } from './local-git-version-store';
import type { LocalCodingBaselineOptions, LocalGitBatchRequest } from './local-git-workspaces';
import {
  readOwnedLocalGitWorktree,
  verifyLocalGitFiles,
  verifyOwnedLocalGitWorktree,
} from './local-git-worktree';
import { verifyLocalLinkedRoot } from './local-linked-root';
import { isLocalBindingOperation, localRecordHash } from './local-registry-records';

const fail = (): never => {
  throw Error('coding_baseline_proof_mismatch');
};
const same = (a: unknown, b: unknown) => localRecordHash(a) === localRecordHash(b);

export async function readAcceptedCodingBaseline(
  options: LocalCodingBaselineOptions,
  input: { projectId: string; taskId: string; workerId: string },
) {
  localRecordHash(input);
  if (
    Object.keys(input).sort().join(',') !== 'projectId,taskId,workerId' ||
    !Object.values(input).every((v) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))
  )
    fail();
  const scope = structuredClone(input);
  const { control, objects, versions, verifyGrant, verifyAcceptedVersion } = options;
  if (!verifyAcceptedVersion) throw Error('local_git_validation_verifier_required');
  const gitOptions = structuredClone(options.gitOptions);
  const state = await control.assertClosed(scope);
  const snapshot = await control.snapshot();
  const lineage = readCodingWorkerLineage(state);
  if (!lineage.sourceReceiptId) return fail();
  const accepted = validationReceipt(state, lineage.sourceReceiptId);
  const local = state.localExecution;
  const assignment = lineage.assignments.find((a) => a.workerId === scope.workerId);
  const worker = state.workers.find((entry) => entry.workerId === scope.workerId);
  const subtask = state.subtasks.find((entry) => entry.id === assignment?.subtaskId);
  const binding = local?.bindings.find((b) => b.workerId === scope.workerId);
  const workspace = local?.workspaces.find((w) => w.workspaceId === binding?.workspaceId);
  const sourceBinding = local?.bindings.find((b) => b.workerId === accepted.workerId);
  const source = local?.workspaces.find((w) => w.workspaceId === sourceBinding?.workspaceId);
  const sourceRecord = snapshot.linkedRoots?.find((r) => r.workspaceId === source?.workspaceId);
  const childRecord = snapshot.linkedRoots?.find((r) => r.workspaceId === workspace?.workspaceId);
  const sourceMapping = local?.git?.worktrees.find((m) => m.workspaceId === source?.workspaceId);
  const childMapping = local?.git?.worktrees.find((m) => m.workspaceId === workspace?.workspaceId);
  const root = snapshot.roots.find((r) => r.rootId === source?.rootId);
  const grant = snapshot.grants.find((g) => g.grantId === source?.grantId);
  if (
    !local?.git ||
    !assignment ||
    !worker ||
    !['pending', 'done'].includes(worker.status) ||
    (worker.status === 'pending' && worker.worktree !== undefined) ||
    (worker.status === 'done' &&
      (!isWorktreeRef(worker.worktree) ||
        !isWorktreeRef(subtask?.worktree) ||
        !same(worker.worktree, subtask.worktree))) ||
    !binding ||
    binding.subtaskId !== assignment.subtaskId ||
    workspace?.mode !== 'linked-worktree' ||
    workspace.purpose !== 'coding' ||
    source?.mode !== 'linked-worktree' ||
    source.purpose !== 'validation' ||
    state.workers.find((w) => w.workerId === accepted.workerId)?.status !== 'done' ||
    sourceBinding?.receiptId !== sourceMapping?.receiptId ||
    sourceRecord?.bindingReceiptId !== sourceMapping?.receiptId ||
    sourceRecord?.path !== accepted.worktree.path ||
    sourceMapping?.path !== accepted.worktree.path ||
    source.branch !== accepted.worktree.branch ||
    accepted.worktree.headCommit !== lineage.base.commit ||
    childRecord?.path !== childMapping?.path ||
    childRecord?.bindingReceiptId !== binding.receiptId ||
    childMapping?.receiptId !== binding.receiptId ||
    workspace.baseCommit !== lineage.base.commit ||
    workspace.commonDirId !== source.commonDirId ||
    workspace.rootId !== source.rootId ||
    workspace.grantId !== source.grantId ||
    !root ||
    !grant ||
    root.projectId !== scope.projectId ||
    grant.projectId !== scope.projectId
  )
    return fail();
  const childHead =
    worker.status === 'done' && isWorktreeRef(worker.worktree)
      ? (worker.worktree.headCommit ?? worker.worktree.baseCommit)
      : lineage.base.commit;
  if (
    worker.status === 'done' &&
    (!isWorktreeRef(worker.worktree) ||
      worker.worktree.path !== childRecord.path ||
      worker.worktree.branch !== workspace.branch ||
      worker.worktree.baseCommit !== lineage.base.commit)
  )
    return fail();
  const receipt = local.receipts.find((r) => r.receiptId === binding.receiptId);
  const operation = snapshot.operations.find((o) => o.actionId === receipt?.actionId);
  const key = localRecordHash({
    kind: 'coding-git-batch',
    projectId: scope.projectId,
    taskId: scope.taskId,
    actionId: operation?.actionId,
  });
  const inputHash = await objects.getReference(key);
  const bindingHash = await objects.getReference(localRecordHash({ key, stage: 'binding' }));
  if (
    !operation ||
    !isLocalBindingOperation(operation) ||
    operation.stage !== 'committed' ||
    !inputHash ||
    !bindingHash ||
    operation.inputHash !== bindingHash
  )
    return fail();
  const prepared = (await objects.get(bindingHash)) as LocalBindingRequest;
  const saved = (await objects.get(inputHash)) as {
    request: LocalGitBatchRequest;
    gitOptions: typeof gitOptions;
  };
  const request = saved.request;
  if (
    !request ||
    !same(saved.gitOptions, gitOptions) ||
    !prepared.nextLocalExecution ||
    !prepared.records ||
    request.projectId !== scope.projectId ||
    request.taskId !== scope.taskId ||
    request.actionId !== operation.actionId ||
    request.rootId !== root.rootId ||
    request.grantId !== grant.grantId ||
    !('waveId' in request) ||
    request.waveId !== lineage.waveId ||
    request.attempt !== lineage.attempt ||
    request.sourceWorkspaceId !== source.workspaceId ||
    request.version.kind !== 'git' ||
    request.version.commit !== lineage.base.commit ||
    !request.targets.some(
      (t) =>
        t.purpose === 'coding' &&
        t.workerId === scope.workerId &&
        t.workspaceId === workspace.workspaceId,
    ) ||
    prepared.actionId !== operation.actionId ||
    prepared.expectedRevision !== request.expectedRevision ||
    operation.preparedRevision !== request.expectedRevision + 1 ||
    !same(receipt, {
      receiptId: operation.receiptId,
      actionId: operation.actionId,
      inputHash: bindingHash,
      registryRevision: operation.preparedRevision,
    }) ||
    !same(
      prepared.nextLocalExecution.bindings.find((b) => b.workerId === scope.workerId),
      binding,
    ) ||
    !same(
      prepared.records.workspaces.find((w) => w.workspaceId === workspace.workspaceId),
      workspace,
    ) ||
    !same(
      prepared.records.linkedRoots?.find((r) => r.workspaceId === workspace.workspaceId),
      childRecord,
    )
  )
    return fail();
  const authorize = async () => {
    await verifyGrant(scope, grant.grantId);
    if (
      (await control.snapshot()).revision !== snapshot.revision ||
      !same(await control.assertClosed(scope), state)
    )
      fail();
    return true;
  };
  await authorize();
  // The private command proof can enter Git's session queue; keep it outside
  // LocalGitVersionStore.verify's authorization callback.
  await verifyAcceptedVersion(
    structuredClone(state),
    structuredClone(accepted),
    structuredClone(request.version),
  );
  const versionScope = {
    projectId: scope.projectId,
    taskId: scope.taskId,
    rootId: root.rootId,
    policyHash: grant.policyHash,
  };
  const current = {
    ...gitOptions,
    projectId: scope.projectId,
    taskId: scope.taskId,
    root: root.path,
    sourceRoot: root,
    workspace: source,
    record: sourceRecord,
    expectedHead: lineage.base.commit,
    actionId: sourceRecord.initialization.actionId,
    creationActionId: sourceRecord.creation.actionId,
    bindingReceiptId: sourceRecord.bindingReceiptId,
    authorize,
  };
  await new LocalGitVersionStore(objects, versions).verify(request.version, versionScope, current);
  await verifyLocalLinkedRoot({
    ...current,
    workspace,
    record: childRecord,
    expectedHead: childHead,
    actionId: childRecord.initialization.actionId,
    creationActionId: childRecord.creation.actionId,
    bindingReceiptId: childRecord.bindingReceiptId,
  });
  const manifest = await versions.read(request.version, versionScope);
  const files = await Promise.all(
    manifest.files.map(async (file) => ({
      path: file.path,
      content: await objects.getBytes(file.contentHash),
      executable: file.version.executable,
    })),
  );
  await withLocalGitSession(
    { ...current, actionId: childRecord.creation.actionId },
    async (session) => {
      const creation = readOwnedLocalGitWorktree(session, {
        projectId: scope.projectId,
        taskId: scope.taskId,
        workspaceId: workspace.workspaceId,
        creationActionId: childRecord.creation.actionId,
        gitHash: gitOptions.git.sha256,
      });
      if (
        childRecord.creation.receiptHash !== localRecordHash(creation) ||
        creation.baseCommit !== lineage.base.commit
      )
        fail();
      await verifyOwnedLocalGitWorktree(session, creation, childHead);
      // A completed CODER has legitimately changed its tree. The integration source
      // reader independently verifies its immutable completion and full file manifest.
      if (worker.status === 'pending') {
        verifyLocalGitFiles(
          session,
          childRecord.path,
          files,
          childRecord.staging.identity,
          manifest.directories.map((directory) => directory.path).filter(Boolean),
        );
      }
      await verifyOwnedLocalGitWorktree(session, creation, childHead);
    },
  );
  await verifyAcceptedVersion(
    structuredClone(state),
    structuredClone(accepted),
    structuredClone(request.version),
  );
  await authorize();
  return structuredClone({
    workerId: scope.workerId,
    lineage,
    baseCommit: lineage.base.commit,
    version: request.version,
    codingVersion: request.version,
    manifest,
    sourceReceiptId: lineage.sourceReceiptId,
    ...(lineage.acceptedReceiptId ? { acceptedReceiptId: lineage.acceptedReceiptId } : {}),
    codingBatch: { inputHash, bindingHash, receipt },
  });
}
